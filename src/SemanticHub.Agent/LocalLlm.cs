using System.ClientModel;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using OpenAI;
using SemanticHub.Core;

namespace SemanticHub.Agent;

/// <summary>
/// Connection to a local OpenAI-compatible server (LM Studio by default). Resolves the model id, builds the
/// <see cref="IChatClient"/>, and turns connection problems into <see cref="LlmUnavailableException"/>.
/// </summary>
public sealed class LocalLlm(LlmOptions options, ILogger<LocalLlm> logger)
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private string? _resolvedModel;

    public string Endpoint => options.LocalEndpoint.TrimEnd('/');

    public sealed record Status(bool Reachable, string? Model, List<string> Available, string? Error, string? Warning = null);

    public async Task<Status> GetStatusAsync(CancellationToken ct = default)
    {
        try
        {
            var models = await ListModelsAsync(ct);
            var pick = !string.IsNullOrWhiteSpace(options.LocalModel) ? options.LocalModel : models.FirstOrDefault();
            if (pick is null) return new(true, null, models, "The server has no chat model available. Load one in LM Studio.");
            return new(true, pick, models, null, await ContextWarningAsync(pick, ct));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return new(false, null, [], $"Can't reach {Endpoint}. Start LM Studio's local server (Developer tab → Start Server).");
        }
    }

    /// <summary>LM Studio's native API reports the loaded context length; other servers just don't answer this.</summary>
    private async Task<string?> ContextWarningAsync(string model, CancellationToken ct)
    {
        try
        {
            var root = Endpoint.EndsWith("/v1", StringComparison.Ordinal) ? Endpoint[..^3] : Endpoint;
            using var res = await Http.GetAsync($"{root}/api/v0/models/{model}", ct);
            if (!res.IsSuccessStatusCode) return null;
            var info = await res.Content.ReadFromJsonAsync<JsonElement>(ct);
            if (info.TryGetProperty("state", out var st) && st.GetString() != "loaded")
                return $"{model} is not loaded yet; the first request will load it (LM Studio may pick a small default context). Load it with context length {options.LocalMinContext}.";
            if (info.TryGetProperty("loaded_context_length", out var ctx) && ctx.TryGetInt32(out var n) && n < options.LocalMinContext)
                return $"{model} is loaded with a {n:N0}-token context. Reload it with {options.LocalMinContext:N0} or more, or answers get cut off.";
        }
        catch { /* not LM Studio, or older version */ }
        return null;
    }

    /// <summary>System prompt suffix that switches off Qwen3-style thinking when configured.</summary>
    public string ThinkingSwitch => options.LocalDisableThinking ? "\n\n/no_think" : "";

    private async Task<List<string>> ListModelsAsync(CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{Endpoint}/models");
        req.Headers.Authorization = new("Bearer", options.LocalApiKey);
        using var res = await Http.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();
        var doc = await res.Content.ReadFromJsonAsync<JsonElement>(ct);
        return doc.TryGetProperty("data", out var data)
            ? data.EnumerateArray()
                .Select(m => m.TryGetProperty("id", out var id) ? id.GetString() : null)
                .Where(id => id is not null && !id.Contains("embed", StringComparison.OrdinalIgnoreCase))
                .Select(id => id!)
                .ToList()
            : [];
    }

    public async Task<(IChatClient Client, string Model)> GetClientAsync(CancellationToken ct)
    {
        var model = !string.IsNullOrWhiteSpace(options.LocalModel) ? options.LocalModel : _resolvedModel;
        if (model is null)
        {
            var status = await GetStatusAsync(ct);
            if (!status.Reachable || status.Model is null) throw new LlmUnavailableException(status.Error ?? "No local model available.");
            model = _resolvedModel = status.Model;
            logger.LogInformation("Using local model {Model} at {Endpoint}", model, Endpoint);
        }

        var client = new OpenAIClient(new ApiKeyCredential(options.LocalApiKey), new OpenAIClientOptions
        {
            Endpoint = new Uri(Endpoint),
            NetworkTimeout = TimeSpan.FromSeconds(options.LocalTimeoutSeconds),
        });
        return (client.GetChatClient(model).AsIChatClient(), model);
    }

    public ChatOptions BaseOptions() => new()
    {
        Temperature = options.LocalTemperature,
        MaxOutputTokens = options.LocalMaxOutputTokens,
    };

    /// <summary>The server's own error text (OpenAI-style {"error": {"message": …}} or {"error": "…"}), if the response has one.</summary>
    private static string? ServerError(ClientResultException cre)
    {
        try
        {
            var body = cre.GetRawResponse()?.Content?.ToString();
            if (string.IsNullOrWhiteSpace(body)) return null;
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("error", out var err)) return null;
            var msg = err.ValueKind == JsonValueKind.Object && err.TryGetProperty("message", out var m) ? m.GetString() : err.ValueKind == JsonValueKind.String ? err.GetString() : null;
            return string.IsNullOrWhiteSpace(msg) ? null : (msg.Length > 300 ? msg[..300] + "…" : msg);
        }
        catch { return null; }
    }

    /// <summary>Maps transport/server errors to a message the user can act on.</summary>
    public Exception Translate(Exception ex) => ex switch
    {
        LlmUnavailableException or HubException or OperationCanceledException => ex,
        HttpRequestException => new LlmUnavailableException($"Can't reach the local model server at {Endpoint}. Start LM Studio's server and load a model.", ex),
        ClientResultException { Status: 0 } => new LlmUnavailableException($"Can't reach the local model server at {Endpoint}. Start LM Studio's server and load a model.", ex),
        ClientResultException cre when cre.Message.Contains("context", StringComparison.OrdinalIgnoreCase) =>
            new HubException("The local model's context window is too small for this model's schema. In LM Studio, reload the model with a larger context length (16k or more)."),
        ClientResultException cre when ServerError(cre) is { } detail && (detail.Contains("DeviceLost", StringComparison.OrdinalIgnoreCase) || detail.Contains("vk::", StringComparison.Ordinal)) =>
            new HubException("The graphics driver crashed while running the model (GPU device lost), usually because GPU memory ran out. In LM Studio, reload the model (optionally with a bit less GPU offload) and close other GPU-heavy apps, then try again."),
        ClientResultException cre => new HubException($"The local model server returned an error: {ServerError(cre) ?? cre.Message.Split('\n')[0]}"),
        _ => ex,
    };
}

