using System.Collections.Concurrent;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Microsoft.Extensions.Logging;
using SemanticHub.Core;

namespace SemanticHub.Agent;

/// <summary>Events streamed to the chat UI.</summary>
public sealed record AgentEvent(string Type)
{
    public string? Text { get; init; }
    public string? ToolId { get; init; }
    public string? Tool { get; init; }
    public string? ModelId { get; init; }
    public string? Dax { get; init; }
    public bool? Ok { get; init; }
    public bool? Rejected { get; init; }
    public string? Error { get; init; }
    public int? Rows { get; init; }
    public bool? Truncated { get; init; }
    public long? DurationMs { get; init; }
    public List<QueryColumn>? Columns { get; init; }
    public List<object?[]>? Preview { get; init; }
    public object? Usage { get; init; }
    public string? Stage { get; init; }
    public long? ElapsedMs { get; init; }
}

/// <summary>A query the agent ran successfully; kept so an answer can be pinned by id (the browser never sends DAX).</summary>
public sealed record SessionQuery(string ToolId, string Dax, List<QueryColumn> Columns, DateTimeOffset At);

/// <summary>
/// Wraps the agent's event stream for the UI: adds <c>stage</c> events (understanding → running → reading →
/// answering), remembers successful queries on the session, and sends <c>answer_data</c> for the last one before <c>done</c>.
/// </summary>
public sealed class ChatStream(ChatSession session, Func<object, Task> send)
{
    private readonly System.Diagnostics.Stopwatch _clock = System.Diagnostics.Stopwatch.StartNew();
    private readonly Dictionary<string, string> _daxByTool = [];
    private AgentEvent? _lastOk;
    private string? _lastOkDax;
    private bool _answering;

    public Task StartAsync() => send(new AgentEvent("stage") { Stage = "understanding", Text = "Understanding the question" });

    public async Task EmitAsync(AgentEvent e)
    {
        switch (e.Type)
        {
            case "tool":
                if (e.ToolId is not null && e.Dax is not null) _daxByTool[e.ToolId] = e.Dax;
                _answering = false;
                await send(e);
                await send(new AgentEvent("stage")
                {
                    Stage = e.Tool == "run_dax" ? "running" : "understanding",
                    Text = e.Tool switch { "run_dax" => "Running query", "get_schema" => "Reading the model schema", _ => "Looking up models" },
                    ToolId = e.ToolId,
                });
                return;

            case "tool_result":
                await send(e);
                if (e is { Ok: true, ToolId: { } id, Columns: { } cols } && _daxByTool.TryGetValue(id, out var dax))
                {
                    session.Remember(new SessionQuery(id, dax, cols, DateTimeOffset.Now));
                    _lastOk = e;
                    _lastOkDax = dax;
                }
                await send(new AgentEvent("stage") { Stage = "reading", Text = "Reading the results", ToolId = e.ToolId });
                return;

            case "text":
                if (!_answering)
                {
                    _answering = true;
                    await send(new AgentEvent("stage") { Stage = "answering", Text = "Writing the answer" });
                }
                await send(e);
                return;

            case "done":
                if (_lastOk is not null)
                    await send(new { type = "answer_data", toolId = _lastOk.ToolId, dax = _lastOkDax, columns = _lastOk.Columns, rows = _lastOk.Preview, truncated = _lastOk.Truncated ?? false });
                await send(e with { ElapsedMs = _clock.ElapsedMilliseconds });
                return;

            default:
                await send(e);
                return;
        }
    }
}

public sealed class ChatSession
{
    public required string Id { get; init; }
    public required string ModelId { get; init; }
    private readonly List<SessionQuery> _queries = [];

    /// <summary>The last 10 successful queries of this conversation.</summary>
    public void Remember(SessionQuery q)
    {
        lock (_queries)
        {
            _queries.Add(q);
            if (_queries.Count > 10) _queries.RemoveAt(0);
        }
    }

