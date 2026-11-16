using System.Text;

namespace SemanticHub.Core;

/// <summary>Compact, deterministic text rendering of a schema for prompts (stable output keeps the prompt cache warm).</summary>
public static class SchemaText
{
    public static string MeasureRef(string name) => $"[{name.Replace("]", "]]")}]";
    public static string TableRef(string name) => $"'{name.Replace("'", "''")}'";

    public static string Render(HubModel model, ModelSchema schema, int maxExpressionChars = 300)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Model id: {model.Id}");
        sb.AppendLine($"Model name: {model.Name}");
        sb.AppendLine();

        if (schema.Profile.Count > 0)
        {
            sb.AppendLine($"## Data profile (measured {schema.HarvestedAt:yyyy-MM-dd})");
            foreach (var line in schema.Profile) sb.AppendLine($"- {line}");
            sb.AppendLine();
        }

        sb.AppendLine("## Measures (prefer these over raw aggregation)");
        foreach (var m in schema.Measures.Where(m => !m.IsHidden).OrderBy(m => m.Table).ThenBy(m => m.Name, StringComparer.Ordinal))
        {
            sb.Append($"- {MeasureRef(m.Name)} (home table {TableRef(m.Table)}");
            if (!string.IsNullOrEmpty(m.DataType)) sb.Append($", {m.DataType}");
            if (!string.IsNullOrEmpty(m.FormatString)) sb.Append($", format \"{m.FormatString}\"");
            sb.Append(')');
            if (!string.IsNullOrWhiteSpace(m.Description)) sb.Append($": {OneLine(m.Description)}");
            sb.AppendLine();
            if (!string.IsNullOrWhiteSpace(m.Expression))
                sb.AppendLine($"    = {Truncate(OneLine(m.Expression), maxExpressionChars)}");
        }
        sb.AppendLine();

        sb.AppendLine("## Tables and columns");
        foreach (var t in schema.Tables.Where(t => !t.IsHidden).OrderBy(t => t.Name, StringComparer.Ordinal))
        {
            sb.Append($"### {TableRef(t.Name)}");
            if (!string.IsNullOrEmpty(t.DataCategory) && t.DataCategory != "Regular") sb.Append($" [{t.DataCategory}]");
            if (!string.IsNullOrWhiteSpace(t.Description)) sb.Append($" — {OneLine(t.Description)}");
            sb.AppendLine();
            foreach (var c in schema.Columns.Where(c => c.Table == t.Name && !c.IsHidden).OrderBy(c => c.Name, StringComparer.Ordinal))
            {
                sb.Append($"- {TableRef(t.Name)}[{c.Name}] {c.DataType}");
                if (!string.IsNullOrWhiteSpace(c.Description)) sb.Append($": {OneLine(c.Description)}");
                sb.AppendLine();
            }
        }
        sb.AppendLine();

        sb.AppendLine("## Relationships (many → one)");
        foreach (var r in schema.Relationships.OrderBy(r => r.FromTable).ThenBy(r => r.FromColumn))
        {
            sb.Append($"- {TableRef(r.FromTable)}[{r.FromColumn}] ({r.FromCardinality}) → {TableRef(r.ToTable)}[{r.ToColumn}] ({r.ToCardinality})");
            if (!r.IsActive) sb.Append(" INACTIVE (use USERELATIONSHIP)");
            if (r.CrossFilter is { } cf && cf != "OneDirection") sb.Append($" cross-filter {cf}");
            sb.AppendLine();
        }
        return sb.ToString();
    }

    private static string OneLine(string s) => string.Join(' ', s.Split((char[])['\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries)).Trim();
    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}
