using System.Text.Json.Serialization;

namespace SemanticHub.Core;

/// <summary>
/// A dashboard is a spec, not HTML: each tile carries a DAX table expression. <see cref="DaxComposer"/> wraps it with
/// the active filters into a query that runs through the hub gate (guard + limits + audit), so every number on screen
/// comes from a live query.
/// Result convention: KPI = first row, first column is the value, an optional "Compare" column is the comparison.
/// Charts = first column is the category, the remaining numeric columns are series. Tables = all columns.
/// </summary>
public sealed record DashboardSpec
{
    public required string Title { get; init; }
    public string? Subtitle { get; init; }
    public List<DashboardTile> Tiles { get; init; } = [];
    /// <summary>Columns the filter bar offers.</summary>
    public List<FilterDef> Filters { get; init; } = [];
    /// <summary>1 = tiles hold full queries in <see cref="DashboardTile.Dax"/>; 2 = expression + order-by.</summary>
    public int Version { get; init; } = 1;
    /// <summary>Currency symbol of the model's measures (e.g. "$"), set on read for the renderer.</summary>
    public string? Currency { get; init; }
    public DateTimeOffset GeneratedAt { get; init; }
    public string GeneratedBy { get; init; } = "";       // model id or "heuristic"
    public List<string> DroppedTiles { get; init; } = [];
}

public sealed record DashboardTile
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Kind { get; init; }           // kpi | bar | column | line | area | donut | table
    /// <summary>DAX table expression (no EVALUATE / ORDER BY). Null = a "fixed" tile that runs <see cref="Dax"/> unfiltered.</summary>
    public string? Expression { get; init; }
    public string? OrderBy { get; init; }
    /// <summary>Full query: what designers return, v1 tiles, and fixed tiles that can't be split (e.g. DEFINE).</summary>
    public string? Dax { get; init; }
    public string Origin { get; init; } = "designer";    // designer | builtin | pinned | added
    /// <summary>Position on the 24-column dashboard grid; null = placed automatically by the client.</summary>
    public GridLayout? Layout { get; init; }
    public string Format { get; init; } = "number";      // number | integer | currency | percent
    public string Size { get; init; } = "medium";        // small | medium | large | full
    public string? Description { get; init; }

    public bool Filterable => Expression is not null;

    public static readonly string[] Kinds = ["kpi", "bar", "column", "line", "area", "donut", "table"];
    public static readonly string[] Formats = ["number", "integer", "currency", "percent"];
    public static readonly string[] Sizes = ["small", "medium", "large", "full"];
}

public sealed record TileResult
{
    public required string TileId { get; init; }
    public bool Ok { get; init; }
    public string? Error { get; init; }
    public List<QueryColumn> Columns { get; init; } = [];
    public List<object?[]> Rows { get; init; } = [];
    public bool Truncated { get; init; }
    public long DurationMs { get; init; }
    /// <summary>The exact query that ran.</summary>
    public string? Query { get; init; }
    public bool Filtered { get; init; }
}

/// <summary>Tile position in grid units: 24 columns, rows of a fixed height.</summary>
public sealed record GridLayout(int X, int Y, int W, int H)
{
    public const int Columns = 24, MaxY = 1000, MinH = 3, MaxH = 60;

    public string? Problem() =>
        X < 0 || W < 1 || X + W > Columns ? $"Tile width/position must fit in {Columns} columns." :
        Y < 0 || Y > MaxY ? "Tile row is out of range." :
        H < MinH || H > MaxH ? $"Tile height must be {MinH}–{MaxH} rows." : null;

    /// <summary>Closest of the old S/M/L/Full sizes (used by narrow screens and older clients).</summary>
    public string Size => W <= 6 ? "small" : W <= 12 ? "medium" : W <= 18 ? "large" : "full";
}

public sealed record FilterDef(string Table, string Column, string Label);

/// <summary>Sent by the browser: values only. Column names are checked against the schema before any DAX is built.</summary>
public sealed record FilterValue(string Table, string Column, List<System.Text.Json.JsonElement>? Values);

