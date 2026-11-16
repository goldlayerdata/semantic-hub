using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SemanticHub.Core;

/// <summary>
/// Builds the queries dashboard tiles run. A tile stores a table expression; filters are applied by wrapping it:
/// <c>EVALUATE CALCULATETABLE(&lt;expression&gt;, TREATAS({…}, 'table'[Column]) …) ORDER BY …</c>.
/// Filter columns must exist in the schema and values become typed literals, so no browser text reaches DAX as code.
/// </summary>
public static partial class DaxComposer
{
    public const int MaxFilters = 8;
    public const int MaxValuesPerFilter = 200;

    public sealed record SplitQuery(string Expression, string? OrderBy);

    /// <summary>A validated filter: the DAX clause plus a readable description.</summary>
    public sealed record AppliedFilter(ColumnInfo Column, string Clause, List<object?> Values)
    {
        public string Label => Column.Name;
        public string Describe() => $"{Column.Name} = {string.Join(", ", Values.Select(v => v?.ToString() ?? "(blank)"))}";
    }

    /// <summary>
    /// Splits <c>EVALUATE &lt;expr&gt; [ORDER BY …]</c> into its parts. Returns null for anything else (DEFINE blocks,
    /// several EVALUATEs, unbalanced brackets): such queries can still run, just not with filters.
    /// </summary>
    public static SplitQuery? Split(string? query)
    {
        if (string.IsNullOrWhiteSpace(query)) return null;
        var s = DaxGuard.StripComments(query).Trim();
        var start = EvaluateKeyword().Match(s);
        if (!start.Success || start.Index != 0) return null;
        var body = s[start.Length..];

        int depth = 0, orderAt = -1, orderLen = 0;
        for (int i = 0; i < body.Length; i++)
        {
            char c = body[i];
            switch (c)
            {
                case '"': i = SkipQuoted(body, i, '"'); continue;
                case '\'': i = SkipQuoted(body, i, '\''); continue;
                case '[': i = SkipBracket(body, i); continue;
                case '(': depth++; continue;
                case ')': if (--depth < 0) return null; continue;
            }
            if (depth != 0 || !char.IsLetter(c) || (i > 0 && IsIdentChar(body[i - 1]))) continue;

            var m = TopLevelKeyword().Match(body, i);
            if (!m.Success || m.Index != i) continue;
            var word = m.Groups[1].Value.ToUpperInvariant();
            if (word is "EVALUATE" or "DEFINE") return null;          // multi-statement query
            if (orderAt < 0) { orderAt = i; orderLen = m.Length; }    // ORDER BY
        }
        if (depth != 0) return null;

        var expr = (orderAt < 0 ? body : body[..orderAt]).Trim();
        var orderBy = orderAt < 0 ? null : body[(orderAt + orderLen)..].Trim();
        if (expr.Length == 0 || orderBy is { Length: 0 }) return null;
        return new SplitQuery(expr, orderBy);
    }

    /// <summary>Brings a tile into v2 form: splits <see cref="DashboardTile.Dax"/> into expression + order-by when possible.</summary>
    public static DashboardTile Normalize(DashboardTile tile)
    {
        if (tile.Expression is not null) return tile.Dax is null ? tile : tile with { Dax = null };
        if (Split(tile.Dax) is { } split) return tile with { Expression = split.Expression, OrderBy = split.OrderBy, Dax = null };
        return tile;   // fixed tile
    }

    /// <summary>The query for a tile under the given filters (fixed tiles ignore filters).</summary>
    public static string TileQuery(DashboardTile tile, IReadOnlyList<AppliedFilter> filters) =>
        tile.Expression is null
            ? tile.Dax ?? throw new HubException($"Tile '{tile.Title}' has no query.")
            : Compose(tile.Expression, tile.OrderBy, filters.Select(f => f.Clause).ToList());

    public static string Compose(string expression, string? orderBy, IReadOnlyList<string> filterClauses)
    {
        var sb = new StringBuilder("EVALUATE\n");
        if (filterClauses.Count == 0) sb.Append(expression);
        else
        {
            sb.Append("CALCULATETABLE(\n    ").Append(expression.ReplaceLineEndings("\n    "));
            foreach (var f in filterClauses) sb.Append(",\n    ").Append(f);
            sb.Append("\n)");
        }
        if (!string.IsNullOrWhiteSpace(orderBy)) sb.Append("\nORDER BY ").Append(orderBy);
        return sb.ToString();
    }

    /// <summary>Validates browser filters against the schema and builds TREATAS clauses. Empty value lists are ignored.</summary>
    public static List<AppliedFilter> BuildFilters(ModelSchema schema, IEnumerable<FilterValue>? filters)
    {
        var result = new List<AppliedFilter>();
        foreach (var f in filters ?? [])
        {
            if (f?.Values is not { Count: > 0 } values) continue;
            if (result.Count >= MaxFilters) throw new HubValidationException($"At most {MaxFilters} filters can be applied at once.");
            if (values.Count > MaxValuesPerFilter) throw new HubValidationException($"A filter can hold at most {MaxValuesPerFilter} values.");

            var col = FindColumn(schema, f.Table, f.Column);
            var literals = new List<string>();
            var display = new List<object?>();
            foreach (var v in values)
            {
                var (lit, shown) = Literal(col, v);
                literals.Add(lit);
                display.Add(shown);
            }
            result.Add(new AppliedFilter(col, $"TREATAS({{{string.Join(", ", literals)}}}, {ColumnRef(col)})", display));
        }
        return result;
    }

