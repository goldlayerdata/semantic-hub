using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Microsoft.Extensions.Logging;
using SemanticHub.Core;

namespace SemanticHub.Agent;

/// <summary>
/// Designs a dashboard spec with Claude (structured output). Every tile's DAX is then run through the hub gate;
/// failing or empty tiles get one repair round, then are dropped.
/// </summary>
public sealed class ClaudeDashboardDesigner(AnthropicClient client, HubService hub, DashboardService dashboards, ClaudeOptions options, ILogger<ClaudeDashboardDesigner> logger) : IDashboardDesigner
{
    private static readonly Dictionary<string, JsonElement> SpecSchema =
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(AgentPrompts.DesignSchemaJson)!;

    public Task<DashboardSpec> DesignAsync(string modelId, Func<string, Task>? progress = null, CancellationToken ct = default) =>
        DesignValidation.DesignWithRepairAsync(hub, dashboards, modelId, options.Model, CallAsync, progress ?? (_ => Task.CompletedTask),
            ex => logger.LogWarning(ex, "Tile repair round failed; keeping valid tiles only"), ct);

    public Task<DashboardTile> SuggestTileAsync(string modelId, string request, Func<string, Task>? progress = null, CancellationToken ct = default) =>
        DesignValidation.SuggestWithRepairAsync(hub, dashboards, modelId, request, CallAsync, progress ?? (_ => Task.CompletedTask), ct);

    private async Task<string> CallAsync(string system, string userPrompt, CancellationToken ct)
    {
        var p = new MessageCreateParams
        {
            Model = options.Model,
            MaxTokens = options.DesignMaxTokens,
            System = system,
            Messages = [new BetaUserMessageParam { Content = userPrompt }],
            Thinking = new BetaThinkingConfigAdaptive(),
            OutputConfig = new BetaOutputConfig
            {
                Effort = ClaudeShared.ParseEffort(options.DesignEffort),
                Format = new BetaJsonOutputFormat { Schema = SpecSchema },
            },
            Fallbacks = new Default(),
            Betas = [ClaudeShared.FallbackBeta],
        };

        BetaMessage msg;
        try
        {
            // Streamed so a long design doesn't hit HTTP timeouts.
            msg = await client.Beta.Messages.CreateStreaming(p, ct).Aggregate();
        }
        catch (Anthropic.Exceptions.AnthropicUnauthorizedException ex)
        {
            throw new LlmUnavailableException("the Anthropic API key was rejected (invalid x-api-key). Fix ANTHROPIC_API_KEY, or set Llm:Provider to \"local\"", ex);
        }
        if (msg.StopReason == "refusal") throw new HubException("The model declined to design this dashboard.");
        if (msg.StopReason == "max_tokens") throw new HubException("The dashboard design was cut off (output limit).");
        return ClaudeShared.ToAssistantTurn(msg).Text;
    }
}
