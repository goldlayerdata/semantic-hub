using System.Collections.Concurrent;
using System.Globalization;
using System.Text;

namespace SemanticHub.Core;

/// <summary>
/// Everything the dashboard page does with a spec: run tiles under filters, filter values, explain, pin, add a
/// suggested tile, save layout edits. All queries are composed here and run through <see cref="HubService.RunDaxAsync"/>;
/// the browser never sends DAX — only filter values, layout fields and ids of server-held queries.
/// </summary>
public sealed class DashboardService(HubService hub)
{
    public const int TileMaxRows = 200;
    private readonly SemaphoreSlim _write = new(1, 1);
    private readonly ConcurrentDictionary<string, Suggestion> _suggestions = new();
    private static readonly TimeSpan SuggestionTtl = TimeSpan.FromMinutes(15);

    private sealed record Suggestion(string ModelId, DashboardTile Tile, DateTimeOffset At);

    public sealed record TileLayout(string Id, string? Title, string? Kind, string? Size, string? Format, GridLayout? Layout = null);
    /// <summary>Edit-mode save. <see cref="Tiles"/> gives the order and display fields; tiles not listed are kept; only <see cref="Removed"/> deletes.</summary>
    public sealed record LayoutUpdate(string? Title, List<TileLayout> Tiles, List<FilterDef>? Filters, List<string>? Removed = null);

    public sealed record ExplainMeasure(string Name, string Table, string? Description, string? Expression, string? FormatString);
    public sealed record ExplainColumn(string Table, string Column, string? Description);
    public sealed record ExplainFilter(string Label, List<object?> Values);
    public sealed record Explanation(string TileId, string Title, string? Description, List<ExplainMeasure> Measures,
        List<ExplainColumn> Columns, List<ExplainFilter> Filters, string Query, bool Filterable);

    // ---------- spec ----------

    /// <summary>The spec in v2 form; v1 files are migrated (and saved) on first read.</summary>
    public async Task<DashboardSpec?> GetSpecAsync(string modelId, CancellationToken ct = default)
    {
        await hub.GetModelOrThrowAsync(modelId);
        var spec = await hub.Store.GetDashboardAsync(modelId);
        if (spec is null) return null;
        var schema = await hub.GetSchemaAsync(modelId, ct);
        if (spec.Version < 2)
        {
            spec = Upgrade(spec, schema);
            await hub.Store.SaveDashboardAsync(modelId, spec);
        }
        return spec with { Currency = HeuristicDashboard.CurrencySymbol(schema) };
    }

    public async Task<DashboardSpec> GetSpecOrThrowAsync(string modelId, CancellationToken ct = default) =>
        await GetSpecAsync(modelId, ct) ?? throw new HubException("This model has no dashboard yet.");

    /// <summary>Normalises tiles, fills in default filters, and marks the spec v2.</summary>
    public static DashboardSpec Upgrade(DashboardSpec spec, ModelSchema schema)
    {
        var filters = spec.Filters.Count > 0 ? ValidFilterDefs(schema, spec.Filters) : HeuristicDashboard.DefaultFilters(schema);
        return spec with { Tiles = spec.Tiles.Select(DaxComposer.Normalize).ToList(), Filters = filters, Version = 2 };
    }

    private static List<FilterDef> ValidFilterDefs(ModelSchema schema, IEnumerable<FilterDef> defs)
    {
        var list = new List<FilterDef>();
        foreach (var d in defs)
        {
            ColumnInfo col;
            try { col = DaxComposer.FindColumn(schema, d.Table, d.Column); }
            catch (HubValidationException) { continue; }
            if (list.Any(x => x.Table == col.Table && x.Column == col.Name)) continue;
            var label = string.IsNullOrWhiteSpace(d.Label) ? col.Name : d.Label.Trim();
            list.Add(new FilterDef(col.Table, col.Name, label.Length > 40 ? label[..40] : label));
        }
        return list.Take(6).ToList();
    }

    // ---------- running tiles ----------

    public async Task<List<TileResult>> RunAllAsync(string modelId, IEnumerable<FilterValue>? filters, CancellationToken ct)
    {
        var spec = await GetSpecOrThrowAsync(modelId, ct);
        var applied = DaxComposer.BuildFilters(await hub.GetSchemaAsync(modelId, ct), filters);
        var results = new List<TileResult>();
        foreach (var tile in spec.Tiles)   // sequential: one Desktop engine, small queries
            results.Add(await RunTileAsync(modelId, tile, applied, "dashboard", ct));
        return results;
    }