/// <summary>Separates &lt;think&gt;…&lt;/think&gt; reasoning (emitted inline by some local models) from answer text while streaming.</summary>
public sealed class ThinkTagFilter
{
    private const string Open = "<think>", Close = "</think>";
    private readonly StringBuilder _buffer = new();
    private bool _inThink;

    public (string Visible, string Thought) Push(string chunk)
    {
        _buffer.Append(chunk);
        var visible = new StringBuilder();
        var thought = new StringBuilder();
        while (true)
        {
            var s = _buffer.ToString();
            var tag = _inThink ? Close : Open;
            var i = s.IndexOf(tag, StringComparison.Ordinal);
            if (i >= 0)
            {
                (_inThink ? thought : visible).Append(s, 0, i);
                _buffer.Remove(0, i + tag.Length);
                _inThink = !_inThink;
                continue;
            }
            // Hold back a possible partial tag at the end.
            int hold = 0;
            for (int k = Math.Min(tag.Length - 1, s.Length); k > 0; k--)
                if (tag.StartsWith(s[^k..], StringComparison.Ordinal)) { hold = k; break; }
            (_inThink ? thought : visible).Append(s, 0, s.Length - hold);
            _buffer.Remove(0, s.Length - hold);
            return (visible.ToString(), thought.ToString());
        }
    }

    public (string Visible, string Thought) Flush()
    {
        var rest = _buffer.ToString();
        _buffer.Clear();
        return _inThink ? ("", rest) : (rest, "");
    }

    public static string Strip(string text)
    {
        var f = new ThinkTagFilter();
        var (v, _) = f.Push(text);
        return v + f.Flush().Visible;
    }
}

/// <summary>Q&amp;A agent on a local model. Same tools, same hub gate, same limits as the Claude agent.</summary>
public sealed class LocalQaAgent(LocalLlm llm, HubService hub, AgentTools tools, ILogger<LocalQaAgent> logger) : IQaAgent
{
    private static readonly List<AITool> Tools = AgentTools.Definitions
        .Select(t => (AITool)AIFunctionFactory.CreateDeclaration(t.Name, t.Description, AgentTools.FullSchema(t)))
        .ToList();

