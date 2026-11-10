using System.Text;
using YtdlFlow.Desktop.Services;
using Xunit;

namespace YtdlFlow.Desktop.Tests;

public sealed class BackendSupervisorTests
{
    [Fact]
    public void DiscoversRepositoryRootFromNestedDirectory()
    {
        using var repository = new TestRepository();

        var root = BackendSupervisor.DiscoverRepositoryRoot(repository.NestedDirectory);

        Assert.Equal(repository.Root, root);
    }

    [Fact]
    public void UsesAndValidatesExplicitRepositoryRoot()
    {
        using var repository = new TestRepository();

        Assert.Equal(
            repository.Root,
            BackendSupervisor.DiscoverRepositoryRoot(Path.GetTempPath(), repository.Root));
        Assert.Throws<DirectoryNotFoundException>(
            () => BackendSupervisor.DiscoverRepositoryRoot(Path.GetTempPath(), Path.GetTempPath()));
    }

    [Fact]
    public void ResolvesConfiguredAndPathNodeExecutablesToAbsolutePaths()
    {
        using var directory = new TemporaryDirectory();
        var configured = Path.Combine(directory.Path, "configured-node.exe");
        var fromPath = Path.Combine(directory.Path, "node.exe");
        File.WriteAllText(configured, string.Empty);
        File.WriteAllText(fromPath, string.Empty);

        Assert.Equal(configured, BackendSupervisor.ResolveNodeExecutable(configured));
        Assert.Equal(
            fromPath,
            BackendSupervisor.ResolveNodeExecutable(pathValue: directory.Path),
            StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void ParsesLowercaseDynamicReadinessAddressAndRejectsRemoteEndpoints()
    {
        var endpoint = BackendSupervisor.ParseReadyMessage(
            """{"type":"ready","address":"http://127.0.0.1:49173"}""");

        Assert.NotNull(endpoint);
        Assert.Equal(49173, endpoint.Port);
        Assert.Throws<InvalidDataException>(() =>
            BackendSupervisor.ParseReadyMessage(
                """{"type":"ready","Address":"http://127.0.0.1:49173"}"""));
        Assert.Throws<InvalidDataException>(() =>
            BackendSupervisor.ParseReadyMessage(
                """{"type":"ready","address":"http://example.com:49173"}"""));
        Assert.Throws<InvalidDataException>(() =>
            BackendSupervisor.ParseReadyMessage(
                """{"type":"ready","address":"https://127.0.0.1:49173"}"""));
    }

    [Fact]
    public async Task StartsWithDynamicEndpointAndDrainsBoundedProcessOutput()
    {
        using var repository = new TestRepository();
        repository.WriteRunner(CreateReadyRunner(writeOutput: true));
        await using var supervisor = repository.CreateSupervisor();

        var endpoint = await supervisor.StartAsync(repository.DownloadDirectory);

        Assert.Equal("http", endpoint.Scheme);
        Assert.Equal("127.0.0.1", endpoint.Host);
        Assert.InRange(endpoint.Port, 1, 65535);
        await WaitUntilAsync(() => supervisor.DiagnosticOutput.Contains(
            repository.DownloadDirectory,
            StringComparison.OrdinalIgnoreCase));
        Assert.True(supervisor.DiagnosticOutput.Length <= 8192);
        Assert.Contains(repository.DownloadDirectory, supervisor.DiagnosticOutput);

        await supervisor.StopAsync();

        Assert.False(supervisor.LastShutdownWasForced);
        Assert.Null(supervisor.BackendAddress);
    }

    [Fact]
    public async Task ConcurrentStartAndStopRequestsAreIdempotent()
    {
        using var repository = new TestRepository();
        repository.WriteRunner(CreateReadyRunner());
        await using var supervisor = repository.CreateSupervisor();

        var endpoints = await Task.WhenAll(
            supervisor.StartAsync(repository.DownloadDirectory),
            supervisor.StartAsync(repository.DownloadDirectory));
        Assert.Equal(endpoints[0], endpoints[1]);

        await Task.WhenAll(supervisor.StopAsync(), supervisor.StopAsync());
        Assert.Null(supervisor.BackendAddress);
    }

    [Fact]
    public async Task TimesOutWhenTheRunnerKeepsStdoutSilent()
    {
        using var repository = new TestRepository();
        repository.WriteRunner("setInterval(() => {}, 1000);");
        await using var supervisor = repository.CreateSupervisor(startupTimeout: TimeSpan.FromMilliseconds(150));

        await Assert.ThrowsAsync<TimeoutException>(
            () => supervisor.StartAsync(repository.DownloadDirectory));

        Assert.Null(supervisor.BackendAddress);
    }

    [Fact]
    public async Task DetectsEarlyChildExit()
    {
        using var repository = new TestRepository();
        repository.WriteRunner("console.error('runner failed early'); process.exit(7);");
        await using var supervisor = repository.CreateSupervisor();

        var error = await Assert.ThrowsAnyAsync<Exception>(
            () => supervisor.StartAsync(repository.DownloadDirectory));

        Assert.Contains("exited", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("runner failed early", supervisor.DiagnosticOutput);
    }

    [Fact]
    public async Task ClearsEndpointWhenTheBackendExitsAfterReadiness()
    {
        using var repository = new TestRepository();
        repository.WriteRunner(CreateReadyRunner(exitAfterMilliseconds: 100));
        await using var supervisor = repository.CreateSupervisor();
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        supervisor.BackendExited += (_, _) => exited.TrySetResult();

        await supervisor.StartAsync(repository.DownloadDirectory);
        await exited.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Null(supervisor.BackendAddress);
    }

    [Fact]
    public async Task ForcesShutdownOnlyAfterGracefulTimeout()
    {
        using var repository = new TestRepository();
        repository.WriteRunner(CreateReadyRunner(ignoreShutdown: true));
        await using var supervisor = repository.CreateSupervisor(shutdownTimeout: TimeSpan.FromMilliseconds(150));
        await supervisor.StartAsync(repository.DownloadDirectory);

        await supervisor.StopAsync();

        Assert.True(supervisor.LastShutdownWasForced);
        Assert.Null(supervisor.BackendAddress);
    }

    [Fact]
    public void ReportsStructuredStartupErrorsAndMalformedJson()
    {
        var startupError = Assert.Throws<InvalidOperationException>(
            () => BackendSupervisor.ParseReadyMessage(
                """{"type":"startup-error","message":"bind failed"}"""));
        Assert.Contains("bind failed", startupError.Message);

        Assert.ThrowsAny<Exception>(
            () => BackendSupervisor.ParseReadyMessage("{not-json"));
    }

    private static string CreateReadyRunner(
        bool writeOutput = false,
        bool ignoreShutdown = false,
        int? exitAfterMilliseconds = null)
    {
        var output = writeOutput
            ? """
              for (let index = 0; index < 1200; index++) {
                process.stdout.write(JSON.stringify({ type: "diagnostic", index }) + "\n");
                process.stderr.write(`diagnostic ${index} ${"x".repeat(300)}\n`);
              }
              console.error(process.env.YTDL_DOWNLOADS_DIR);
              """
            : "";
        var shutdown = ignoreShutdown
            ? ""
            : "server.close(() => process.exit(0));";
        var exitAfterReady = exitAfterMilliseconds is { } delay
            ? $"setTimeout(() => process.exit(3), {delay});"
            : "";

        return $$"""
            import net from "node:net";
            import readline from "node:readline";
            const server = net.createServer();
            server.listen(0, "127.0.0.1", () => {
              {{output}}
              process.stdout.write(JSON.stringify({
                type: "ready",
                address: `http://127.0.0.1:${server.address().port}`
              }) + "\n");
              {{exitAfterReady}}
            });
            const input = readline.createInterface({ input: process.stdin });
            input.on("line", (line) => {
              if (JSON.parse(line).type === "shutdown") {
                {{shutdown}}
              }
            });
            """;
    }

    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!predicate())
        {
            await Task.Delay(20, timeout.Token);
        }
    }

    private sealed class TestRepository : IDisposable
    {
        private readonly TemporaryDirectory _directory = new();
        private readonly SettingsService _settingsService;

        public TestRepository()
        {
            Root = _directory.Path;
            NestedDirectory = Path.Combine(Root, "desktop", "windows", "bin");
            Directory.CreateDirectory(NestedDirectory);
            Directory.CreateDirectory(Path.Combine(Root, "web"));
            Directory.CreateDirectory(Path.Combine(Root, "desktop"));
            Directory.CreateDirectory(Path.Combine(Root, "python-engine"));
            File.WriteAllText(Path.Combine(Root, "web", "server.mjs"), string.Empty);
            File.WriteAllText(Path.Combine(Root, "desktop", "backend-runner-stdio.mjs"), string.Empty);
            File.WriteAllText(Path.Combine(Root, "package.json"), "{}");
            DownloadDirectory = Path.Combine(Root, "downloads");
            _settingsService = new SettingsService(Path.Combine(Root, "app-data"));
        }

        public string Root { get; }

        public string NestedDirectory { get; }

        public string DownloadDirectory { get; }

        public void WriteRunner(string source) =>
            File.WriteAllText(Path.Combine(Root, "desktop", "backend-runner-stdio.mjs"), source);

        public BackendSupervisor CreateSupervisor(
            TimeSpan? startupTimeout = null,
            TimeSpan? shutdownTimeout = null) =>
            new(_settingsService, startupTimeout, shutdownTimeout, NestedDirectory);

        public void Dispose() => _directory.Dispose();
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "ytdl-flow-desktop-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, recursive: true);
            }
        }
    }
}
