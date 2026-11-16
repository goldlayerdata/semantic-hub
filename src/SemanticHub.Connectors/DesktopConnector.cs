using System.Diagnostics;
using System.Management;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.AnalysisServices.AdomdClient;
using Microsoft.Extensions.Logging;
using SemanticHub.Core;

namespace SemanticHub.Connectors;

/// <summary>
/// Power BI Desktop route: each open .pbix hosts its own msmdsrv.exe on a random localhost port.
/// Discovery: msmdsrv processes (WMI) → their workspace Data folder (-s arg) → msmdsrv.port.txt; parent PBIDesktop
/// process → .pbix path (command line) or window title.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DesktopConnector(ILogger<DesktopConnector> logger) : IModelConnector
{
    public string Route => "desktop";

    public Task<IReadOnlyList<DiscoveredModel>> DiscoverAsync(CancellationToken ct = default) =>
        Task.Run<IReadOnlyList<DiscoveredModel>>(() =>
        {
            try { return DiscoverViaWmi(); }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "WMI discovery failed; falling back to workspace port files");
                return DiscoverViaPortFiles();
            }
        }, ct);

    private List<DiscoveredModel> DiscoverViaWmi()
    {
        var result = new List<DiscoveredModel>();
        using var searcher = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process WHERE Name = 'msmdsrv.exe'");
        foreach (ManagementObject p in searcher.Get())
        {
            var cmd = p["CommandLine"] as string ?? "";
            var dataDir = ExtractArg(cmd, "-s");
            if (dataDir is null) continue;
            var port = ReadPort(dataDir);
            if (port is null) continue;

            var parentId = Convert.ToInt32(p["ParentProcessId"]);
            var (pbix, title) = DescribeParent(parentId);
            var name = pbix is not null ? Path.GetFileNameWithoutExtension(pbix) : title ?? $"Desktop model on port {port}";

            result.Add(new DiscoveredModel
            {
                Key = pbix ?? $"{name}@{port}",
                Name = name,
                Route = Route,
                Endpoint = $"localhost:{port}",
                SourcePath = pbix,
                ProcessId = parentId,
            });
        }
        return result;
    }

    private List<DiscoveredModel> DiscoverViaPortFiles()
    {
        var roots = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Power BI Desktop", "AnalysisServicesWorkspaces"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Microsoft", "Power BI Desktop Store App", "AnalysisServicesWorkspaces"),
        };
        var result = new List<DiscoveredModel>();
        foreach (var root in roots.Where(Directory.Exists))
        foreach (var ws in Directory.GetDirectories(root))
        {
            var port = ReadPort(Path.Combine(ws, "Data"));
            if (port is null || !PortOpen(port.Value)) continue;
            result.Add(new DiscoveredModel
            {
                Key = $"port:{port}", Name = $"Desktop model on port {port}", Route = Route, Endpoint = $"localhost:{port}",
            });
        }
        return result;
    }

    private static (string? pbix, string? title) DescribeParent(int pid)
    {
        string? pbix = null, title = null;
        try
        {
            using var s = new ManagementObjectSearcher($"SELECT CommandLine FROM Win32_Process WHERE ProcessId = {pid}");
            foreach (ManagementObject o in s.Get())
            {
                var cmd = o["CommandLine"] as string ?? "";
                var i = cmd.IndexOf(".pbix", StringComparison.OrdinalIgnoreCase);
                if (i > 0)
                {
                    var start = cmd.LastIndexOf('"', i);
                    var candidate = start >= 0 ? cmd[(start + 1)..(i + 5)] : null;
                    if (candidate is not null && File.Exists(candidate)) pbix = Path.GetFullPath(candidate);
                }
            }
        }
        catch { /* best effort */ }
        try
        {
            var t = Process.GetProcessById(pid).MainWindowTitle;
            const string suffix = " - Power BI Desktop";
            if (!string.IsNullOrWhiteSpace(t))
                title = t.EndsWith(suffix, StringComparison.Ordinal) ? t[..^suffix.Length] : t;
        }
        catch { /* process gone */ }
        return (pbix, title);
    }

    private static string? ExtractArg(string cmd, string flag)
    {
        var i = cmd.IndexOf(flag + " ", StringComparison.OrdinalIgnoreCase);
        if (i < 0) return null;
        var rest = cmd[(i + flag.Length)..].TrimStart();
        if (rest.StartsWith('"'))
        {
            var end = rest.IndexOf('"', 1);
            return end > 0 ? rest[1..end] : null;
        }
        var sp = rest.IndexOf(' ');
        return sp > 0 ? rest[..sp] : rest;
    }

    private static int? ReadPort(string dataDir)
    {
        var file = Path.Combine(dataDir, "msmdsrv.port.txt");
        if (!File.Exists(file)) return null;
        try
        {
            var bytes = File.ReadAllBytes(file);
            // Written as UTF-16 LE without BOM; fall back to UTF-8.
            var text = bytes.Length > 1 && bytes[1] == 0 ? Encoding.Unicode.GetString(bytes) : Encoding.UTF8.GetString(bytes);
            return int.TryParse(text.Trim('﻿', ' ', '\r', '\n', '\0'), out var port) ? port : null;
        }
        catch (IOException) { return null; }
    }

    private static bool PortOpen(int port)
    {
        try
        {
            using var c = new TcpClient();
            return c.ConnectAsync("localhost", port).Wait(300) && c.Connected;
        }
        catch { return false; }
    }

    public Task<QueryResult> ExecuteAsync(DiscoveredModel target, string dax, int maxRows, TimeSpan timeout, CancellationToken ct = default) =>
        Task.Run(() =>
        {
            var sw = Stopwatch.StartNew();
            using var conn = new AdomdConnection($"Data Source={target.Endpoint};");
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = dax;
            cmd.CommandTimeout = (int)Math.Ceiling(timeout.TotalSeconds);
            using var reg = ct.Register(() => { try { cmd.Cancel(); } catch { } });
            using var reader = cmd.ExecuteReader();

            var columns = new List<QueryColumn>();
            for (int i = 0; i < reader.FieldCount; i++)
                columns.Add(new QueryColumn(reader.GetName(i), MapType(reader.GetFieldType(i))));

            var rows = new List<object?[]>();
            bool truncated = false;
            while (reader.Read())
            {
                if (rows.Count >= maxRows) { truncated = true; break; }
                var row = new object?[reader.FieldCount];
                for (int i = 0; i < reader.FieldCount; i++) row[i] = Normalize(reader.GetValue(i));
                rows.Add(row);
                if (sw.Elapsed > timeout) throw new TimeoutException($"Query exceeded {timeout.TotalSeconds:0} s.");
            }
            return new QueryResult { Columns = columns, Rows = rows, Truncated = truncated, DurationMs = sw.ElapsedMilliseconds };
        }, ct);

    private static string MapType(Type? t) => t switch
    {
        null => "string",
        _ when t == typeof(bool) => "boolean",
        _ when t == typeof(DateTime) || t == typeof(DateTimeOffset) => "datetime",
        _ when t == typeof(long) || t == typeof(int) || t == typeof(short) || t == typeof(byte) => "integer",
        _ when t == typeof(double) || t == typeof(decimal) || t == typeof(float) => "number",
        _ => "string",
    };

    private static object? Normalize(object? v) => v switch
    {
        null or DBNull => null,
        DateTime d => d.TimeOfDay == TimeSpan.Zero ? d.ToString("yyyy-MM-dd") : d.ToString("yyyy-MM-ddTHH:mm:ss"),
        decimal m => (double)m,
        double d when double.IsNaN(d) || double.IsInfinity(d) => null,
        float f when float.IsNaN(f) || float.IsInfinity(f) => null,
        _ => v,
    };
}
