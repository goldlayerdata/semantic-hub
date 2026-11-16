using SemanticHub.Agent;

namespace SemanticHub.Tests;

public class ThinkTagFilterTests
{
    [Fact]
    public void Separates_reasoning_split_across_chunks()
    {
        var f = new ThinkTagFilter();
        string visible = "", thought = "";
        foreach (var chunk in new[] { "<thi", "nk>plan the ", "query</th", "ink>Revenue was ", "150M." })
        {
            var (v, t) = f.Push(chunk);
            visible += v; thought += t;
        }
        var (rv, rt) = f.Flush();
        visible += rv; thought += rt;

        Assert.Equal("Revenue was 150M.", visible);
        Assert.Equal("plan the query", thought);
    }

    [Fact]
    public void Leaves_plain_text_and_lone_angle_brackets_alone()
    {
        Assert.Equal("a < b and <b>bold</b>", ThinkTagFilter.Strip("a < b and <b>bold</b>"));
        Assert.Equal("{\"title\":\"x\"}", ThinkTagFilter.Strip("<think>{ not json }</think>{\"title\":\"x\"}"));
    }
}
