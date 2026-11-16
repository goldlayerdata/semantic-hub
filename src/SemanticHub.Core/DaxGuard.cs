using System.Text;
using System.Text.RegularExpressions;

namespace SemanticHub.Core;

/// <summary>
/// Read-only gate for every query the hub sends. A query must be a DAX query (starts with EVALUATE or DEFINE once
/// comments and whitespace are removed). XMLA/TMSL commands, DMVs and MDX never pass.
/// This is a second line of defence: the connecting identity should only have Read/Build.
/// </summary>
public static partial class DaxGuard
{
    public const int MaxQueryLength = 20_000;

    public sealed record Verdict(bool Ok, string? Error, string Query);

    public static Verdict Check(string? query)
    {
        if (string.IsNullOrWhiteSpace(query))
            return new(false, "Query is empty.", "");
        if (query.Length > MaxQueryLength)
            return new(false, $"Query is longer than {MaxQueryLength} characters.", "");
        if (query.Contains('\0'))
            return new(false, "Query contains a null character.", "");

        var stripped = StripComments(query).Trim();
        if (stripped.Length == 0)
            return new(false, "Query contains only comments.", "");

        // First token must be EVALUATE or DEFINE (case-insensitive, word boundary).
        if (!StartsWithKeyword().IsMatch(stripped))
            return new(false, "Only read-only DAX queries are allowed: the query must start with EVALUATE or DEFINE.", "");

        // DEFINE blocks must still contain an EVALUATE to return anything.
        if (!HasEvaluate().IsMatch(stripped))
            return new(false, "A DEFINE query must contain EVALUATE.", "");

        return new(true, null, query.Trim());
    }

    /// <summary>Removes // and -- line comments and /* */ block comments, leaving string literals intact.</summary>
    public static string StripComments(string s)
    {
        var sb = new StringBuilder(s.Length);
        int i = 0;
        while (i < s.Length)
        {
            char c = s[i];
            char n = i + 1 < s.Length ? s[i + 1] : '\0';

            if (c == '"')                                  // DAX string literal; "" escapes a quote
            {
                int start = i++;
                while (i < s.Length)
                {
                    if (s[i] == '"' && i + 1 < s.Length && s[i + 1] == '"') { i += 2; continue; }
                    if (s[i] == '"') { i++; break; }
                    i++;
                }
                sb.Append(s, start, i - start);
                continue;
            }
            if (c == '\'' )                                // quoted table name; '' escapes
            {
                int start = i++;
                while (i < s.Length)
                {
                    if (s[i] == '\'' && i + 1 < s.Length && s[i + 1] == '\'') { i += 2; continue; }
                    if (s[i] == '\'') { i++; break; }
                    i++;
                }
                sb.Append(s, start, i - start);
                continue;
            }
            if ((c == '/' && n == '/') || (c == '-' && n == '-'))
            {
                while (i < s.Length && s[i] != '\n') i++;
                sb.Append(' ');
                continue;
            }
            if (c == '/' && n == '*')
            {
                i += 2;
                while (i < s.Length && !(s[i] == '*' && i + 1 < s.Length && s[i + 1] == '/')) i++;
                i = Math.Min(i + 2, s.Length);
                sb.Append(' ');
                continue;
            }
            sb.Append(c);
            i++;
        }
        return sb.ToString();
    }

    [GeneratedRegex(@"^(EVALUATE|DEFINE)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex StartsWithKeyword();

    [GeneratedRegex(@"\bEVALUATE\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex HasEvaluate();
}
