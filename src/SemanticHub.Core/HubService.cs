using System.Diagnostics;

namespace SemanticHub.Core;

public sealed record AuditContext(string Source, string? ConversationId = null, string? Question = null);

public sealed record DiscoveredView(DiscoveredModel Model, string? HubId);

/// <summary>
/// The only gateway to model data. Dashboard tiles, the designer and the agent all go through
/// <see cref="RunDaxAsync"/>: registered-model check → read-only guard → row/time limits → audit.
/// </summary>
public sealed class HubService
{
    private readonly IReadOnlyList<IModelConnector> _connectors;
    private readonly HubStore _store;
    private readonly AuditLog _audit;
    private readonly HubOptions _options;

    private readonly SemaphoreSlim _discoverLock = new(1, 1);
    private IReadOnlyList<DiscoveredModel> _discovered = [];
    private DateTimeOffset _discoveredAt = DateTimeOffset.MinValue;
    private static readonly TimeSpan DiscoveryTtl = TimeSpan.FromSeconds(20);

    public HubService(IEnumerable<IModelConnector> connectors, HubStore store, AuditLog audit, HubOptions options)
    {
        _connectors = connectors.ToList();
        _store = store;
        _audit = audit;
        _options = options;
    }

    public HubOptions Options => _options;
    public HubStore Store => _store;

    // ---------- discovery & registry ----------

    public async Task<IReadOnlyList<DiscoveredModel>> DiscoverAsync(bool force = false, CancellationToken ct = default)
    {
        await _discoverLock.WaitAsync(ct);
        try
        {
            if (!force && DateTimeOffset.Now - _discoveredAt < DiscoveryTtl) return _discovered;
            var all = new List<DiscoveredModel>();
            foreach (var c in _connectors)
                all.AddRange(await c.DiscoverAsync(ct));
            _discovered = all;
            _discoveredAt = DateTimeOffset.Now;
            return all;
        }
        finally { _discoverLock.Release(); }
    }

    public async Task<List<DiscoveredView>> DiscoverViewAsync(CancellationToken ct = default)
    {
        var models = await _store.GetModelsAsync();
        var found = await DiscoverAsync(force: true, ct);
        return found.Select(d => new DiscoveredView(d, models.FirstOrDefault(m => Matches(m, d))?.Id)).ToList();
    }

    public async Task<bool> IsOnlineAsync(HubModel model, CancellationToken ct = default) =>
        (await DiscoverAsync(false, ct)).Any(d => Matches(model, d));

    private static bool Matches(HubModel m, DiscoveredModel d) =>
        m.Route == d.Route &&
        (m.SourcePath is not null && d.SourcePath is not null
            ? string.Equals(m.SourcePath, d.SourcePath, StringComparison.OrdinalIgnoreCase)
            : string.Equals(m.Name, d.Name, StringComparison.OrdinalIgnoreCase));

    public async Task<HubModel> ApproveAsync(string discoveredKey, CancellationToken ct = default) =>
        await ApproveAsync(discoveredKey, null, ct);

    /// <summary>Registers an open model and reads its schema. <paramref name="progress"/> gets (step, text): connect, schema, profile.</summary>
    public async Task<HubModel> ApproveAsync(string discoveredKey, Func<string, string, Task>? progress, CancellationToken ct = default)
    {
        if (progress is not null) await progress("connect", "Connecting to Power BI Desktop…");
        var found = await DiscoverAsync(force: true, ct);
        var d = found.FirstOrDefault(x => x.Key == discoveredKey)
                ?? throw new HubException("That model is no longer open. Refresh the list.");

        var existing = (await _store.GetModelsAsync()).FirstOrDefault(m => Matches(m, d));
        if (existing is not null) return existing;

        var baseId = HubStore.Slugify(d.Name);
        var ids = (await _store.GetModelsAsync()).Select(m => m.Id).ToHashSet();
        var id = baseId;
        for (int i = 2; ids.Contains(id); i++) id = $"{baseId}-{i}";

        var model = new HubModel { Id = id, Name = d.Name, Route = d.Route, SourcePath = d.SourcePath, AddedAt = DateTimeOffset.Now };
        await _store.UpsertModelAsync(model);
        try
        {
            await HarvestSchemaAsync(model.Id, progress, ct);
        }
        catch (Exception ex)
        {
            // Don't leave a half-registered model behind (e.g. the file was still loading or has no tables).
            await _store.RemoveModelAsync(model.Id);
            if (ex is OperationCanceledException or HubException) throw;
            throw new HubException($"Couldn't read the schema of '{d.Name}': {CleanEngineError(ex)} If the file is still loading, wait and try again.");
        }
        return model;
    }

    public async Task<HubModel> GetModelOrThrowAsync(string modelId) =>
        await _store.GetModelAsync(modelId) ?? throw new HubException($"'{modelId}' is not a model in the hub.", rejected: true);

