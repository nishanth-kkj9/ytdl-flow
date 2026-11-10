using System.Text;
using YtdlFlow.Desktop.Services;
using Xunit;

namespace YtdlFlow.Desktop.Tests;

public sealed class EngineEventClientTests
{
    [Fact]
    public async Task CorrelatesProbeResultsThatArriveBeforeTheRequestIdIsObserved()
    {
        await using var client = new EngineEventClient();
        client.DispatchMessage(Encoding.UTF8.GetBytes(
            """{"type":"probe_result","payload":{"id":"probe-1","success":true,"info":{"title":"Test video"}}}"""));

        var result = await client.WaitForProbeResultAsync(
            "probe-1",
            TimeSpan.FromSeconds(1));

        Assert.Equal("probe-1", result.Id);
        Assert.True(result.Success);
        Assert.Equal("Test video", result.Info?.GetProperty("title").GetString());
    }

    [Fact]
    public async Task CorrelatesConcurrentProbeRequestsById()
    {
        await using var client = new EngineEventClient();
        var first = client.WaitForProbeResultAsync("first", TimeSpan.FromSeconds(1));
        var second = client.WaitForProbeResultAsync("second", TimeSpan.FromSeconds(1));
        client.DispatchMessage(Encoding.UTF8.GetBytes(
            """{"type":"probe_result","payload":{"id":"second","success":true,"info":{"title":"Second"}}}"""));
        client.DispatchMessage(Encoding.UTF8.GetBytes(
            """{"type":"probe_result","payload":{"id":"first","success":false,"error":"failed"}}"""));

        Assert.Equal("first", (await first).Id);
        Assert.Equal("second", (await second).Id);
    }

    [Fact]
    public async Task ProbeWaitSupportsTimeoutAndCancellation()
    {
        await using var client = new EngineEventClient();
        await Assert.ThrowsAsync<TimeoutException>(
            () => client.WaitForProbeResultAsync("late", TimeSpan.FromMilliseconds(50)));

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => client.WaitForProbeResultAsync(
                "cancelled",
                TimeSpan.FromSeconds(1),
                cancellation.Token));
    }

    [Fact]
    public async Task LogsUnknownEventsWithoutCrashingAndRejectsMalformedEnvelopes()
    {
        await using var client = new EngineEventClient();
        client.DispatchMessage(Encoding.UTF8.GetBytes(
            """{"type":"future_event","payload":{}}"""));

        Assert.Contains("future_event", client.DiagnosticLog);
        Assert.Throws<InvalidDataException>(
            () => client.DispatchMessage(Encoding.UTF8.GetBytes("""{"type":"progress"}""")));
    }
}
