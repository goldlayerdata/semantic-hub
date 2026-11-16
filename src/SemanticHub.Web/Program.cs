using System.Text.Json;
using Anthropic;
using SemanticHub.Agent;
using SemanticHub.Connectors;
using SemanticHub.Core;

var builder = WebApplication.CreateBuilder(args);

var hubOptions = builder.Configuration.GetSection("Hub").Get<HubOptions>() ?? new HubOptions();
var claudeOptions = builder.Configuration.GetSection("Claude").Get<ClaudeOptions>() ?? new ClaudeOptions();
var llmOptions = builder.Configuration.GetSection("Llm").Get<LlmOptions>() ?? new LlmOptions();

builder.Services.AddSingleton(hubOptions);
builder.Services.AddSingleton(claudeOptions);
builder.Services.AddSingleton(llmOptions);
builder.Services.AddSingleton<HubStore>();
builder.Services.AddSingleton<AuditLog>();
builder.Services.AddSingleton<IModelConnector, DesktopConnector>();
builder.Services.AddSingleton<HubService>();
builder.Services.AddSingleton<DashboardService>();
builder.Services.AddSingleton<AgentTools>();
builder.Services.AddSingleton<ChatSessionStore>();

// Llm:Provider picks who designs dashboards and answers questions in THIS app: "claude" or "local".
if (llmOptions.IsLocal)
{
    builder.Services.AddSingleton<LocalLlm>();
    builder.Services.AddSingleton<IQaAgent, LocalQaAgent>();
    builder.Services.AddSingleton<IDashboardDesigner, LocalDashboardDesigner>();
}
else
{
    builder.Services.AddSingleton(_ => new AnthropicClient());   // reads ANTHROPIC_API_KEY
    builder.Services.AddSingleton<IQaAgent, ClaudeQaAgent>();
    builder.Services.AddSingleton<IDashboardDesigner, ClaudeDashboardDesigner>();
}

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
bool HasApiKey() => !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY"));

// Is the configured LLM usable right now? (null problem = ready)
async Task<(string Provider, string? Model, string? Problem, string? Warning)> LlmStatusAsync(IServiceProvider sp, CancellationToken ct)
{
    if (llmOptions.IsLocal)
    {
        var s = await sp.GetRequiredService<LocalLlm>().GetStatusAsync(ct);
        return ("local", s.Model, s.Error, s.Warning);
    }
    return ("claude", claudeOptions.Model, HasApiKey() ? null : "ANTHROPIC_API_KEY is not set.", null);
}

// Errors from the hub become readable 4xx responses.
app.Use(async (ctx, next) =>
{
    try { await next(); }
    catch (HubException ex) when (!ctx.Response.HasStarted)
    {
        ctx.Response.StatusCode = ex is HubValidationException ? 400 : ex.Rejected ? 404 : 409;
        await ctx.Response.WriteAsJsonAsync(new { error = ex.Message });
    }
});

var api = app.MapGroup("/api");

api.MapGet("/status", async (IServiceProvider sp, CancellationToken ct) =>
{
    var (provider, model, problem, warning) = await LlmStatusAsync(sp, ct);
    return new
    {
        llm = new { provider, model, ready = problem is null, problem, warning, local = llmOptions.IsLocal, endpoint = llmOptions.IsLocal ? llmOptions.LocalEndpoint : null },
        limits = new { hubOptions.MaxRows, hubOptions.QueryTimeoutSeconds, hubOptions.MaxToolCallsPerQuestion },
        dataDirectory = hubOptions.ResolveDataDirectory(),
    };
});

// ---- hub ----

api.MapGet("/discovered", async (HubService hub, CancellationToken ct) =>
    (await hub.DiscoverViewAsync(ct)).Select(v => new { key = v.Model.Key, name = v.Model.Name, route = v.Model.Route, sourcePath = v.Model.SourcePath, hubId = v.HubId }));

api.MapGet("/models", async (HubService hub, CancellationToken ct) =>
{
    var list = new List<object>();
    foreach (var m in await hub.Store.GetModelsAsync())
    {
        var schema = await hub.Store.GetSchemaAsync(m.Id);
        var dash = await hub.Store.GetDashboardAsync(m.Id);
        list.Add(new
        {
            m.Id, m.Name, m.Route, m.SourcePath, m.AddedAt,
            online = await hub.IsOnlineAsync(m, ct),
            schemaHarvestedAt = schema?.HarvestedAt,
            counts = schema is null ? null : new { tables = schema.Tables.Count(t => !t.IsHidden), columns = schema.Columns.Count(c => !c.IsHidden), measures = schema.Measures.Count(x => !x.IsHidden) },
            health = schema is null ? null : ModelHealth.From(schema),
            hasDashboard = dash is not null,
        });
    }
    return list;
});

api.MapPost("/models", async (ApproveRequest req, HubService hub, CancellationToken ct) => await hub.ApproveAsync(req.Key, ct));

