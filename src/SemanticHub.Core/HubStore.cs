using System.Text.Json;

namespace SemanticHub.Core;

/// <summary>File-backed registry: hub.json + schemas/{id}.json + dashboards/{id}.json.</summary>
public sealed class HubStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string _root;
    private readonly SemaphoreSlim _lock = new(1, 1);

    public HubStore(HubOptions options)
    {
        _root = options.ResolveDataDirectory();
        Directory.CreateDirectory(Path.Combine(_root, "schemas"));
        Directory.CreateDirectory(Path.Combine(_root, "dashboards"));
    }

    public string Root => _root;
    private string HubFile => Path.Combine(_root, "hub.json");
    private string SchemaFile(string id) => Path.Combine(_root, "schemas", SafeId(id) + ".json");
    private string DashboardFile(string id) => Path.Combine(_root, "dashboards", SafeId(id) + ".json");

    public async Task<List<HubModel>> GetModelsAsync()
    {
        if (!File.Exists(HubFile)) return [];
        await using var fs = File.OpenRead(HubFile);
        return await JsonSerializer.DeserializeAsync<List<HubModel>>(fs, Json) ?? [];
    }

    public async Task<HubModel?> GetModelAsync(string id) =>
        (await GetModelsAsync()).FirstOrDefault(m => string.Equals(m.Id, id, StringComparison.OrdinalIgnoreCase));

    public async Task UpsertModelAsync(HubModel model)
    {
        await _lock.WaitAsync();
        try
        {
            var all = await GetModelsAsync();
            all.RemoveAll(m => m.Id == model.Id);
            all.Add(model);
            await WriteAsync(HubFile, all.OrderBy(m => m.Name).ToList());
        }
        finally { _lock.Release(); }
    }

    public async Task RemoveModelAsync(string id)
    {
        await _lock.WaitAsync();
        try
        {
            var all = await GetModelsAsync();
            all.RemoveAll(m => m.Id == id);
            await WriteAsync(HubFile, all);
            File.Delete(SchemaFile(id));
            File.Delete(DashboardFile(id));
        }
        finally { _lock.Release(); }
    }

    public Task<ModelSchema?> GetSchemaAsync(string id) => ReadAsync<ModelSchema>(SchemaFile(id));
    public Task SaveSchemaAsync(string id, ModelSchema schema) => WriteAsync(SchemaFile(id), schema);
    public Task<DashboardSpec?> GetDashboardAsync(string id) => ReadAsync<DashboardSpec>(DashboardFile(id));
    public const int DashboardHistoryKeep = 20;

    /// <summary>Saves a dashboard; the previous version is first copied to dashboards/history/{id}/ (last 20 kept).</summary>
    public async Task SaveDashboardAsync(string id, DashboardSpec spec)
    {
        var file = DashboardFile(id);
        if (File.Exists(file))
        {
            var dir = Path.Combine(_root, "dashboards", "history", SafeId(id));
            Directory.CreateDirectory(dir);
            File.Copy(file, Path.Combine(dir, $"{DateTime.Now:yyyyMMdd-HHmmss-fff}.json"), overwrite: true);
            foreach (var old in Directory.GetFiles(dir, "*.json").OrderByDescending(f => f, StringComparer.Ordinal).Skip(DashboardHistoryKeep))
                File.Delete(old);
        }
        await WriteAsync(file, spec);
    }

    /// <summary>Saved previous versions of a dashboard, newest first.</summary>
    public IReadOnlyList<string> DashboardHistory(string id)
    {
        var dir = Path.Combine(_root, "dashboards", "history", SafeId(id));
        return Directory.Exists(dir) ? Directory.GetFiles(dir, "*.json").OrderByDescending(f => f, StringComparer.Ordinal).ToList() : [];
    }

    private static async Task<T?> ReadAsync<T>(string path)
    {
        if (!File.Exists(path)) return default;
        await using var fs = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<T>(fs, Json);
    }

    private static async Task WriteAsync<T>(string path, T value)
    {
        var tmp = path + ".tmp";
        await using (var fs = File.Create(tmp))
            await JsonSerializer.SerializeAsync(fs, value, Json);
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>Hub ids are slugs; anything else can't be used as a path segment.</summary>
    public static string SafeId(string id)
    {
        var s = new string(id.Where(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_').ToArray());
        if (s.Length == 0 || s != id) throw new ArgumentException($"Invalid hub model id '{id}'.");
        return s;
    }

    public static string Slugify(string name)
    {
        var chars = name.ToLowerInvariant().Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-').ToArray();
        var slug = string.Join('-', new string(chars).Split('-', StringSplitOptions.RemoveEmptyEntries));
        return slug.Length == 0 ? "model" : slug[..Math.Min(slug.Length, 60)];
    }
}