    public async Task<TileResult> RunTileAsync(string modelId, string tileId, IEnumerable<FilterValue>? filters, CancellationToken ct)
    {
        var spec = await GetSpecOrThrowAsync(modelId, ct);
        var tile = FindTile(spec, tileId);
        var applied = DaxComposer.BuildFilters(await hub.GetSchemaAsync(modelId, ct), filters);
        return await RunTileAsync(modelId, tile, applied, "dashboard", ct);
    }

    public async Task<TileResult> RunTileAsync(string modelId, DashboardTile tile, IReadOnlyList<DaxComposer.AppliedFilter> filters, string source, CancellationToken ct)
    {
        var query = DaxComposer.TileQuery(tile, filters);
        var filtered = tile.Filterable && filters.Count > 0;
        var note = filtered ? $" [{string.Join("; ", filters.Select(f => f.Describe()))}]" : "";
        var r = await hub.RunDaxAsync(modelId, query, new AuditContext(source, Question: $"tile: {tile.Title}{note}"), TileMaxRows, ct);
        return r.Ok
            ? new TileResult { TileId = tile.Id, Ok = true, Columns = r.Result!.Columns, Rows = r.Result.Rows, Truncated = r.Result.Truncated, DurationMs = r.Result.DurationMs, Query = query, Filtered = filtered }
            : new TileResult { TileId = tile.Id, Ok = false, Error = r.Error, Query = query, Filtered = filtered };
    }

    /// <summary>Checks a candidate tile the way the designer does: it must run and return the shape its kind needs.</summary>
    public async Task<(TileResult Result, string? Problem)> ValidateTileAsync(string modelId, DashboardTile tile, string source, CancellationToken ct)
    {
        var r = await RunTileAsync(modelId, tile, [], source, ct);
        return (r, Problem(tile, r));
    }

    public static string? Problem(DashboardTile tile, TileResult r) => r switch
    {
        { Ok: false } => r.Error ?? "Query failed.",
        { Rows.Count: 0 } => "The query returned no rows.",
        { Columns.Count: < 2 } when tile.Kind is not ("kpi" or "table") => "A chart needs a category column and at least one value column.",
        { Rows.Count: > 1 } when tile.Kind == "kpi" => "A KPI query must return exactly one row.",
        _ when tile.Kind == "kpi" && r.Rows[0][0] is null => "The KPI value is blank.",
        _ => null,
    };

    // ---------- filters ----------

    public async Task<List<FilterDef>> FilterColumnsAsync(string modelId, CancellationToken ct) =>
        HeuristicDashboard.FilterCandidates(await hub.GetSchemaAsync(modelId, ct));

    public async Task<(List<object?> Values, bool Truncated)> FilterValuesAsync(string modelId, string table, string column, CancellationToken ct)
    {
        var col = DaxComposer.FindColumn(await hub.GetSchemaAsync(modelId, ct), table, column);
        var colRef = DaxComposer.ColumnRef(col);
        var r = await hub.RunDaxAsync(modelId, $"EVALUATE VALUES({colRef}) ORDER BY {colRef}",
            new AuditContext("dashboard", Question: $"filter values: {col.Name}"), maxRows: 500, ct);
        if (!r.Ok) throw new HubException(r.Error ?? "Couldn't read the filter values.");
        return (r.Result!.Rows.Select(row => row[0]).ToList(), r.Result.Truncated);
    }

    /// <summary>One line for the Q&amp;A agent describing the dashboard filters (with their DAX form).</summary>
    public async Task<string?> DescribeFiltersAsync(string modelId, IEnumerable<FilterValue>? filters, CancellationToken ct)
    {
        var applied = DaxComposer.BuildFilters(await hub.GetSchemaAsync(modelId, ct), filters);
        if (applied.Count == 0) return null;
        return $"(Dashboard filters in effect: {string.Join("; ", applied.Select(f => f.Describe()))}. " +
               $"Apply them unless my question says otherwise, e.g. CALCULATETABLE(<table>, {string.Join(", ", applied.Select(f => f.Clause))}).)";
    }

    // ---------- explain ----------

