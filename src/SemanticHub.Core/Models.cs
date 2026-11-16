namespace SemanticHub.Core;

/// <summary>A model the hub has approved. Agent and dashboard tools address models only by <see cref="Id"/>.</summary>
public sealed record HubModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Route { get; init; }          // "desktop" (phase 2: "service")
    public string? SourcePath { get; init; }             // .pbix path when known
    public DateTimeOffset AddedAt { get; init; }
}

/// <summary>A model a connector can see right now (e.g. an open Power BI Desktop file).</summary>
public sealed record DiscoveredModel
{
    public required string Key { get; init; }            // stable key used to match a hub model (pbix path or name)
    public required string Name { get; init; }
    public required string Route { get; init; }
    public required string Endpoint { get; init; }       // e.g. "localhost:64503" — never exposed to the agent
    public string? SourcePath { get; init; }
    public int? ProcessId { get; init; }
}

public sealed record ModelSchema
{
    public DateTimeOffset HarvestedAt { get; init; }
    public List<TableInfo> Tables { get; init; } = [];
    public List<ColumnInfo> Columns { get; init; } = [];
    public List<MeasureInfo> Measures { get; init; } = [];
    public List<RelationshipInfo> Relationships { get; init; } = [];
    /// <summary>Facts measured at harvest: row counts and fact date ranges (helps avoid "last year" when data is historical).</summary>
    public List<string> Profile { get; init; } = [];
}

public sealed record TableInfo(string Name, string? Description, bool IsHidden, string? DataCategory);
public sealed record ColumnInfo(string Table, string Name, string? DataType, string? Description, bool IsHidden, string? DataCategory);
public sealed record MeasureInfo(string Table, string Name, string? Expression, string? DataType, string? FormatString, string? Description, bool IsHidden, string? DisplayFolder);
public sealed record RelationshipInfo(string FromTable, string FromColumn, string FromCardinality, string ToTable, string ToColumn, string ToCardinality, bool IsActive, string? CrossFilter);

public sealed record QueryColumn(string Name, string Type);

public sealed record QueryResult
{
    public List<QueryColumn> Columns { get; init; } = [];
    public List<object?[]> Rows { get; init; } = [];
    public bool Truncated { get; init; }
    public long DurationMs { get; init; }
}

/// <summary>Outcome of a hub-gated DAX run (guard + limits + audit).</summary>
public sealed record DaxRunResult
{
    public bool Ok { get; init; }
    public string? Error { get; init; }
    public bool Rejected { get; init; }                  // blocked by the guard / registry, never reached the engine
    public QueryResult? Result { get; init; }
}

public sealed record ModelHealth(int Measures, int MeasuresWithoutDescription, int VisibleColumns, int ColumnsWithoutDescription, int TablesWithoutDescription)
{
    public static ModelHealth From(ModelSchema s)
    {
        var measures = s.Measures.Where(m => !m.IsHidden).ToList();
        var cols = s.Columns.Where(c => !c.IsHidden).ToList();
        var tables = s.Tables.Where(t => !t.IsHidden).ToList();
        return new(measures.Count,
            measures.Count(m => string.IsNullOrWhiteSpace(m.Description)),
            cols.Count,
            cols.Count(c => string.IsNullOrWhiteSpace(c.Description)),
            tables.Count(t => string.IsNullOrWhiteSpace(t.Description)));
    }
}