    public async Task AskAsync(ChatSession session, string question, string? contextNote, DashboardSpec? dashboard, Func<AgentEvent, Task> emit, CancellationToken ct)
    {
        await session.Gate.WaitAsync(ct);
        int rollbackTo = session.LocalMessages.Count;
        var sw = Stopwatch.StartNew();
        try
        {
            session.LastUsed = DateTimeOffset.Now;
            var (client, modelName) = await llm.GetClientAsync(ct);
            var model = await hub.GetModelOrThrowAsync(session.ModelId);
            var schema = await hub.GetSchemaAsync(session.ModelId, ct);
            var system = new ChatMessage(ChatRole.System,
                AgentPrompts.Qa + AgentPrompts.QaLocalAddendum + "\n\n" + AgentPrompts.QaContext(model, schema, dashboard) + llm.ThinkingSwitch);
            var audit = new AuditContext("agent", session.Id, question);

            session.LocalMessages.Add(new ChatMessage(ChatRole.User, contextNote is null ? question : $"{question}\n\n{contextNote}"));

            var options = llm.BaseOptions();
            options.Tools = Tools;
            options.ToolMode = ChatToolMode.Auto;

            int toolCalls = 0, maxCalls = hub.Options.MaxToolCallsPerQuestion;
            long inTok = 0, outTok = 0;

            for (int turn = 0; turn < maxCalls + 3; turn++)
            {
                // Past the limit, take the tools away so the model has to answer.
                if (toolCalls >= maxCalls) { options.Tools = null; options.ToolMode = ChatToolMode.None; }

                var updates = new List<ChatResponseUpdate>();
                var filter = new ThinkTagFilter();
                await foreach (var u in client.GetStreamingResponseAsync([system, .. session.LocalMessages], options, ct))
                {
                    updates.Add(u);
                    foreach (var c in u.Contents)
                    {
                        if (c is TextReasoningContent r && !string.IsNullOrEmpty(r.Text))
                            await emit(new AgentEvent("thinking") { Text = r.Text });
                    }
                    if (!string.IsNullOrEmpty(u.Text))
                    {
                        var (visible, thought) = filter.Push(u.Text);
                        if (thought.Length > 0) await emit(new AgentEvent("thinking") { Text = thought });
                        if (visible.Length > 0) await emit(new AgentEvent("text") { Text = visible });
                    }
                }
                var (restVisible, _) = filter.Flush();
                if (restVisible.Length > 0) await emit(new AgentEvent("text") { Text = restVisible });

                var response = updates.ToChatResponse();
                inTok += response.Usage?.InputTokenCount ?? 0;
                outTok += response.Usage?.OutputTokenCount ?? 0;
                session.LocalMessages.AddMessages(response);

                var calls = response.Messages.SelectMany(m => m.Contents).OfType<FunctionCallContent>().ToList();
                if (calls.Count == 0)
                {
                    var answered = ThinkTagFilter.Strip(response.Text ?? "").Trim().Length > 0;
                    if (response.FinishReason == ChatFinishReason.Length)
                        await emit(new AgentEvent(answered ? "notice" : "error")
                        {
                            Text = "The answer hit the output limit and may be cut off.",
                            Error = "The model used up its output/context budget before answering. Reload the model in LM Studio with a larger context length, or ask a narrower question.",
                        });
                    else if (!answered)
                        await emit(new AgentEvent("error") { Error = "The model finished without an answer. Try again, or rephrase the question." });
                    break;
                }

                var results = new List<AIContent>();
                foreach (var call in calls)
                {
                    toolCalls++;
                    if (toolCalls > maxCalls)
                    {
                        results.Add(new FunctionResultContent(call.CallId, AgentTools.LimitMessage(maxCalls)));
                        continue;
                    }
                    if (call.Exception is not null)
                    {
                        results.Add(new FunctionResultContent(call.CallId, $"Your tool arguments were not valid JSON: {call.Exception.Message}. Try again."));
                        continue;
                    }
                    var args = (call.Arguments ?? new Dictionary<string, object?>()).ToDictionary(kv => kv.Key, kv => kv.Value switch
                    {
                        JsonElement { ValueKind: JsonValueKind.String } je => je.GetString(),
                        JsonElement je => je.GetRawText(),
                        null => null,
                        var v => v.ToString(),
                    });
                    var outcome = await tools.ExecuteAsync(call.CallId, call.Name, args, audit, emit, ct);
                    results.Add(new FunctionResultContent(call.CallId, outcome.IsError ? "ERROR: " + outcome.Content : outcome.Content));
                }
                session.LocalMessages.Add(new ChatMessage(ChatRole.Tool, results));
            }

            await emit(new AgentEvent("done")
            {
                Usage = new { provider = "local", model = modelName, inputTokens = inTok, outputTokens = outTok, cacheReadTokens = 0, cacheWriteTokens = 0, toolCalls },
            });
            logger.LogInformation("Local Q&A {Session} on {Model}: {Calls} tool calls, {Secs:0.0}s", session.Id, modelName, toolCalls, sw.Elapsed.TotalSeconds);
        }
        catch (OperationCanceledException)
        {
            session.LocalMessages.RemoveRange(rollbackTo, session.LocalMessages.Count - rollbackTo);
            throw;
        }
        catch (Exception raw)
        {
            session.LocalMessages.RemoveRange(rollbackTo, session.LocalMessages.Count - rollbackTo);
            var ex = llm.Translate(raw);
            if (ex == raw) logger.LogError(raw, "Local Q&A failed");
            await emit(new AgentEvent("error")
            {
                Error = ex is HubException or LlmUnavailableException ? ex.Message : $"Something went wrong: {ex.Message.Split('\n')[0]}",
            });
        }
        finally
        {
            session.Gate.Release();
        }
    }
}