    public async Task<Explanation> ExplainAsync(string modelId, string tileId, IEnumerable<FilterValue>? filters, CancellationToken ct)
    {
        var spec = await GetSpecOrThrowAsync(modelId, ct);
        var tile = FindTile(spec, tileId);
        var schema = await hub.GetSchemaAsync(modelId, ct);
        var applied = DaxComposer.BuildFilters(schema, filters);
        var (measures, columns) = DaxComposer.References(schema, tile.Expression ?? tile.Dax);
        return new Explanation(
            tile.Id, tile.Title, tile.Description,
            measures.Select(m => new ExplainMeasure(m.Name, m.Table, m.Description, m.Expression, m.FormatString)).ToList(),
            columns.Select(c => new ExplainColumn(c.Table, c.Name, c.Description)).ToList(),
            tile.Filterable ? applied.Select(f => new ExplainFilter(f.Label, f.Values)).ToList() : [],
            DaxComposer.TileQuery(tile, applied),
            tile.Filterable);
    }

    // ---------- CSV ----------

    public async Task<(string FileName, string Csv)> ExportCsvAsync(string modelId, string tileId, IEnumerable<FilterValue>? filters, CancellationToken ct)
    {
        var spec = await GetSpecOrThrowAsync(modelId, ct);
        var tile = FindTile(spec, tileId);
        var applied = DaxComposer.BuildFilters(await hub.GetSchemaAsync(modelId, ct), filters);
        var r = await RunTileAsync(modelId, tile, applied, "dashboard", ct);
        if (!r.Ok) throw new HubException(r.Error ?? "The tile query failed.");
        return ($"{HubStore.Slugify(tile.Title)}.csv", ToCsv(r));
    }