// Same as POST /models, streaming the steps (connect → schema → profile) for the UI.
api.MapPost("/models/approve", async (ApproveRequest req, HttpContext http, HubService hub, CancellationToken ct) =>
{
    var send = StartSse(http);
    try
    {
        var model = await hub.ApproveAsync(req.Key, (step, text) => send(new { type = "progress", step, text }), ct);
        await send(new { type = "done", model });
    }
    catch (OperationCanceledException) { }
    catch (Exception ex)
    {
        if (ex is not HubException) app.Logger.LogError(ex, "Approve failed");
        await send(new { type = "error", error = ex is HubException ? ex.Message : $"Couldn't add the model: {ex.Message}" });
    }
});

api.MapDelete("/models/{id}", async (string id, HubService hub) =>
{
    await hub.GetModelOrThrowAsync(id);
    await hub.Store.RemoveModelAsync(id);
    return Results.NoContent();
});

api.MapGet("/models/{id}", async (string id, HubService hub) => await hub.GetModelOrThrowAsync(id));
api.MapGet("/models/{id}/schema", async (string id, HubService hub, CancellationToken ct) => await hub.GetSchemaAsync(id, ct));
api.MapPost("/models/{id}/schema/refresh", async (string id, HubService hub, CancellationToken ct) => await hub.HarvestSchemaAsync(id, ct));

// ---- dashboard ----
// The browser never sends DAX: it sends filter values (checked against the schema), layout fields, and ids of
// queries the server already holds (pinned answers, previewed tiles). DashboardService composes every query.

api.MapGet("/models/{id}/dashboard", async (string id, DashboardService dashboards, CancellationToken ct) =>
    await dashboards.GetSpecAsync(id, ct) is { } spec ? Results.Ok(spec) : Results.NoContent());

// Server-sent events: progress messages, then the finished spec.
api.MapPost("/models/{id}/dashboard/design", async (string id, HttpContext http, HubService hub, DashboardService dashboards, IDashboardDesigner designer, CancellationToken ct) =>
{
    await hub.GetModelOrThrowAsync(id);
    var send = StartSse(http);
    try
    {
        DashboardSpec? spec = null;
        var (provider, _, problem, _) = await LlmStatusAsync(http.RequestServices, ct);
        string? fallbackReason = problem is null ? null : $"Built-in layout — {provider} model unavailable: {problem} Fix it and click Redesign.";
        if (fallbackReason is null)
        {
            try { spec = await designer.DesignAsync(id, msg => send(new { type = "progress", text = msg }), ct); }
            catch (LlmUnavailableException ex)
            {
                fallbackReason = $"Built-in layout — {ex.Message} Then click Redesign.";
            }
        }
        if (spec is null)
        {
            await send(new { type = "progress", text = "Building the built-in dashboard…" });
            spec = await dashboards.BuildHeuristicAsync(id, fallbackReason!, ct);
        }
        await send(new { type = "done", spec });
    }
    catch (OperationCanceledException) { }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "Dashboard design failed");
        await send(new { type = "error", error = ex is HubException ? ex.Message : $"Design failed: {ex.Message}" });
    }
});

api.MapPost("/models/{id}/dashboard/run", async (string id, FiltersRequest? req, DashboardService dashboards, CancellationToken ct) =>
    await dashboards.RunAllAsync(id, req?.Filters, ct));

api.MapPost("/models/{id}/dashboard/tiles/{tileId}/run", async (string id, string tileId, FiltersRequest? req, DashboardService dashboards, CancellationToken ct) =>
    await dashboards.RunTileAsync(id, tileId, req?.Filters, ct));

api.MapPost("/models/{id}/dashboard/tiles/{tileId}/explain", async (string id, string tileId, FiltersRequest? req, DashboardService dashboards, CancellationToken ct) =>
    await dashboards.ExplainAsync(id, tileId, req?.Filters, ct));

api.MapPost("/models/{id}/dashboard/tiles/{tileId}/export", async (string id, string tileId, FiltersRequest? req, DashboardService dashboards, CancellationToken ct) =>
{
    var (fileName, csv) = await dashboards.ExportCsvAsync(id, tileId, req?.Filters, ct);
    return Results.File(System.Text.Encoding.UTF8.GetPreamble().Concat(System.Text.Encoding.UTF8.GetBytes(csv)).ToArray(), "text/csv; charset=utf-8", fileName);
});

api.MapGet("/models/{id}/filters/columns", async (string id, DashboardService dashboards, CancellationToken ct) =>
    (await dashboards.FilterColumnsAsync(id, ct)).Select(f => new { f.Table, f.Column, f.Label }));

api.MapGet("/models/{id}/filters/values", async (string id, string table, string column, HubService hub, DashboardService dashboards, CancellationToken ct) =>
{
    var (values, truncated) = await dashboards.FilterValuesAsync(id, table, column, ct);
    return new { values, truncated };
});