/// <summary>
/// No-LLM fallback: KPI cards for the first measures, a yearly trend, and top-10 breakdowns of the first measure by
/// likely grouping columns of related dimension tables. The caller validates tiles through the hub and drops failures.
/// </summary>
public static class HeuristicDashboard
{
    private static readonly string[] GoodGroupNames = ["category", "brand", "country", "continent", "segment", "type", "channel", "region", "gender", "class", "group", "status"];
    private static readonly string[] BadGroupNames = ["key", "code", "email", "address", "phone", "zip", "postal", "url", "description", "date"];

    public static DashboardSpec Build(HubModel model, ModelSchema schema, string reason)
    {
        var measures = schema.Measures.Where(m => !m.IsHidden).ToList();
        var tiles = measures.Take(4).Select((m, i) => new DashboardTile
        {
            Id = $"kpi-{i + 1}",
            Title = m.Name,
            Kind = "kpi",
            Dax = $"EVALUATE ROW(\"Value\", {SchemaText.MeasureRef(m.Name)})",
            Format = GuessFormat(m),
            Size = "small",
            Description = m.Description,
            Origin = "builtin",
        }).ToList();

        if (measures.FirstOrDefault() is { } primary)
        {
            var mref = SchemaText.MeasureRef(primary.Name);
            var label = primary.Name.Replace("\"", "");
            var visibleCols = schema.Columns.Where(c => !c.IsHidden).ToList();

            // Trend by year, when a date table has a year column.
            var timeTables = schema.Tables.Where(t => t.DataCategory == "Time").Select(t => t.Name).ToHashSet();
            var year = visibleCols.FirstOrDefault(c => timeTables.Contains(c.Table) && c.Name.Equals("Year", StringComparison.OrdinalIgnoreCase))
                       ?? visibleCols.FirstOrDefault(c => timeTables.Contains(c.Table) && c.Name.Contains("Year", StringComparison.OrdinalIgnoreCase) && c.DataType == "Integer");
            if (year is not null)
            {
                var col = $"{SchemaText.TableRef(year.Table)}[{year.Name}]";
                tiles.Add(new DashboardTile
                {
                    Id = "trend-year", Title = $"{primary.Name} by {year.Name}", Kind = "column", Size = "medium", Format = GuessFormat(primary), Origin = "builtin",
                    Dax = $"EVALUATE SUMMARIZECOLUMNS({col}, \"{label}\", {mref}) ORDER BY {col} ASC",
                    Description = $"{primary.Name} for each {year.Name.ToLowerInvariant()} in the data.",
                });
            }

            // Top-10 breakdowns by one grouping column per related dimension table.
            var dims = schema.Relationships
                .Where(r => r.IsActive && r.FromTable == primary.Table && !timeTables.Contains(r.ToTable))
                .Select(r => r.ToTable).Distinct();
            foreach (var dim in dims)
            {
                // Only group by columns whose name says they are a grouping (CategoryName, Country, Brand…); the
                // earlier a keyword is in GoodGroupNames, the better the pick.
                var pick = visibleCols
                    .Where(c => c.Table == dim && c.DataType is "Text" or "String")
                    .Select(c => (Col: c, Rank: Array.FindIndex(GoodGroupNames, g => c.Name.Contains(g, StringComparison.OrdinalIgnoreCase))))
                    .Where(x => x.Rank >= 0 && x.Col.Table == dim && !BadGroupNames.Any(b => x.Col.Name.Contains(b, StringComparison.OrdinalIgnoreCase)))
                    .OrderBy(x => x.Rank)
                    .Select(x => x.Col)
                    .FirstOrDefault();
                if (pick is null) continue;
                var col = $"{SchemaText.TableRef(pick.Table)}[{pick.Name}]";
                tiles.Add(new DashboardTile
                {
                    Id = $"top-{HubStore.Slugify(pick.Table + "-" + pick.Name)}", Title = $"{primary.Name} by {pick.Name}", Kind = "bar", Size = "medium", Format = GuessFormat(primary), Origin = "builtin",
                    Dax = $"EVALUATE TOPN(10, SUMMARIZECOLUMNS({col}, \"{label}\", {mref}), [{label}], DESC) ORDER BY [{label}] DESC",
                    Description = $"Top 10 {pick.Name.ToLowerInvariant()} values by {primary.Name.ToLowerInvariant()}.",
                });
                if (tiles.Count >= 9) break;
            }
        }

        return new DashboardSpec
        {
            Title = model.Name,
            Subtitle = reason,
            Tiles = tiles.Select(DaxComposer.Normalize).ToList(),
            Filters = DefaultFilters(schema),
            Version = 2,
            GeneratedAt = DateTimeOffset.Now,
            GeneratedBy = "heuristic",
        };
    }