    public SessionQuery? FindQuery(string toolId)
    {
        lock (_queries) return _queries.LastOrDefault(q => q.ToolId == toolId);
    }
    /// <summary>Conversation for the Claude provider.</summary>
    public List<BetaMessageParam> Messages { get; } = [];
    /// <summary>Conversation for the local provider (system message is rebuilt per request, not stored).</summary>
    public List<Microsoft.Extensions.AI.ChatMessage> LocalMessages { get; } = [];
    public SemaphoreSlim Gate { get; } = new(1, 1);
    public DateTimeOffset LastUsed { get; set; } = DateTimeOffset.Now;
}

public sealed class ChatSessionStore
{
    private readonly ConcurrentDictionary<string, ChatSession> _sessions = new();

    public ChatSession GetOrCreate(string? id, string modelId)
    {
        foreach (var stale in _sessions.Values.Where(s => DateTimeOffset.Now - s.LastUsed > TimeSpan.FromHours(4)))
            _sessions.TryRemove(stale.Id, out _);

        if (id is not null && _sessions.TryGetValue(id, out var s) && s.ModelId == modelId) return s;
        var created = new ChatSession { Id = Guid.NewGuid().ToString("N")[..12], ModelId = modelId };
        _sessions[created.Id] = created;
        return created;
    }

    public ChatSession? Get(string? id) => id is not null && _sessions.TryGetValue(id, out var s) ? s : null;

    public void Remove(string id) => _sessions.TryRemove(id, out _);
}

/// <summary>
/// Locked-down Q&amp;A agent on Claude. Three tools only (see <see cref="AgentTools"/>); every query goes through
/// <see cref="HubService.RunDaxAsync"/> (registry + read-only guard + limits + audit).
/// </summary>
public sealed class ClaudeQaAgent(AnthropicClient client, HubService hub, AgentTools tools, ClaudeOptions options, ILogger<ClaudeQaAgent> logger) : IQaAgent
{
    private static readonly List<BetaToolUnion> Tools = AgentTools.Definitions
        .Select(t => (BetaToolUnion)new BetaTool
        {
            Name = t.Name,
            Description = t.Description,
            InputSchema = new InputSchema(JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(AgentTools.FullSchema(t))!),
            Strict = true,
        })
        .ToList();

