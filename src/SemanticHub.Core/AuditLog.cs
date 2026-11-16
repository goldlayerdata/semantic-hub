using System.Text.Json;

namespace SemanticHub.Core;

public sealed record AuditEntry
{
    public DateTimeOffset At { get; init; } = DateTimeOffset.Now;
    public required string Source { get; init; }          // agent | dashboard | designer | schema
    public string? ModelId { get; init; }
    public string? ConversationId { get; init; }
    public string? Question { get; init; }
    public string? Dax { get; init; }
    public int? Rows { get; init; }
    public bool? Truncated { get; init; }
    public long? DurationMs { get; init; }
    public bool Rejected { get; init; }
    public string? Error { get; init; }
    public string? Note { get; init; }
}

/// <summary>Append-only JSONL audit log, one file per day.</summary>
public sealed class AuditLog
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string _dir;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public AuditLog(HubOptions options)
    {
        _dir = Path.Combine(options.ResolveDataDirectory(), "audit");
        Directory.CreateDirectory(_dir);
    }

    private string FileFor(DateTimeOffset d) => Path.Combine(_dir, $"audit-{d:yyyy-MM-dd}.jsonl");

    public async Task WriteAsync(AuditEntry entry)
    {
        var line = JsonSerializer.Serialize(entry, Json) + "\n";
        await _lock.WaitAsync();
        try { await File.AppendAllTextAsync(FileFor(entry.At), line); }
        finally { _lock.Release(); }
    }

    public async Task<List<AuditEntry>> ReadRecentAsync(int take)
    {
        var result = new List<AuditEntry>();
        foreach (var file in Directory.GetFiles(_dir, "audit-*.jsonl").OrderDescending())
        {
            var lines = await File.ReadAllLinesAsync(file);
            for (int i = lines.Length - 1; i >= 0 && result.Count < take; i--)
            {
                if (string.IsNullOrWhiteSpace(lines[i])) continue;
                try { result.Add(JsonSerializer.Deserialize<AuditEntry>(lines[i], Json)!); } catch (JsonException) { }
            }
            if (result.Count >= take) break;
        }
        return result;
    }
}
