using System.Text.Json;
using SemanticHub.Agent;
using SemanticHub.Core;

namespace SemanticHub.Tests;

public class DashboardServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "semantic-hub-tests-" + Guid.NewGuid().ToString("N"));
    private readonly Connector _connector = new();
    private readonly HubService _hub;
    private readonly DashboardService _dash;

    public DashboardServiceTests()
    {
        var options = new HubOptions { DataDirectory = _dir, MaxRows = 500, QueryTimeoutSeconds = 5 };
        _hub = new HubService([_connector], new HubStore(options), new AuditLog(options), options);
        _dash = new DashboardService(_hub);
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private async Task<string> SetupAsync(int version = 2)
    {
        var model = await _hub.ApproveAsync("k");
        var tiles = new List<DashboardTile>
        {
            new() { Id = "kpi", Title = "Revenue", Kind = "kpi", Dax = "EVALUATE ROW(\"Value\", [Revenue])" },
            new() { Id = "by-year", Title = "By year", Kind = "column", Dax = "EVALUATE SUMMARIZECOLUMNS('date'[Year], \"Revenue\", [Revenue]) ORDER BY 'date'[Year]" },
        };
        if (version == 2) tiles = tiles.Select(DaxComposer.Normalize).ToList();
        await _hub.Store.SaveDashboardAsync(model.Id, new DashboardSpec { Title = "T", Tiles = tiles, Version = version });
        return model.Id;
    }

    private static List<FilterValue> Year(int y) => [new("date", "Year", [JsonSerializer.SerializeToElement(y)])];

    [Fact]
    public async Task V1_specs_are_migrated_on_read()
    {
        var id = await SetupAsync(version: 1);
        var spec = (await _dash.GetSpecAsync(id))!;
        Assert.Equal(2, spec.Version);
        Assert.All(spec.Tiles, t => Assert.True(t.Filterable));
        Assert.Equal("'date'[Year]", spec.Tiles[1].OrderBy);
        Assert.Contains(spec.Filters, f => f.Column == "Year");                      // default filters picked
        Assert.Equal(2, (await _hub.Store.GetDashboardAsync(id))!.Version);          // saved back
    }

    [Fact]
    public async Task Tile_runs_apply_filters_through_the_gate()
    {
        var id = await SetupAsync();
        var r = await _dash.RunTileAsync(id, "by-year", Year(2024), default);
        Assert.True(r.Ok);
        Assert.True(r.Filtered);
        Assert.Contains("TREATAS({2024}, 'date'[Year])", _connector.Executed.Last());
        Assert.Equal(r.Query, _connector.Executed.Last());
    }

    [Fact]
    public async Task Unknown_tiles_and_bad_filters_are_rejected_before_any_query()
    {
        var id = await SetupAsync();
        var before = _connector.Executed.Count;
        await Assert.ThrowsAsync<HubValidationException>(() => _dash.RunTileAsync(id, "nope", null, default));
        await Assert.ThrowsAsync<HubValidationException>(() => _dash.RunTileAsync(id, "kpi",
            [new FilterValue("date", "Year", [JsonSerializer.SerializeToElement("2024}) EVALUATE 'x' //")])], default));
        Assert.Equal(before, _connector.Executed.Count);
    }

    [Fact]
    public async Task Layout_save_reorders_renames_and_removes_but_keeps_queries()
    {
        var id = await SetupAsync();
        var original = (await _dash.GetSpecAsync(id))!;
        var spec = await _dash.SaveLayoutAsync(id, new(null, [new("by-year", "Revenue per year", "line", "full", "currency")], null, Removed: ["kpi"]), default);
        var t = Assert.Single(spec.Tiles);
        Assert.Equal(("Revenue per year", "line", "full", "currency"), (t.Title, t.Kind, t.Size, t.Format));
        Assert.Equal(original.Tiles[1].Expression, t.Expression);

        await Assert.ThrowsAsync<HubValidationException>(() => _dash.SaveLayoutAsync(id, new(null, [new("ghost", null, null, null, null)], null), default));
        await Assert.ThrowsAsync<HubValidationException>(() => _dash.SaveLayoutAsync(id, new(null, [], [new("date", "Nope", "x")]), default));
    }

    [Fact]
    public async Task Tiles_missing_from_a_layout_save_are_kept_not_deleted()
    {
        // A stale page (loaded before a pin from another tab) saves a layout that doesn't know the new tile.
        var id = await SetupAsync();
        var spec = await _dash.SaveLayoutAsync(id, new(null, [new("by-year", null, null, null, null)], null), default);
        Assert.Equal(["by-year", "kpi"], spec.Tiles.Select(t => t.Id));

        await Assert.ThrowsAsync<HubValidationException>(() =>
            _dash.SaveLayoutAsync(id, new(null, [new("kpi", null, null, null, null)], null, Removed: ["kpi"]), default));
        spec = await _dash.SaveLayoutAsync(id, new(null, [], null, Removed: ["kpi", "already-gone"]), default);
        Assert.Equal(["by-year"], spec.Tiles.Select(t => t.Id));
    }

    [Fact]
    public async Task Every_dashboard_save_keeps_the_previous_version()
    {
        var id = await SetupAsync();
        for (int i = 0; i < HubStore.DashboardHistoryKeep + 5; i++)
            await _dash.SaveLayoutAsync(id, new($"Title {i}", [], null), default);
        var history = _hub.Store.DashboardHistory(id);
        Assert.Equal(HubStore.DashboardHistoryKeep, history.Count);
        var newest = System.Text.Json.JsonSerializer.Deserialize<DashboardSpec>(File.ReadAllText(history[0]), new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;
        Assert.Equal($"Title {HubStore.DashboardHistoryKeep + 3}", newest.Title);   // the version before the last save
    }

    [Fact]
    public async Task Layout_save_stores_grid_positions_and_derives_size()
    {
        var id = await SetupAsync();
        var spec = await _dash.SaveLayoutAsync(id, new(null,
        [
            new("by-year", null, null, null, null, new GridLayout(0, 0, 16, 10)),
            new("kpi", null, null, null, null, new GridLayout(16, 0, 8, 5)),
        ], null), default);
        Assert.Equal(new GridLayout(0, 0, 16, 10), spec.Tiles[0].Layout);
        Assert.Equal("large", spec.Tiles[0].Size);
        Assert.Equal("medium", spec.Tiles[1].Size);

        // A later save without a layout keeps the stored one.
        spec = await _dash.SaveLayoutAsync(id, new(null, [new("by-year", "Renamed", null, null, null), new("kpi", null, null, null, null)], null), default);
        Assert.Equal(new GridLayout(0, 0, 16, 10), spec.Tiles[0].Layout);
    }

    [Theory]
    [InlineData(-1, 0, 6, 5)]
    [InlineData(20, 0, 6, 5)]
    [InlineData(0, 0, 0, 5)]
    [InlineData(0, -1, 6, 5)]
    [InlineData(0, 1001, 6, 5)]
    [InlineData(0, 0, 6, 2)]
    [InlineData(0, 0, 6, 61)]
    public async Task Out_of_range_layouts_are_rejected(int x, int y, int w, int h)
    {
        var id = await SetupAsync();
        await Assert.ThrowsAsync<HubValidationException>(() =>
            _dash.SaveLayoutAsync(id, new(null, [new("kpi", null, null, null, null, new GridLayout(x, y, w, h)), new("by-year", null, null, null, null)], null), default));
    }

    [Fact]
    public void Currency_symbol_is_the_most_common_in_measure_formats()
    {
        MeasureInfo M(string? fs) => new("t", Guid.NewGuid().ToString(), null, null, fs, null, false, null);
        Assert.Equal("€", HeuristicDashboard.CurrencySymbol(new ModelSchema { Measures = [M("€ #,0"), M("\\€#,0.00"), M("\\$#,0"), M("0.0%")] }));
        Assert.Null(HeuristicDashboard.CurrencySymbol(new ModelSchema { Measures = [M("#,0"), M(null)] }));
    }

    [Fact]
    public async Task Pinned_queries_are_validated_and_appended()
    {
        var id = await SetupAsync();
        var spec = await _dash.PinAsync(id, "EVALUATE SUMMARIZECOLUMNS('date'[Year], \"Revenue\", [Revenue])", "Revenue by year", "bar", "currency", default);
        var pinned = spec.Tiles.Last();
        Assert.Equal("pinned", pinned.Origin);
        Assert.True(pinned.Filterable);

        _connector.NextRows = 0;
        await Assert.ThrowsAsync<HubException>(() => _dash.PinAsync(id, "EVALUATE 'empty'", "Empty", "table", "number", default));
    }

    [Fact]
    public async Task Suggestions_are_added_once_by_id()
    {
        var id = await SetupAsync();
        var tile = DaxComposer.Normalize(new DashboardTile { Id = "s", Title = "Suggested", Kind = "table", Dax = "EVALUATE 'sales'" });
        var sid = _dash.RememberSuggestion(id, tile);
        var spec = await _dash.AddSuggestionAsync(id, sid, default);
        Assert.Equal("added", spec.Tiles.Last().Origin);
        await Assert.ThrowsAsync<HubValidationException>(() => _dash.AddSuggestionAsync(id, sid, default));
    }

    [Fact]
    public void Csv_escapes_and_defuses_formulas()
    {
        var csv = DashboardService.ToCsv(new TileResult
        {
            TileId = "t", Ok = true, Columns = [new("Name", "String"), new("Value", "Double")],
            Rows = [["=HYPERLINK(\"x\")", 1.5], ["a,b", -2.0]],
        });
        var lines = csv.Split(Environment.NewLine);
        Assert.Equal("Name,Value", lines[0]);
        Assert.Equal("\"'=HYPERLINK(\"\"x\"\")\",1.5", lines[1]);
        Assert.Equal("\"a,b\",-2", lines[2]);
    }

    [Fact]
    public async Task Chat_stream_adds_stages_remembers_queries_and_sends_answer_data_before_done()
    {
        var session = new ChatSession { Id = "c", ModelId = "m" };
        var sent = new List<string>();
        var stream = new ChatStream(session, o => { sent.Add(JsonSerializer.Serialize(o, o.GetType())); return Task.CompletedTask; });

        await stream.StartAsync();
        await stream.EmitAsync(new AgentEvent("tool") { ToolId = "t1", Tool = "run_dax", Dax = "EVALUATE 'sales'" });
        await stream.EmitAsync(new AgentEvent("tool_result") { ToolId = "t1", Ok = true, Columns = [new("a", "Int64")], Preview = [[1]] });
        await stream.EmitAsync(new AgentEvent("text") { Text = "Hi" });
        await stream.EmitAsync(new AgentEvent("text") { Text = "!" });
        await stream.EmitAsync(new AgentEvent("done"));

        Assert.Equal("EVALUATE 'sales'", session.FindQuery("t1")?.Dax);
        var types = sent.Select(s => JsonDocument.Parse(s).RootElement.GetProperty(s.Contains("\"type\"") ? "type" : "Type").GetString()).ToList();
        Assert.Equal(["stage", "tool", "stage", "tool_result", "stage", "stage", "text", "text", "answer_data", "done"], types);
    }

    private sealed class Connector : IModelConnector
    {
        public string Route => "desktop";
        public List<string> Executed { get; } = [];
        public int NextRows { get; set; } = 3;

        public Task<IReadOnlyList<DiscoveredModel>> DiscoverAsync(CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<DiscoveredModel>>([new DiscoveredModel { Key = "k", Name = "M", Route = Route, Endpoint = "localhost:1" }]);

        public Task<QueryResult> ExecuteAsync(DiscoveredModel target, string dax, int maxRows, TimeSpan timeout, CancellationToken ct = default)
        {
            if (dax.Contains("INFO.VIEW.TABLES")) return T(["[Name]", "[IsHidden]", "[DataCategory]"], ["sales", false, null], ["date", false, "Time"]);
            if (dax.Contains("INFO.VIEW.COLUMNS")) return T(["[Name]", "[Table]", "[DataType]", "[IsHidden]"], ["Year", "date", "Integer", false], ["Amount", "sales", "Currency", false]);
            if (dax.Contains("INFO.VIEW.MEASURES")) return T(["[Name]", "[Table]", "[Expression]", "[IsHidden]"], ["Revenue", "sales", "SUM(sales[Amount])", false]);
            if (dax.Contains("INFO.VIEW.RELATIONSHIPS")) return T(["[FromTable]"]);
            if (dax.StartsWith("EVALUATE ROW(\"t0\"") || dax.Contains("MIN(")) return T(["a"], [1]);
            Executed.Add(dax);
            var rows = Enumerable.Range(0, dax.Contains("ROW(\"Value\"") ? 1 : NextRows).Select(i => new object?[] { 2020 + i, 10.0 * i }).ToList();
            return Task.FromResult(new QueryResult { Columns = [new("Year", "Int64"), new("Revenue", "Double")], Rows = rows });
        }

        private static Task<QueryResult> T(string[] columns, params object?[][] rows) =>
            Task.FromResult(new QueryResult { Columns = columns.Select(c => new QueryColumn(c, "String")).ToList(), Rows = rows.ToList() });
    }
}