    public static ColumnInfo FindColumn(ModelSchema schema, string? table, string? column)
    {
        var col = schema.Columns.FirstOrDefault(c =>
            string.Equals(c.Table, table, StringComparison.OrdinalIgnoreCase) && string.Equals(c.Name, column, StringComparison.OrdinalIgnoreCase));
        var hiddenTable = schema.Tables.Any(t => t.IsHidden && t.Name == col?.Table);
        if (col is null || col.IsHidden || hiddenTable)
            throw new HubValidationException($"'{table}'[{column}] is not a visible column of this model.");
        return col;
    }

    public static string ColumnRef(ColumnInfo c) => $"{SchemaText.TableRef(c.Table)}[{c.Name.Replace("]", "]]")}]";

    /// <summary>A JSON value as a DAX literal of the column's type. Anything that doesn't fit the type is rejected.</summary>
    public static (string Literal, object? Display) Literal(ColumnInfo col, JsonElement v)
    {
        if (v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return ("BLANK()", null);
        var bad = new HubValidationException($"'{v.GetRawText()}' is not a valid value for {col.Name} ({col.DataType}).");

        switch (Kind(col.DataType))
        {
            case ValueKind.Text:
                if (v.ValueKind != JsonValueKind.String) throw bad;
                var s = v.GetString()!;
                if (s.Length > 500 || s.Contains('\0')) throw bad;
                return ($"\"{s.Replace("\"", "\"\"")}\"", s);

            case ValueKind.Integer:
                if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var l)) return (l.ToString(CultureInfo.InvariantCulture), l);
                if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out l))
                    return (l.ToString(CultureInfo.InvariantCulture), l);
                throw bad;

            case ValueKind.Number:
                double d;
                if (v.ValueKind == JsonValueKind.Number) d = v.GetDouble();
                else if (v.ValueKind != JsonValueKind.String || !double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out d)) throw bad;
                if (!double.IsFinite(d)) throw bad;
                return (d.ToString("R", CultureInfo.InvariantCulture), d);

            case ValueKind.Date:
                if (v.ValueKind != JsonValueKind.String ||
                    !DateTime.TryParse(v.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind | DateTimeStyles.AllowWhiteSpaces, out var dt))
                    throw bad;
                var date = $"DATE({dt.Year}, {dt.Month}, {dt.Day})";
                return (dt.TimeOfDay == TimeSpan.Zero ? date : $"{date} + TIME({dt.Hour}, {dt.Minute}, {dt.Second})", v.GetString());

            case ValueKind.Boolean:
                if (v.ValueKind == JsonValueKind.True) return ("TRUE()", true);
                if (v.ValueKind == JsonValueKind.False) return ("FALSE()", false);
                throw bad;
        }
        throw bad;
    }

    private enum ValueKind { Text, Integer, Number, Date, Boolean }

    private static ValueKind Kind(string? dataType) => (dataType ?? "").ToLowerInvariant() switch
    {
        "integer" or "int64" or "whole number" => ValueKind.Integer,
        "number" or "double" or "decimal" or "currency" or "decimal number" or "fixed decimal number" => ValueKind.Number,
        "date" or "datetime" or "date/time" or "time" => ValueKind.Date,
        "true/false" or "boolean" => ValueKind.Boolean,
        _ => ValueKind.Text,
    };

    /// <summary>Measures and columns an expression references, matched against the schema (never trusted as text).</summary>
    public static (List<MeasureInfo> Measures, List<ColumnInfo> Columns) References(ModelSchema schema, string? expression)
    {
        if (string.IsNullOrWhiteSpace(expression)) return ([], []);
        var cols = new List<ColumnInfo>();
        foreach (Match m in ColumnRefPattern().Matches(expression))
        {
            var table = m.Groups[1].Success ? m.Groups[1].Value.Replace("''", "'") : m.Groups[2].Value;
            var name = m.Groups[3].Value.Replace("]]", "]");
            var col = schema.Columns.FirstOrDefault(c => string.Equals(c.Table, table, StringComparison.OrdinalIgnoreCase) && string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase));
            if (col is not null && !cols.Contains(col)) cols.Add(col);
        }
        // Bare [Name] references that are not part of a column reference.
        var withoutColumns = ColumnRefPattern().Replace(expression, " ");
        var measures = new List<MeasureInfo>();
        foreach (Match m in BareRefPattern().Matches(withoutColumns))
        {
            var name = m.Groups[1].Value.Replace("]]", "]");
            var measure = schema.Measures.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            if (measure is not null && !measures.Contains(measure)) measures.Add(measure);
        }
        return (measures, cols);
    }

    private static int SkipQuoted(string s, int i, char q)
    {
        for (i++; i < s.Length; i++)
        {
            if (s[i] != q) continue;
            if (i + 1 < s.Length && s[i + 1] == q) { i++; continue; }
            return i;
        }
        return s.Length;
    }

    private static int SkipBracket(string s, int i)
    {
        for (i++; i < s.Length; i++)
        {
            if (s[i] != ']') continue;
            if (i + 1 < s.Length && s[i + 1] == ']') { i++; continue; }
            return i;
        }
        return s.Length;
    }

    private static bool IsIdentChar(char c) => char.IsLetterOrDigit(c) || c is '_' or '.';

    [GeneratedRegex(@"^EVALUATE\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex EvaluateKeyword();

    [GeneratedRegex(@"\G(ORDER\s+BY|EVALUATE|DEFINE)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TopLevelKeyword();

    [GeneratedRegex(@"(?:'((?:[^']|'')+)'|\b([A-Za-z_][A-Za-z0-9_]*))\[((?:[^\]]|\]\])+)\]")]
    private static partial Regex ColumnRefPattern();

    [GeneratedRegex(@"\[((?:[^\]]|\]\])+)\]")]
    private static partial Regex BareRefPattern();
}