    private async Task<(IModelConnector, DiscoveredModel)> ResolveAsync(HubModel model, CancellationToken ct)
    {
        var connector = _connectors.FirstOrDefault(c => c.Route == model.Route)
                        ?? throw new HubException($"No connector for route '{model.Route}'.");
        var d = (await DiscoverAsync(false, ct)).FirstOrDefault(x => Matches(model, x))
                ?? (await DiscoverAsync(true, ct)).FirstOrDefault(x => Matches(model, x))
                ?? throw new HubException($"'{model.Name}' is not open in Power BI Desktop right now. Open the file and try again.");
        return (connector, d);
    }

    // ---------- schema ----------

    public async Task<ModelSchema> GetSchemaAsync(string modelId, CancellationToken ct = default)
    {
        await GetModelOrThrowAsync(modelId);
        return await _store.GetSchemaAsync(modelId) ?? await HarvestSchemaAsync(modelId, ct);
    }

    public Task<ModelSchema> HarvestSchemaAsync(string modelId, CancellationToken ct = default) => HarvestSchemaAsync(modelId, null, ct);

    public async Task<ModelSchema> HarvestSchemaAsync(string modelId, Func<string, string, Task>? progress, CancellationToken ct = default)
    {
        var model = await GetModelOrThrowAsync(modelId);
        var (connector, target) = await ResolveAsync(model, ct);
        if (progress is not null) await progress("schema", "Reading tables, columns and measures…");
        var timeout = TimeSpan.FromSeconds(_options.QueryTimeoutSeconds);
        var sw = Stopwatch.StartNew();

        async Task<QueryResult> Q(string dax) => await connector.ExecuteAsync(target, dax, 10_000, timeout, ct);

        var tables = await Q("EVALUATE INFO.VIEW.TABLES()");
        var columns = await Q("EVALUATE INFO.VIEW.COLUMNS()");
        var measures = await Q("EVALUATE INFO.VIEW.MEASURES()");
        var rels = await Q("EVALUATE INFO.VIEW.RELATIONSHIPS()");

        var schema = new ModelSchema
        {
            HarvestedAt = DateTimeOffset.Now,
            Tables = Rows(tables).Select(r => new TableInfo(r.S("Name"), r.N("Description"), r.B("IsHidden"), r.N("DataCategory")))
                .Where(t => !t.Name.StartsWith("DateTableTemplate_", StringComparison.Ordinal) && !t.Name.StartsWith("LocalDateTable_", StringComparison.Ordinal))
                .ToList(),
            Columns = Rows(columns)
                .Where(r => r.N("Type") != "RowNumber" && !r.S("Name").StartsWith("RowNumber-", StringComparison.Ordinal))
                .Select(r => new ColumnInfo(r.S("Table"), r.S("Name"), r.N("DataType"), r.N("Description"), r.B("IsHidden"), r.N("DataCategory")))
                .ToList(),
            Measures = Rows(measures)
                .Select(r => new MeasureInfo(r.S("Table"), r.S("Name"), r.N("Expression"), r.N("DataType"), r.N("FormatString"), r.N("Description"), r.B("IsHidden"), r.N("DisplayFolder")))
                .ToList(),
            Relationships = Rows(rels)
                .Select(r => new RelationshipInfo(r.S("FromTable"), r.S("FromColumn"), r.S("FromCardinality"), r.S("ToTable"), r.S("ToColumn"), r.S("ToCardinality"), r.B("IsActive"), r.N("CrossFilteringBehavior")))
                .ToList(),
        };
        // Drop columns of auto date tables that we filtered out above.
        var tableNames = schema.Tables.Select(t => t.Name).ToHashSet();
        schema.Columns.RemoveAll(c => !tableNames.Contains(c.Table));
        schema.Relationships.RemoveAll(r => !tableNames.Contains(r.FromTable) || !tableNames.Contains(r.ToTable));
        if (progress is not null) await progress("profile", $"Profiling the data ({schema.Tables.Count} tables, {schema.Measures.Count} measures)…");
        schema.Profile.AddRange(await ProfileAsync(schema, Q));

        await _store.SaveSchemaAsync(modelId, schema);
        await _audit.WriteAsync(new AuditEntry
        {
            Source = "schema", ModelId = modelId, DurationMs = sw.ElapsedMilliseconds,
            Note = $"harvested {schema.Tables.Count} tables, {schema.Columns.Count} columns, {schema.Measures.Count} measures, {schema.Relationships.Count} relationships",
        });
        return schema;
    }

