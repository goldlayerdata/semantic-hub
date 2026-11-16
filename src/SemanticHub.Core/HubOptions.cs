namespace SemanticHub.Core;

public sealed class HubOptions
{
    /// <summary>Where hub.json, schemas, dashboards and the audit log live. Default: %LOCALAPPDATA%\SemanticHub.</summary>
    public string? DataDirectory { get; set; }
    public int MaxRows { get; set; } = 500;
    public int QueryTimeoutSeconds { get; set; } = 30;
    public int MaxToolCallsPerQuestion { get; set; } = 10;

    public string ResolveDataDirectory() =>
        string.IsNullOrWhiteSpace(DataDirectory)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SemanticHub")
            : Environment.ExpandEnvironmentVariables(DataDirectory);
}
