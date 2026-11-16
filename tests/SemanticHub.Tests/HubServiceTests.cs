using SemanticHub.Core;

namespace SemanticHub.Tests;

public class HubServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "semantic-hub-tests-" + Guid.NewGuid().ToString("N"));
    private readonly FakeConnector _connector = new();
    private readonly HubService _hub;
    private readonly AuditLog _audit;

    public HubServiceTests()
    {
        var options = new HubOptions { DataDirectory = _dir, MaxRows = 5, QueryTimeoutSeconds = 5 };
        _audit = new AuditLog(options);
        _hub = new HubService([_connector], new HubStore(options), _audit, options);
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private async Task<HubModel> ApproveAsync() => await _hub.ApproveAsync("fake-key");

    [Fact]
    public async Task Approve_registers_model_and_harvests_schema()
    {
        var model = await ApproveAsync();
        Assert.Equal("fake-model", model.Id);
        var schema = await _hub.GetSchemaAsync(model.Id);
        Assert.Single(schema.Tables);
        Assert.Single(schema.Measures);
    }

    [Fact]
    public async Task Unregistered_model_is_rejected_without_reaching_the_connector()
    {
        await ApproveAsync();
        _connector.Executed.Clear();

        foreach (var id in new[] { "nope", "localhost:1234", "Data Source=localhost:1234", "" })
        {
            var r = await _hub.RunDaxAsync(id, "EVALUATE 'sales'", new AuditContext("agent"));
            Assert.False(r.Ok);
            Assert.True(r.Rejected);
        }
        Assert.Empty(_connector.Executed);
    }

    [Fact]
    public async Task Non_dax_is_rejected_and_audited()
    {
        var model = await ApproveAsync();
        _connector.Executed.Clear();

        var r = await _hub.RunDaxAsync(model.Id, "{ \"delete\": { \"object\": { \"database\": \"x\" } } }", new AuditContext("agent", "c1", "delete it"));

        Assert.True(r.Rejected);
        Assert.Empty(_connector.Executed);
        var entry = (await _audit.ReadRecentAsync(1)).Single();
        Assert.True(entry.Rejected);
        Assert.Equal("delete it", entry.Question);
    }

    [Fact]
    public async Task Rows_are_capped_at_the_hub_limit_even_if_caller_asks_for_more()
    {
        var model = await ApproveAsync();
        var r = await _hub.RunDaxAsync(model.Id, "EVALUATE 'sales'", new AuditContext("agent"), maxRows: 10_000);

        Assert.True(r.Ok);
        Assert.Equal(5, r.Result!.Rows.Count);
        Assert.True(r.Result.Truncated);
        Assert.Equal(5, _connector.LastMaxRows);
    }

    [Fact]
    public async Task Engine_errors_come_back_as_a_failed_result_not_an_exception()
    {
        var model = await ApproveAsync();
        var r = await _hub.RunDaxAsync(model.Id, "EVALUATE 'missing'", new AuditContext("agent"));
        Assert.False(r.Ok);
        Assert.False(r.Rejected);
        Assert.Contains("missing", r.Error);
    }

    [Fact]
    public async Task Failed_schema_harvest_does_not_leave_a_model_behind()
    {
        _connector.FailSchema = true;
        await Assert.ThrowsAsync<HubException>(ApproveAsync);
        Assert.Empty(await _hub.Store.GetModelsAsync());
    }

    private sealed class FakeConnector : IModelConnector
    {
        public string Route => "desktop";
        public List<string> Executed { get; } = [];
        public int LastMaxRows { get; private set; }
        public bool FailSchema { get; set; }

        public Task<IReadOnlyList<DiscoveredModel>> DiscoverAsync(CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<DiscoveredModel>>([new DiscoveredModel { Key = "fake-key", Name = "Fake Model", Route = Route, Endpoint = "localhost:1" }]);

        public Task<QueryResult> ExecuteAsync(DiscoveredModel target, string dax, int maxRows, TimeSpan timeout, CancellationToken ct = default)
        {
            Executed.Add(dax);
            LastMaxRows = maxRows;
            if (dax.Contains("INFO.VIEW") && FailSchema) throw new InvalidOperationException("DAX Evaluate queries work only on databases which have at least one table.");
            if (dax.Contains("INFO.VIEW.TABLES")) return Table(["[Name]", "[Description]", "[IsHidden]", "[DataCategory]"], ["sales", "Fact", false, "Regular"]);
            if (dax.Contains("INFO.VIEW.COLUMNS")) return Table(["[Name]", "[Table]", "[DataType]", "[IsHidden]", "[Type]"], ["Amount", "sales", "Double", false, "Data"]);
            if (dax.Contains("INFO.VIEW.MEASURES")) return Table(["[Name]", "[Table]", "[Expression]", "[IsHidden]"], ["Revenue", "sales", "SUM(sales[Amount])", false]);
            if (dax.Contains("INFO.VIEW.RELATIONSHIPS")) return Table(["[FromTable]"]);
            if (dax.Contains("'missing'")) throw new InvalidOperationException("Cannot find table 'missing'.");

            var all = Enumerable.Range(0, 20).Select(i => new object?[] { i }).ToList();
            return Task.FromResult(new QueryResult
            {
                Columns = [new("[n]", "integer")],
                Rows = all.Take(maxRows).ToList(),
                Truncated = all.Count > maxRows,
            });
        }

        private static Task<QueryResult> Table(string[] columns, params object?[][] rows) =>
            Task.FromResult(new QueryResult { Columns = columns.Select(c => new QueryColumn(c, "string")).ToList(), Rows = rows.ToList() });
    }
}