    public static string ToCsv(TileResult r)
    {
        var sb = new StringBuilder();
        sb.AppendLine(string.Join(",", r.Columns.Select(c => Cell(c.Name))));
        foreach (var row in r.Rows) sb.AppendLine(string.Join(",", row.Select(Cell)));
        return sb.ToString();

        static string Cell(object? v)
        {
            var s = v switch
            {
                null => "",
                double d => d.ToString("R", CultureInfo.InvariantCulture),
                IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
                _ => v.ToString() ?? "",
            };
            // Spreadsheet formula injection: text starting with = + - @ is prefixed so Excel shows it as text.
            if (v is string && s.Length > 0 && s[0] is '=' or '+' or '-' or '@') s = "'" + s;
            return s.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? $"\"{s.Replace("\"", "\"\"")}\"" : s;
        }
    }

    // ---------- edits ----------

    /// <summary>Appends a tile built from a query the server already ran (pinned answer). Validated through the gate first.</summary>
    public async Task<DashboardSpec> PinAsync(string modelId, string dax, string title, string kind, string format, CancellationToken ct)
    {
        var tile = DaxComposer.Normalize(new DashboardTile
        {
            Id = "pin",
            Title = Clean(title, 80) ?? "Pinned answer",
            Kind = DashboardTile.Kinds.Contains(kind) ? kind : "table",
            Format = DashboardTile.Formats.Contains(format) ? format : "number",
            Size = kind == "kpi" ? "small" : kind == "table" ? "large" : "medium",
            Dax = dax,
            Origin = "pinned",
            Description = "Pinned from a Q&A answer.",
        });
        var (_, problem) = await ValidateTileAsync(modelId, tile, "dashboard", ct);
        if (problem is not null) throw new HubException($"This answer can't be pinned: {problem}");
        return await AppendTileAsync(modelId, tile, ct);
    }

    /// <summary>Keeps a previewed tile server-side so the browser confirms it by id instead of posting DAX back.</summary>
    public string RememberSuggestion(string modelId, DashboardTile tile)
    {
        foreach (var (key, s) in _suggestions)
            if (DateTimeOffset.Now - s.At > SuggestionTtl) _suggestions.TryRemove(key, out _);
        var id = Guid.NewGuid().ToString("N")[..16];
        _suggestions[id] = new Suggestion(modelId, tile, DateTimeOffset.Now);
        return id;
    }

    public async Task<DashboardSpec> AddSuggestionAsync(string modelId, string suggestionId, CancellationToken ct)
    {
        if (!_suggestions.TryRemove(suggestionId ?? "", out var s) || s.ModelId != modelId || DateTimeOffset.Now - s.At > SuggestionTtl)
            throw new HubValidationException("That preview has expired. Ask for the tile again.");
        return await AppendTileAsync(modelId, s.Tile with { Origin = "added" }, ct);
    }

    private async Task<DashboardSpec> AppendTileAsync(string modelId, DashboardTile tile, CancellationToken ct)
    {
        await _write.WaitAsync(ct);
        try
        {
            var spec = await GetSpecOrThrowAsync(modelId, ct);
            var baseId = HubStore.Slugify($"{tile.Origin}-{tile.Title}");
            var id = baseId;
            for (int i = 2; spec.Tiles.Any(t => t.Id == id); i++) id = $"{baseId}-{i}";
            var updated = spec with { Tiles = [.. spec.Tiles, tile with { Id = id, Layout = null }], Currency = null };
            await hub.Store.SaveDashboardAsync(modelId, updated);
            return updated with { Currency = HeuristicDashboard.CurrencySymbol(await hub.GetSchemaAsync(modelId, ct)) };
        }
        finally { _write.Release(); }
    }

    /// <summary>Layout save: order, display fields, explicit removals. Queries can't be changed through this.</summary>
    public async Task<DashboardSpec> SaveLayoutAsync(string modelId, LayoutUpdate update, CancellationToken ct)
    {
        if (update?.Tiles is null) throw new HubValidationException("The layout has no tile list.");
        await _write.WaitAsync(ct);
        try
        {
            var spec = await GetSpecOrThrowAsync(modelId, ct);
            var byId = spec.Tiles.ToDictionary(t => t.Id);
            var removed = (update.Removed ?? []).Where(r => r is not null).ToHashSet();
            var tiles = new List<DashboardTile>();
            foreach (var l in update.Tiles)
            {
                if (l is null || !byId.TryGetValue(l.Id ?? "", out var tile)) throw new HubValidationException($"Unknown tile '{l?.Id}'.");
                if (tiles.Any(t => t.Id == tile.Id)) throw new HubValidationException($"Tile '{tile.Id}' is listed twice.");
                if (removed.Contains(tile.Id)) throw new HubValidationException($"Tile '{tile.Id}' is both listed and removed.");
                if (l.Layout?.Problem() is { } bad) throw new HubValidationException($"Tile '{tile.Id}': {bad}");
                tiles.Add(tile with
                {
                    Layout = l.Layout ?? tile.Layout,
                    Title = Clean(l.Title, 80) ?? tile.Title,
                    Kind = l.Kind is not null && DashboardTile.Kinds.Contains(l.Kind) ? l.Kind : tile.Kind,
                    Size = l.Layout?.Size ?? (l.Size is not null && DashboardTile.Sizes.Contains(l.Size) ? l.Size : tile.Size),
                    Format = l.Format is not null && DashboardTile.Formats.Contains(l.Format) ? l.Format : tile.Format,
                });
            }
            // Tiles the client didn't mention are kept (e.g. pinned from another tab after this page loaded).
            // Only ids named in Removed are deleted, so a stale page can never drop tiles by omission.
            tiles.AddRange(spec.Tiles.Where(t => !removed.Contains(t.Id) && !tiles.Any(x => x.Id == t.Id)));
            var filters = spec.Filters;
            if (update.Filters is not null)
            {
                var schema = await hub.GetSchemaAsync(modelId, ct);
                foreach (var f in update.Filters) DaxComposer.FindColumn(schema, f?.Table, f?.Column);   // 400 on unknown columns
                filters = ValidFilterDefs(schema, update.Filters);
            }
            var updated = spec with { Title = Clean(update.Title, 120) ?? spec.Title, Tiles = tiles, Filters = filters, Currency = null };
            await hub.Store.SaveDashboardAsync(modelId, updated);
            return updated with { Currency = HeuristicDashboard.CurrencySymbol(await hub.GetSchemaAsync(modelId, ct)) };
        }
        finally { _write.Release(); }
    }

    /// <summary>The no-LLM dashboard: heuristic tiles that pass validation.</summary>
    public async Task<DashboardSpec> BuildHeuristicAsync(string modelId, string reason, CancellationToken ct)
    {
        var model = await hub.GetModelOrThrowAsync(modelId);
        var draft = HeuristicDashboard.Build(model, await hub.GetSchemaAsync(modelId, ct), reason);
        var keep = new List<DashboardTile>();
        foreach (var tile in draft.Tiles)
            if ((await ValidateTileAsync(modelId, tile, "designer", ct)).Problem is null) keep.Add(tile);
        var spec = draft with { Tiles = keep };
        await hub.Store.SaveDashboardAsync(modelId, spec);
        return spec;
    }

    private static DashboardTile FindTile(DashboardSpec spec, string tileId) =>
        spec.Tiles.FirstOrDefault(t => t.Id == tileId) ?? throw new HubValidationException($"Unknown tile '{tileId}'.");

    private static string? Clean(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = string.Join(' ', s.Split((char[])['\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries)).Trim();
        return s.Length > max ? s[..max] : s;
    }
}
