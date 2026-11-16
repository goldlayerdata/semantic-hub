using SemanticHub.Core;

namespace SemanticHub.Tests;

public class DaxGuardTests
{
    [Theory]
    [InlineData("EVALUATE ROW(\"x\", 1)")]
    [InlineData("  evaluate 'sales'")]
    [InlineData("DEFINE MEASURE sales[x] = 1 EVALUATE ROW(\"x\", [x])")]
    [InlineData("// top products\nEVALUATE TOPN(5, 'product')")]
    [InlineData("/* note */ -- more\nEVALUATE 'date'")]
    [InlineData("EVALUATE FILTER('product', 'product'[Name] = \"DROP -- not a comment\")")]
    public void Allows_read_only_dax(string query) => Assert.True(DaxGuard.Check(query).Ok);

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("-- only a comment")]
    [InlineData("{ \"delete\": { \"object\": { \"database\": \"x\" } } }")]                      // TMSL
    [InlineData("{ \"refresh\": { \"type\": \"full\" } }")]
    [InlineData("<Batch xmlns=\"http://schemas.microsoft.com/analysisservices/2003/engine\"/>")]  // XMLA
    [InlineData("SELECT * FROM $SYSTEM.DBSCHEMA_CATALOGS")]                                       // DMV
    [InlineData("SELECT [Measures].[Revenue] ON 0 FROM [Model]")]                                // MDX
    [InlineData("CREATE MEMBER x AS 1")]
    [InlineData("/* EVALUATE */ { \"delete\": {} }")]                                            // keyword hidden in a comment
    [InlineData("-- EVALUATE\nSELECT 1")]
    [InlineData("EVALUATEX 'sales'")]                                                            // not a word boundary
    [InlineData("DEFINE MEASURE sales[x] = 1")]                                                  // DEFINE without EVALUATE
    public void Blocks_everything_else(string query)
    {
        var v = DaxGuard.Check(query);
        Assert.False(v.Ok);
        Assert.False(string.IsNullOrEmpty(v.Error));
    }

    [Fact]
    public void Blocks_null_and_oversized()
    {
        Assert.False(DaxGuard.Check(null).Ok);
        Assert.False(DaxGuard.Check("EVALUATE ROW(\"x\", \"" + new string('a', DaxGuard.MaxQueryLength) + "\")").Ok);
        Assert.False(DaxGuard.Check("EVALUATE\0 'sales'").Ok);
    }

    [Fact]
    public void StripComments_keeps_string_and_table_literals()
    {
        var s = DaxGuard.StripComments("EVALUATE 'my--table' /* gone */ WHERE \"a//b\" -- tail");
        Assert.Contains("'my--table'", s);
        Assert.Contains("\"a//b\"", s);
        Assert.DoesNotContain("gone", s);
        Assert.DoesNotContain("tail", s);
    }
}
