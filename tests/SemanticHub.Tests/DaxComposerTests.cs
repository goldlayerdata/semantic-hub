using System.Text.Json;
using SemanticHub.Core;

namespace SemanticHub.Tests;

public class DaxComposerTests
{
    private static readonly ModelSchema Schema = new()
    {
        Tables = [new("sales", null, false, null), new("date", null, false, "Time"), new("product", null, false, null), new("secret", null, true, null)],
        Columns =
        [
            new("date", "Year", "Integer", null, false, null),
            new("date", "Date", "Date", null, false, null),
            new("product", "Category", "Text", "Product category", false, null),
            new("product", "Is Active", "True/False", null, false, null),
            new("sales", "Amount", "Currency", null, false, null),
            new("sales", "CustomerKey", "Integer", null, true, null),
            new("secret", "Name", "Text", null, false, null),
        ],
        Measures = [new("sales", "Revenue", "SUM(sales[Amount])", "Currency", null, "Total revenue", false, null), new("sales", "Margin %", "DIVIDE(1,2)", null, null, null, false, null)],
    };

    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement.Clone();
    private static FilterValue F(string table, string column, string valuesJson) => new(table, column, JsonSerializer.Deserialize<List<JsonElement>>(valuesJson));

    [Fact]
    public void Split_separates_expression_and_order_by()
    {
        var s = DaxComposer.Split("EVALUATE\n  SUMMARIZECOLUMNS('date'[Year], \"Revenue\", [Revenue])\nORDER BY 'date'[Year] ASC");
        Assert.NotNull(s);
        Assert.Equal("SUMMARIZECOLUMNS('date'[Year], \"Revenue\", [Revenue])", s!.Expression);
        Assert.Equal("'date'[Year] ASC", s.OrderBy);
    }

    [Theory]
    [InlineData("EVALUATE FILTER('product', 'product'[Category] = \"ORDER BY x\")")]       // in a string
    [InlineData("EVALUATE SELECTCOLUMNS('t', \"a\", 't'[ORDER BY])")]                     // in a column name
    [InlineData("EVALUATE TOPN(5, VALUES('t'[c]), 't'[c]) // ORDER BY nothing")]           // in a comment
    public void Split_ignores_order_by_that_is_not_top_level(string query)
    {
        var s = DaxComposer.Split(query);
        Assert.NotNull(s);
        Assert.Null(s!.OrderBy);
    }

    [Theory]
    [InlineData("DEFINE MEASURE 'sales'[x] = 1 EVALUATE ROW(\"x\", [x])")]
    [InlineData("EVALUATE 'a' EVALUATE 'b'")]
    [InlineData("EVALUATE ROW(\"x\", 1))")]
    [InlineData("EVALUATE (ROW(\"x\", 1)")]
    [InlineData("EVALUATE ROW(\"x\", 1) ORDER BY")]
    [InlineData("SELECT 1")]
    public void Split_refuses_queries_it_cannot_wrap(string query) => Assert.Null(DaxComposer.Split(query));

    [Fact]
    public void Normalize_keeps_define_queries_as_fixed_tiles()
    {
        var t = DaxComposer.Normalize(new DashboardTile { Id = "a", Title = "A", Kind = "kpi", Dax = "DEFINE VAR x = 1 EVALUATE ROW(\"x\", x)" });
        Assert.False(t.Filterable);
        Assert.NotNull(t.Dax);
        Assert.Equal(t.Dax, DaxComposer.TileQuery(t, DaxComposer.BuildFilters(Schema, [F("date", "Year", "[2024]")])));
    }

    [Fact]
    public void Compose_wraps_the_expression_with_treatas_filters()
    {
        var filters = DaxComposer.BuildFilters(Schema, [F("date", "Year", "[2023, 2024]"), F("product", "Category", "[\"Audio\"]")]);
        var q = DaxComposer.Compose("ROW(\"Value\", [Revenue])", null, filters.Select(f => f.Clause).ToList());
        Assert.StartsWith("EVALUATE\nCALCULATETABLE(", q);
        Assert.Contains("TREATAS({2023, 2024}, 'date'[Year])", q);
        Assert.Contains("TREATAS({\"Audio\"}, 'product'[Category])", q);
        Assert.True(DaxGuard.Check(q).Ok);
    }