    private static async Task<List<string>> ProfileAsync(ModelSchema schema, Func<string, Task<QueryResult>> q)
    {
        var lines = new List<string>();
        try
        {
            var visible = schema.Tables.Where(t => !t.IsHidden).Select(t => t.Name).ToList();
            if (visible.Count > 0)
            {
                var args = string.Join(", ", visible.Select((t, i) => $"\"t{i}\", COUNTROWS({SchemaText.TableRef(t)})"));
                var r = await q($"EVALUATE ROW({args})");
                if (r.Rows.Count == 1)
                    lines.Add("Row counts: " + string.Join(", ", visible.Select((t, i) => $"{t} = {r.Rows[0][i]:N0}")));
            }

            // Date range of each fact table, via its relationship to a date (Time) table.
            var timeTables = schema.Tables.Where(t => t.DataCategory == "Time").Select(t => t.Name).ToHashSet();
            foreach (var rel in schema.Relationships.Where(r => r.IsActive && timeTables.Contains(r.ToTable)))
            {
                var col = $"{SchemaText.TableRef(rel.FromTable)}[{rel.FromColumn}]";
                var r = await q($"EVALUATE ROW(\"min\", MIN({col}), \"max\", MAX({col}))");
                if (r.Rows.Count == 1)
                    lines.Add($"{rel.FromTable}[{rel.FromColumn}] runs from {r.Rows[0][0]} to {r.Rows[0][1]}");
            }
        }
        catch (Exception ex)
        {
            lines.Add($"(profile incomplete: {ex.Message.Split('\n')[0]})");
        }
        return lines;
    }

    private static IEnumerable<Row> Rows(QueryResult r)
    {
        // INFO.VIEW column names come back as "[Name]".
        var index = r.Columns.Select((c, i) => (c.Name.Trim('[', ']'), i)).ToDictionary(x => x.Item1, x => x.i, StringComparer.OrdinalIgnoreCase);
        return r.Rows.Select(values => new Row(index, values));
    }

    private readonly record struct Row(Dictionary<string, int> Index, object?[] Values)
    {
        public string? N(string col) => Index.TryGetValue(col, out var i) && Values[i] is { } v && v.ToString() is { Length: > 0 } s ? s : null;
        public string S(string col) => N(col) ?? "";
        public bool B(string col) => Index.TryGetValue(col, out var i) && Values[i] is { } v && (v is bool b ? b : bool.TryParse(v.ToString(), out var p) && p);
    }

    // ---------- the gate ----------

    public async Task<DaxRunResult> RunDaxAsync(string modelId, string dax, AuditContext ctx, int? maxRows = null, CancellationToken ct = default)
    {
        var limit = Math.Min(maxRows ?? _options.MaxRows, _options.MaxRows);

        HubModel? model = await _store.GetModelAsync(modelId ?? "");
        if (model is null)
            return await Reject(modelId, dax, ctx, $"'{modelId}' is not a model in the hub. Use list_models to see the registered model ids.");

        var verdict = DaxGuard.Check(dax);
        if (!verdict.Ok)
            return await Reject(modelId, dax, ctx, verdict.Error!);

        try
        {
            var (connector, target) = await ResolveAsync(model, ct);
            var result = await connector.ExecuteAsync(target, verdict.Query, limit, TimeSpan.FromSeconds(_options.QueryTimeoutSeconds), ct);
            await _audit.WriteAsync(new AuditEntry
            {
                Source = ctx.Source, ModelId = modelId, ConversationId = ctx.ConversationId, Question = ctx.Question,
                Dax = verdict.Query, Rows = result.Rows.Count, Truncated = result.Truncated, DurationMs = result.DurationMs,
            });
            return new DaxRunResult { Ok = true, Result = result };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            var msg = ex is HubException ? ex.Message : CleanEngineError(ex);
            await _audit.WriteAsync(new AuditEntry
            {
                Source = ctx.Source, ModelId = modelId, ConversationId = ctx.ConversationId, Question = ctx.Question,
                Dax = verdict.Query, Error = msg,
            });
            return new DaxRunResult { Ok = false, Error = msg };
        }
    }

    private async Task<DaxRunResult> Reject(string? modelId, string? dax, AuditContext ctx, string error)
    {
        await _audit.WriteAsync(new AuditEntry
        {
            Source = ctx.Source, ModelId = modelId, ConversationId = ctx.ConversationId, Question = ctx.Question,
            Dax = dax, Rejected = true, Error = error,
        });
        return new DaxRunResult { Ok = false, Rejected = true, Error = error };
    }

    private static string CleanEngineError(Exception ex)
    {
        var msg = ex.Message;
        // ADOMD prefixes are noise for the model and the user.
        foreach (var prefix in new[] { "Query (", "The following system error occurred:" })
        {
            var i = msg.IndexOf(prefix, StringComparison.Ordinal);
            if (i > 0) msg = msg[i..];
        }
        return msg.Length > 1500 ? msg[..1500] + "…" : msg;
    }
}

public class HubException(string message, bool rejected = false) : Exception(message)
{
    public bool Rejected { get; } = rejected;
}

/// <summary>The request itself is invalid (bad filter column/value, unknown tile id…) — maps to 400.</summary>
public sealed class HubValidationException(string message) : HubException(message);