/// <summary>Dashboard designer on a local model, using JSON-schema constrained output.</summary>
public sealed class LocalDashboardDesigner(LocalLlm llm, HubService hub, DashboardService dashboards, ILogger<LocalDashboardDesigner> logger) : IDashboardDesigner
{
    private static readonly JsonElement SpecSchema = JsonDocument.Parse(AgentPrompts.DesignSchemaJson).RootElement.Clone();

    public async Task<DashboardSpec> DesignAsync(string modelId, Func<string, Task>? progress = null, CancellationToken ct = default)
    {
        try
        {
            var (client, modelName) = await llm.GetClientAsync(ct);
            return await DesignValidation.DesignWithRepairAsync(hub, dashboards, modelId, $"{modelName} (local)",
                (system, prompt, token) => CallAsync(client, system, prompt, token),
                progress ?? (_ => Task.CompletedTask),
                ex => logger.LogWarning(ex, "Local tile repair round failed; keeping valid tiles only"),
                ct);
        }
        catch (Exception ex) { throw llm.Translate(ex); }
    }

    public async Task<DashboardTile> SuggestTileAsync(string modelId, string request, Func<string, Task>? progress = null, CancellationToken ct = default)
    {
        try
        {
            var (client, _) = await llm.GetClientAsync(ct);
            return await DesignValidation.SuggestWithRepairAsync(hub, dashboards, modelId, request,
                (system, prompt, token) => CallAsync(client, system, prompt, token), progress ?? (_ => Task.CompletedTask), ct);
        }
        catch (Exception ex) { throw llm.Translate(ex); }
    }

    private async Task<string> CallAsync(IChatClient client, string system, string prompt, CancellationToken ct)
    {
        try
        {
            var options = llm.BaseOptions();
            options.MaxOutputTokens = Math.Max(options.MaxOutputTokens ?? 0, 8192);
            options.ResponseFormat = ChatResponseFormat.ForJsonSchema(SpecSchema, "dashboard_spec", "Dashboard spec with tiles");
            var response = await client.GetResponseAsync(
                [new ChatMessage(ChatRole.System, system + llm.ThinkingSwitch), new ChatMessage(ChatRole.User, prompt)], options, ct);
            if (response.FinishReason == ChatFinishReason.Length)
                throw new HubException("The local model ran out of output tokens while designing. Raise Llm:LocalMaxOutputTokens or the model's context length.");
            return ThinkTagFilter.Strip(response.Text);
        }
        catch (Exception ex) { throw llm.Translate(ex); }
    }
}