    /// <summary>
    /// Columns that make good filters, best first: year/quarter/month of date tables, then grouping columns of
    /// dimension tables (category, brand, country…), then other short text columns of dimension tables.
    /// </summary>
    public static List<FilterDef> FilterCandidates(ModelSchema schema)
    {
        var timeTables = schema.Tables.Where(t => t.DataCategory == "Time").Select(t => t.Name).ToHashSet();
        var factTables = schema.Relationships.Select(r => r.FromTable).Except(schema.Relationships.Select(r => r.ToTable)).ToHashSet();
        var hiddenTables = schema.Tables.Where(t => t.IsHidden).Select(t => t.Name).ToHashSet();
        string[] timeNames = ["year", "quarter", "month"];

        return schema.Columns
            .Where(c => !c.IsHidden && !hiddenTables.Contains(c.Table) && !factTables.Contains(c.Table))
            .Where(c => c.DataType is "Text" or "String" or "Integer" or "True/False" or "Boolean")
            .Where(c => !BadGroupNames.Any(b => c.Name.Contains(b, StringComparison.OrdinalIgnoreCase)) || timeTables.Contains(c.Table))
            .Select(c =>
            {
                int rank;
                if (timeTables.Contains(c.Table))
                {
                    var t = Array.FindIndex(timeNames, n => c.Name.Contains(n, StringComparison.OrdinalIgnoreCase));
                    rank = t < 0 ? -1 : t;
                    if (c.Name.Contains("number", StringComparison.OrdinalIgnoreCase) || c.Name.Contains("key", StringComparison.OrdinalIgnoreCase)) rank = -1;
                }
                else
                {
                    var g = Array.FindIndex(GoodGroupNames, n => c.Name.Contains(n, StringComparison.OrdinalIgnoreCase));
                    rank = g < 0 ? (c.DataType is "Text" ? 100 : -1) : 10 + g;
                }
                return (Col: c, Rank: rank);
            })
            .Where(x => x.Rank >= 0)
            .OrderBy(x => x.Rank).ThenBy(x => x.Col.Name.Length)
            .GroupBy(x => x.Col.Table + "|" + x.Col.Name).Select(g => g.First())
            // One filter per concept: don't offer both 'customer'[Country] and 'store'[Country] up front.
            .DistinctBy(x => x.Col.Name, StringComparer.OrdinalIgnoreCase)
            .Select(x => new FilterDef(x.Col.Table, x.Col.Name, x.Col.Name))
            .ToList();
    }

    /// <summary>Default filter bar: the best date column plus the two best grouping columns.</summary>
    public static List<FilterDef> DefaultFilters(ModelSchema schema)
    {
        var timeTables = schema.Tables.Where(t => t.DataCategory == "Time").Select(t => t.Name).ToHashSet();
        var all = FilterCandidates(schema);
        return all.Where(f => timeTables.Contains(f.Table)).Take(1)
            .Concat(all.Where(f => !timeTables.Contains(f.Table)).Take(2))
            .ToList();
    }

    private static readonly string[] CurrencySymbols = ["R$", "CHF", "kr", "$", "€", "£", "¥", "₹", "₩", "zł"];

    /// <summary>The currency symbol the model's measures use most, from their format strings; null when none.</summary>
    public static string? CurrencySymbol(ModelSchema schema) =>
        schema.Measures
            .Select(m => m.FormatString ?? "")
            .Select(fs => CurrencySymbols.FirstOrDefault(sym => fs.Contains(sym, StringComparison.Ordinal)))
            .Where(sym => sym is not null)
            .GroupBy(sym => sym)
            .OrderByDescending(g => g.Count())
            .Select(g => g.Key)
            .FirstOrDefault();

    public static string GuessFormat(MeasureInfo m)
    {
        var fs = m.FormatString ?? "";
        if (m.DataType == "Currency" || fs.Contains('$') || fs.Contains('€') || fs.Contains('£')) return "currency";
        if (fs.Contains('%') || m.Name.Contains('%')) return "percent";
        if (m.DataType == "Integer") return "integer";
        return "number";
    }
}
