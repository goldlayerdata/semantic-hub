namespace SemanticHub.Core;

/// <summary>A route to semantic models (Desktop now, Power BI service later).</summary>
public interface IModelConnector
{
    string Route { get; }

    Task<IReadOnlyList<DiscoveredModel>> DiscoverAsync(CancellationToken ct = default);

    /// <summary>Runs a query that has ALREADY passed <see cref="DaxGuard"/>. Reads at most <paramref name="maxRows"/> rows.</summary>
    Task<QueryResult> ExecuteAsync(DiscoveredModel target, string dax, int maxRows, TimeSpan timeout, CancellationToken ct = default);
}