    [Fact]
    public void Compose_without_filters_is_the_plain_query()
    {
        Assert.Equal("EVALUATE\n'sales'\nORDER BY 'sales'[Amount]", DaxComposer.Compose("'sales'", "'sales'[Amount]", []));
    }

    [Fact]
    public void Text_values_are_escaped_as_string_literals()
    {
        var col = Schema.Columns.Single(c => c.Name == "Category");
        var (lit, _) = DaxComposer.Literal(col, J("\"x\\\"}, 'sales'[Amount]) EVALUATE 'secret' //\""));
        Assert.Equal("\"x\"\"}, 'sales'[Amount]) EVALUATE 'secret' //\"", lit);
    }

    [Theory]
    [InlineData("Year", "2024", "2024")]
    [InlineData("Year", "\"2024\"", "2024")]
    [InlineData("Amount", "12.5", "12.5")]
    [InlineData("Date", "\"2024-03-01T00:00:00\"", "DATE(2024, 3, 1)")]
    [InlineData("Date", "\"2024-03-01T10:30:00\"", "DATE(2024, 3, 1) + TIME(10, 30, 0)")]
    [InlineData("Is Active", "true", "TRUE()")]
    [InlineData("Category", "null", "BLANK()")]
    public void Values_become_typed_literals(string column, string json, string expected)
    {
        var col = Schema.Columns.Single(c => c.Name == column);
        Assert.Equal(expected, DaxComposer.Literal(col, J(json)).Literal);
    }

    [Theory]
    [InlineData("Year", "\"2024) EVALUATE 'secret'\"")]
    [InlineData("Year", "12.5")]
    [InlineData("Amount", "\"NaN\"")]
    [InlineData("Date", "\"yesterday\"")]
    [InlineData("Is Active", "\"TRUE()\"")]
    [InlineData("Category", "42")]
    [InlineData("Category", "{\"a\":1}")]
    public void Values_that_do_not_fit_the_column_type_are_rejected(string column, string json)
    {
        var col = Schema.Columns.Single(c => c.Name == column);
        Assert.Throws<HubValidationException>(() => DaxComposer.Literal(col, J(json)));
    }

    [Theory]
    [InlineData("date", "Year]) EVALUATE 'secret' //")]
    [InlineData("sales", "CustomerKey")]   // hidden column
    [InlineData("secret", "Name")]         // column of a hidden table
    [InlineData("nope", "Year")]
    public void Filters_on_unknown_or_hidden_columns_are_rejected(string table, string column) =>
        Assert.Throws<HubValidationException>(() => DaxComposer.BuildFilters(Schema, [F(table, column, "[1]")]));

    [Fact]
    public void Filter_names_are_matched_case_insensitively_and_canonicalised()
    {
        var f = DaxComposer.BuildFilters(Schema, [F("DATE", "year", "[2024]")]).Single();
        Assert.Equal("TREATAS({2024}, 'date'[Year])", f.Clause);
    }

    [Fact]
    public void Empty_filters_are_ignored_and_limits_enforced()
    {
        Assert.Empty(DaxComposer.BuildFilters(Schema, [F("date", "Year", "[]")]));
        var many = "[" + string.Join(",", Enumerable.Range(0, DaxComposer.MaxValuesPerFilter + 1)) + "]";
        Assert.Throws<HubValidationException>(() => DaxComposer.BuildFilters(Schema, [F("date", "Year", many)]));
    }

    [Fact]
    public void References_are_matched_against_the_schema()
    {
        var (measures, columns) = DaxComposer.References(Schema,
            "TOPN(10, SUMMARIZECOLUMNS('product'[Category], \"Revenue\", [Revenue], \"M\", [Margin %], \"X\", [Not A Measure]), [Revenue], DESC)");
        Assert.Equal(["Revenue", "Margin %"], measures.Select(m => m.Name));
        Assert.Equal(["Category"], columns.Select(c => c.Name));
    }
}
