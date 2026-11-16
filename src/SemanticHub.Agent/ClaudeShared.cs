using System.Text.Json;
using Anthropic.Models.Beta.Messages;

namespace SemanticHub.Agent;

public sealed class ClaudeOptions
{
    public string Model { get; set; } = "claude-opus-5-5";
    /// <summary>Q&amp;A is multi-step tool use; medium keeps it responsive. Opus 5.5's default is medium — set explicitly anyway.</summary>
    public string QaEffort { get; set; } = "medium";
    /// <summary>One-shot design benefits from more thought.</summary>
    public string DesignEffort { get; set; } = "high";
    public int QaMaxTokens { get; set; } = 32_000;
    public int DesignMaxTokens { get; set; } = 64_000;
}

internal static class ClaudeShared
{
    public const string FallbackBeta = "server-side-fallback-2026-07-01";

    public static Effort ParseEffort(string? s) => (s ?? "").ToLowerInvariant() switch
    {
        "low" => Effort.Low,
        "high" => Effort.High,
        "max" => Effort.Max,
        _ => Effort.Medium,
    };

    /// <summary>
    /// Converts a response into the assistant turn we send back. Thinking blocks are echoed unchanged (preserved thinking).
    /// After a mid-output fallback, thinking/tool_use blocks BEFORE the last fallback block are omitted and the fallback
    /// block stays in place.
    /// </summary>
    public static (List<BetaContentBlockParam> Echo, List<BetaToolUseBlock> ToolUses, string Text) ToAssistantTurn(BetaMessage msg)
    {
        int lastFallback = -1;
        for (int i = 0; i < msg.Content.Count; i++)
            if (msg.Content[i].TryPickFallback(out _)) lastFallback = i;

        var echo = new List<BetaContentBlockParam>();
        var toolUses = new List<BetaToolUseBlock>();
        var text = new System.Text.StringBuilder();

        for (int i = 0; i < msg.Content.Count; i++)
        {
            var block = msg.Content[i];
            bool beforeBoundary = i < lastFallback;

            if (block.TryPickText(out var t))
            {
                echo.Add(new BetaTextBlockParam { Text = t.Text });
                if (!beforeBoundary) text.Append(t.Text);
            }
            else if (block.TryPickFallback(out var fb))
            {
                echo.Add(BetaFallbackBlockParam.FromRawUnchecked(fb.RawData));
            }
            else if (beforeBoundary)
            {
                continue; // thinking / tool_use from the declined model
            }
            else if (block.TryPickThinking(out var th))
            {
                echo.Add(new BetaThinkingBlockParam { Thinking = th.Thinking, Signature = th.Signature });
            }
            else if (block.TryPickRedactedThinking(out var rt))
            {
                echo.Add(new BetaRedactedThinkingBlockParam { Data = rt.Data });
            }
            else if (block.TryPickToolUse(out var tu))
            {
                echo.Add(new BetaToolUseBlockParam { ID = tu.ID, Name = tu.Name, Input = tu.Input });
                toolUses.Add(tu);
            }
        }
        return (echo, toolUses, text.ToString());
    }
}
