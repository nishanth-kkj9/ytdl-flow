using System.Diagnostics;
using System.Text.Json;

namespace YtdlFlow.Desktop.Services;

public sealed class BackendSupervisor : IAsyncDisposable
{
    private Process? _process;
    private string? _backendAddress;

    public string? BackendAddress => _backendAddress;

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_process is not null && !_process.HasExited)
        {
            return;
        }

        var scriptPath = GetBackendScriptPath();
        var startInfo = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = $"\"{scriptPath}\"",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(scriptPath) ?? Directory.GetCurrentDirectory(),
        };

        _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        _process.Start();

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);

        var outputBuilder = new List<string>();
        while (!linked.IsCancellationRequested)
        {
            if (_process.HasExited)
            {
                throw new InvalidOperationException($"The local backend exited before reporting readiness. Error: {await ReadRemainingAsync(_process.StandardError)}");
            }

            var line = await _process.StandardOutput.ReadLineAsync();
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            outputBuilder.Add(line);
            if (!line.Contains("ready", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var payload = JsonSerializer.Deserialize<BackendStartupMessage>(line);
            if (!string.IsNullOrWhiteSpace(payload?.Address))
            {
                _backendAddress = payload.Address;
                return;
            }
        }

        throw new TimeoutException("The local backend did not report a valid ready message in time.");
    }

    public async Task StopAsync()
    {
        if (_process is null || _process.HasExited)
        {
            return;
        }

        _process.Kill(entireProcessTree: true);
        await _process.WaitForExitAsync();
        _process.Dispose();
        _process = null;
        _backendAddress = null;
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
    }

    private static async Task<string> ReadRemainingAsync(StreamReader reader)
    {
        var remaining = await reader.ReadToEndAsync();
        return remaining;
    }

    private static string GetBackendScriptPath()
    {
        var baseDirectory = AppContext.BaseDirectory;
        var repoRoot = Path.GetFullPath(Path.Combine(baseDirectory, "..", "..", "..", "..", "..", "..", "..", ".."));
        var scriptPath = Path.Combine(repoRoot, "desktop", "backend-runner-stdio.mjs");
        if (!File.Exists(scriptPath))
        {
            throw new FileNotFoundException("Could not locate desktop/backend-runner-stdio.mjs.", scriptPath);
        }

        return scriptPath;
    }

    private sealed class BackendStartupMessage
    {
        public string? Address { get; set; }
    }
}