    public async Task AskAsync(ChatSession session, string question, string? contextNote, DashboardSpec? dashboard, Func<AgentEvent, Task> emit, CancellationToken ct)
    {
        await session.Gate.WaitAsync(ct);
        int rollbackTo = session.Messages.Count;
        try
        {
            session.LastUsed = DateTimeOffset.Now;
            var model = await hub.GetModelOrThrowAsync(session.ModelId);
            var schema = await hub.GetSchemaAsync(session.ModelId, ct);
            List<BetaTextBlockParam> system =
            [
                new() { Text = AgentPrompts.Qa },
                new() { Text = AgentPrompts.QaContext(model, schema, dashboard), CacheControl = new BetaCacheControlEphemeral() },
            ];
            var audit = new AuditContext("agent", session.Id, question);

            session.Messages.Add(new BetaUserMessageParam { Content = contextNote is null ? question : $"{question}\n\n{contextNote}" });

            int toolCalls = 0, maxCalls = hub.Options.MaxToolCallsPerQuestion;
            long inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0;

            for (int turn = 0; turn < maxCalls + 3; turn++)
            {
                var p = new MessageCreateParams
                {
                    Model = options.Model,
                    MaxTokens = options.QaMaxTokens,
                    System = system,
                    Tools = Tools,
                    Messages = session.Messages.ToList(),
                    Thinking = new BetaThinkingConfigAdaptive { Display = Display.Summarized },
                    OutputConfig = new BetaOutputConfig { Effort = ClaudeShared.ParseEffort(options.QaEffort) },
                    CacheControl = new BetaCacheControlEphemeral(),   // auto-cache the growing conversation
                    Fallbacks = new Default(),
                    Betas = [ClaudeShared.FallbackBeta],
                };

                var agg = new Anthropic.Helpers.BetaMessageContentAggregator();
                await foreach (var ev in client.Beta.Messages.CreateStreaming(p, ct).CollectAsync(agg).WithCancellation(ct))
                {
                    if (ev.TryPickContentBlockDelta(out var d))
                    {
                        if (d.Delta.TryPickText(out var t)) await emit(new AgentEvent("text") { Text = t.Text });
                        else if (d.Delta.TryPickThinking(out var th)) await emit(new AgentEvent("thinking") { Text = th.Thinking });
                    }
                    else if (ev.TryPickContentBlockStart(out var s) && s.ContentBlock.TryPickBetaFallback(out _))
                    {
                        await emit(new AgentEvent("notice") { Text = "Switched to a fallback model for this answer." });
                    }
                }
                var msg = agg.Message();

                inTok += msg.Usage.InputTokens; outTok += msg.Usage.OutputTokens;
                cacheRead += msg.Usage.CacheReadInputTokens ?? 0; cacheWrite += msg.Usage.CacheCreationInputTokens ?? 0;

                if (msg.StopReason == "refusal")
                {
                    session.Messages.RemoveRange(rollbackTo, session.Messages.Count - rollbackTo);
                    await emit(new AgentEvent("error") { Error = "The model declined to answer this question." });
                    return;
                }

                var (echo, toolUses, _) = ClaudeShared.ToAssistantTurn(msg);
                if (echo.Count > 0) session.Messages.Add(new BetaAssistantMessageParam { Content = echo });

                if (msg.StopReason == "max_tokens")
                    await emit(new AgentEvent("notice") { Text = "The answer hit the output limit and may be cut off." });

                if (msg.StopReason != "tool_use" || toolUses.Count == 0) break;

                var results = new List<BetaContentBlockParam>();
                foreach (var tu in toolUses)
                {
                    toolCalls++;
                    if (toolCalls > maxCalls)
                    {
                        results.Add(new BetaToolResultBlockParam { ToolUseID = tu.ID, IsError = true, Content = AgentTools.LimitMessage(maxCalls) });
                        continue;
                    }
                    var args = tu.Input.ToDictionary(kv => kv.Key, kv => kv.Value.ValueKind == JsonValueKind.String ? kv.Value.GetString() : kv.Value.GetRawText());
                    var outcome = await tools.ExecuteAsync(tu.ID, tu.Name, args, audit, emit, ct);
                    results.Add(new BetaToolResultBlockParam { ToolUseID = tu.ID, Content = outcome.Content, IsError = outcome.IsError ? true : null });
                }
                session.Messages.Add(new BetaUserMessageParam { Content = results });
            }

            await emit(new AgentEvent("done")
            {
                Usage = new { provider = "claude", model = options.Model, inputTokens = inTok, outputTokens = outTok, cacheReadTokens = cacheRead, cacheWriteTokens = cacheWrite, toolCalls },
            });
            logger.LogInformation("Q&A {Session}: {Calls} tool calls, in {In} (cache read {CR}), out {Out}", session.Id, toolCalls, inTok, cacheRead, outTok);
        }
        catch (OperationCanceledException)
        {
            session.Messages.RemoveRange(rollbackTo, session.Messages.Count - rollbackTo);
            throw;
        }
        catch (Exception ex)
        {
            // Keep the conversation valid (every tool_use needs its tool_result): drop this question's turns.
            session.Messages.RemoveRange(rollbackTo, session.Messages.Count - rollbackTo);
            logger.LogError(ex, "Q&A failed");
            await emit(new AgentEvent("error")
            {
                Error = ex switch
                {
                    HubException => ex.Message,
                    Anthropic.Exceptions.AnthropicUnauthorizedException => "The Anthropic API key was rejected (invalid x-api-key). Fix ANTHROPIC_API_KEY and restart the app, or switch Llm:Provider to \"local\".",
                    Anthropic.Exceptions.AnthropicRateLimitException => "Rate limited by the Anthropic API. Wait a moment and ask again.",
                    _ => $"Something went wrong: {ex.Message.Split('\n')[0]}",
                },
            });
        }
        finally
        {
            session.Gate.Release();
        }
    }
}