// Add a tile by request: preview first (kept server-side by id), then add by id.
api.MapPost("/models/{id}/dashboard/tiles/suggest", async (string id, SuggestRequest req, HttpContext http, HubService hub, DashboardService dashboards, IDashboardDesigner designer, CancellationToken ct) =>
{
    await hub.GetModelOrThrowAsync(id);
    var send = StartSse(http);
    try
    {
        var (provider, _, problem, _) = await LlmStatusAsync(http.RequestServices, ct);
        if (problem is not null) throw new HubException($"Adding tiles needs the AI model ({provider}): {problem}");
        var tile = await designer.SuggestTileAsync(id, req.Request, msg => send(new { type = "progress", text = msg }), ct);
        var applied = DaxComposer.BuildFilters(await hub.GetSchemaAsync(id, ct), req.Filters);
        var result = await dashboards.RunTileAsync(id, tile, applied, "designer", ct);
        var suggestionId = dashboards.RememberSuggestion(id, tile);
        await send(new { type = "done", suggestionId, tile, result });
    }
    catch (OperationCanceledException) { }
    catch (Exception ex)
    {
        if (ex is not HubException and not LlmUnavailableException) app.Logger.LogError(ex, "Tile suggestion failed");
        await send(new { type = "error", error = ex is HubException or LlmUnavailableException ? ex.Message : $"Couldn't build the tile: {ex.Message}" });
    }
});

api.MapPost("/models/{id}/dashboard/tiles", async (string id, AddTileRequest req, DashboardService dashboards, CancellationToken ct) =>
    await dashboards.AddSuggestionAsync(id, req.SuggestionId, ct));

// Pin a Q&A answer: the query is looked up in the chat session by tool id, never taken from the browser.
api.MapPost("/models/{id}/dashboard/pin", async (string id, PinRequest req, ChatSessionStore sessions, DashboardService dashboards, CancellationToken ct) =>
{
    var session = sessions.Get(req.ConversationId);
    if (session is null || session.ModelId != id) throw new HubValidationException("That conversation has ended. Ask the question again, then pin the answer.");
    var query = session.FindQuery(req.ToolId) ?? throw new HubValidationException("That query is no longer available to pin. Ask the question again.");
    return await dashboards.PinAsync(id, query.Dax, req.Title, req.Kind ?? "table", req.Format ?? "number", ct);
});

api.MapPut("/models/{id}/dashboard/layout", async (string id, DashboardService.LayoutUpdate req, DashboardService dashboards, CancellationToken ct) =>
    await dashboards.SaveLayoutAsync(id, req, ct));

// ---- chat (SSE) ----

api.MapPost("/chat", async (ChatRequest req, HttpContext http, HubService hub, DashboardService dashboards, IQaAgent agent, ChatSessionStore sessions, CancellationToken ct) =>
{
    await hub.GetModelOrThrowAsync(req.ModelId);
    if (string.IsNullOrWhiteSpace(req.Question)) throw new HubValidationException("Ask a question.");
    if (req.Question.Length > 2000) throw new HubValidationException("Keep questions under 2,000 characters.");
    var filterNote = await dashboards.DescribeFiltersAsync(req.ModelId, req.Filters, ct);   // validates filters (400) before streaming
    var send = StartSse(http);
    var session = sessions.GetOrCreate(req.ConversationId, req.ModelId);
    await send(new { type = "session", conversationId = session.Id });
    var stream = new ChatStream(session, send);
    await stream.StartAsync();

    var (provider, _, problem, warning) = await LlmStatusAsync(http.RequestServices, ct);
    if (warning is not null) await send(new AgentEvent("notice") { Text = warning });
    if (problem is not null)
    {
        await send(new AgentEvent("error") { Error = $"Q&A unavailable ({provider}): {problem}" });
        return;
    }
    var dashboard = await dashboards.GetSpecAsync(req.ModelId, ct);
    try { await agent.AskAsync(session, req.Question.Trim(), filterNote, dashboard, stream.EmitAsync, ct); }
    catch (OperationCanceledException) { }
});

api.MapDelete("/chat/{conversationId}", (string conversationId, ChatSessionStore sessions) =>
{
    sessions.Remove(conversationId);
    return Results.NoContent();
});

// ---- audit ----

api.MapGet("/audit", async (AuditLog audit, int? take) => await audit.ReadRecentAsync(Math.Clamp(take ?? 1000, 1, 5000)));

// Client-side routes (/models/x, /audit) serve the React app.
app.MapFallbackToFile("index.html");

app.Run();

Func<object, Task> StartSse(HttpContext http)
{
    http.Response.Headers.ContentType = "text/event-stream";
    http.Response.Headers.CacheControl = "no-cache";
    http.Response.Headers["X-Accel-Buffering"] = "no";
    var gate = new SemaphoreSlim(1, 1);
    var options = new JsonSerializerOptions(json) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };
    return async payload =>
    {
        await gate.WaitAsync();
        try
        {
            await http.Response.WriteAsync($"data: {JsonSerializer.Serialize(payload, payload.GetType(), options)}\n\n");
            await http.Response.Body.FlushAsync();
        }
        finally { gate.Release(); }
    };
}

record ApproveRequest(string Key);
record ChatRequest(string ModelId, string Question, string? ConversationId, List<FilterValue>? Filters);
record FiltersRequest(List<FilterValue>? Filters);
record SuggestRequest(string Request, List<FilterValue>? Filters);
record AddTileRequest(string SuggestionId);
record PinRequest(string ConversationId, string ToolId, string Title, string? Kind, string? Format);
