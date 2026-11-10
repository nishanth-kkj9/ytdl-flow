using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace YtdlFlow.Desktop.Services;

public sealed class BackendSupervisor : IAsyncDisposable
{
    private const int DiagnosticCapacity = 8192;
    private static readonly string[] RepositoryMarkers =
    [
        Path.Combine("web", "server.mjs"),
        Path.Combine("desktop", "backend-runner-stdio.mjs"),
        "package.json",
    ];

    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
    private readonly object _stateLock = new();
    private readonly StringBuilder _diagnostics = new();
    private readonly SettingsService _settingsService;
    private readonly TimeSpan _startupTimeout;
    private readonly TimeSpan _shutdownTimeout;
    private readonly string? _startDirectory;
    private Process? _process;
    private CancellationTokenSource? _readerCancellation;
    private Task? _stdoutDrain;
    private Task? _stderrDrain;
    private Task? _exitMonitor;
    private TaskCompletionSource<Uri>? _readiness;
    private Uri? _backendAddress;
    private bool _stopRequested;
    private bool _disposed;

    public BackendSupervisor(
        SettingsService? settingsService = null,
        TimeSpan? startupTimeout = null,
        TimeSpan? shutdownTimeout = null,
        string? startDirectory = null)
    {
        _settingsService = settingsService ?? new SettingsService();
        _startupTimeout = startupTimeout ?? TimeSpan.FromSeconds(30);
        _shutdownTimeout = shutdownTimeout ?? TimeSpan.FromSeconds(5);
        _startDirectory = startDirectory;
    }

    public Uri? BackendAddress
    {
        get
        {
            lock (_stateLock)
            {
                return _backendAddress;
            }
        }
    }

    public string DiagnosticOutput
    {
        get
        {
            lock (_stateLock)
            {
                return _diagnostics.ToString();
            }
        }
    }

    public bool LastShutdownWasForced { get; private set; }

    public event EventHandler? BackendExited;

    public async Task<Uri> StartAsync(
        string? downloadDirectory = null,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            if (_process is { HasExited: false } && BackendAddress is { } currentAddress)
            {
                return currentAddress;
            }

            if (_process is not null)
            {
                await StopProcessCoreAsync(graceful: false);
            }

            var root = DiscoverRepositoryRoot(_startDirectory);
            var scriptPath = Path.GetFullPath(Path.Combine(root, "desktop", "backend-runner-stdio.mjs"));
            var nodeExecutable = ResolveNodeExecutable(
                Environment.GetEnvironmentVariable("YTDL_NODE_EXECUTABLE"));
            var startInfo = new ProcessStartInfo
            {
                FileName = nodeExecutable,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = root,
            };
            startInfo.ArgumentList.Add(scriptPath);
            startInfo.ArgumentList.Add("0");
            foreach (var (key, value) in _settingsService.CreateBackendEnvironment(
                         root,
                         downloadDirectory ?? _settingsService.LoadDownloadDirectory()))
            {
                startInfo.Environment[key] = value;
            }

            var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            var readiness = new TaskCompletionSource<Uri>(TaskCreationOptions.RunContinuationsAsynchronously);
            var readerCancellation = new CancellationTokenSource();
            var processStarted = false;
            try
            {
                if (!process.Start())
                {
                    throw new InvalidOperationException("The Node backend process could not be started.");
                }

                processStarted = true;
                lock (_stateLock)
                {
                    _diagnostics.Clear();
                    _backendAddress = null;
                    _stopRequested = false;
                    _readiness = readiness;
                    _readerCancellation = readerCancellation;
                    _process = process;
                }

                _stdoutDrain = DrainStdoutAsync(process, readiness, readerCancellation.Token);
                _stderrDrain = DrainStderrAsync(process, readerCancellation.Token);
                _exitMonitor = MonitorExitAsync(process, readiness);

                var timeout = Task.Delay(_startupTimeout, cancellationToken);
                var completed = await Task.WhenAny(readiness.Task, _exitMonitor, timeout);
                if (completed == timeout)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    throw new TimeoutException(
                        $"The local backend did not report readiness within {_startupTimeout.TotalSeconds:0} seconds." +
                        DiagnosticSuffix());
                }

                var address = await readiness.Task;
                lock (_stateLock)
                {
                    if (ReferenceEquals(_process, process) && !process.HasExited)
                    {
                        _backendAddress = address;
                    }
                }

                return address;
            }
            catch (Exception startupError)
            {
                if (!processStarted)
                {
                    process.Dispose();
                    readerCancellation.Dispose();
                    throw;
                }

                try
                {
                    await StopProcessCoreAsync(graceful: false);
                }
                catch (Exception cleanupError)
                {
                    throw new AggregateException(
                        "Backend startup failed and its child process could not be cleaned up.",
                        startupError,
                        cleanupError);
                }

                throw;
            }
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            await StopProcessCoreAsync(graceful: true);
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        await StopAsync();
        _disposed = true;
        _lifecycleGate.Dispose();
    }

    internal static string DiscoverRepositoryRoot(
        string? startDirectory = null,
        string? configuredRoot = null)
    {
        var rootOverride = configuredRoot ?? Environment.GetEnvironmentVariable("YTDL_FLOW_ROOT");
        if (!string.IsNullOrWhiteSpace(rootOverride))
        {
            var resolvedOverride = Path.GetFullPath(rootOverride);
            ValidateRepositoryRoot(resolvedOverride);
            return resolvedOverride;
        }

        var current = new DirectoryInfo(Path.GetFullPath(startDirectory ?? AppContext.BaseDirectory));
        if (!current.Exists)
        {
            current = current.Parent ?? throw new DirectoryNotFoundException(
                $"Could not discover the repository root from '{startDirectory}'.");
        }

        for (var candidate = current; candidate is not null; candidate = candidate.Parent)
        {
            if (HasRepositoryMarkers(candidate.FullName))
            {
                return Path.GetFullPath(candidate.FullName);
            }
        }

        throw new DirectoryNotFoundException(
            $"Could not locate the YTDL Flow repository from '{current.FullName}'. Set YTDL_FLOW_ROOT to the repository root.");
    }

    internal static void ValidateRepositoryRoot(string root)
    {
        var missing = RepositoryMarkers
            .Select(marker => Path.Combine(root, marker))
            .Where(path => !File.Exists(path))
            .ToArray();
        if (missing.Length > 0)
        {
            throw new DirectoryNotFoundException(
                $"YTDL_FLOW_ROOT '{root}' is not a valid repository root; required files are missing: {string.Join(", ", missing)}");
        }
    }

    internal static string ResolveNodeExecutable(
        string? configuredExecutable = null,
        string? pathValue = null)
    {
        var configured = !string.IsNullOrWhiteSpace(configuredExecutable);
        var executable = configured ? configuredExecutable!.Trim() : "node";
        var path = pathValue ?? Environment.GetEnvironmentVariable("PATH") ?? string.Empty;

        if (Path.IsPathRooted(executable) ||
            executable.Contains(Path.DirectorySeparatorChar) ||
            executable.Contains(Path.AltDirectorySeparatorChar))
        {
            var explicitPath = Path.GetFullPath(executable);
            if (File.Exists(explicitPath))
            {
                return explicitPath;
            }

            throw new FileNotFoundException("The configured Node executable does not exist.", explicitPath);
        }

        var extensions = Path.HasExtension(executable)
            ? [string.Empty]
            : OperatingSystem.IsWindows()
                ? (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT")
                    .Split(';', StringSplitOptions.RemoveEmptyEntries)
                : [string.Empty];
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var extension in extensions)
            {
                var candidate = Path.GetFullPath(Path.Combine(directory, executable + extension));
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        throw new FileNotFoundException(
            configured
                ? $"The configured Node executable '{executable}' could not be resolved."
                : "Node.js was not found on PATH. Install Node.js or set YTDL_NODE_EXECUTABLE.");
    }

    internal static Uri ValidateBackendAddress(string address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri))
        {
            throw new InvalidDataException("The backend readiness message contains an invalid address.");
        }

        return ValidateBackendAddress(uri);
    }

    internal static Uri ValidateBackendAddress(Uri uri)
    {
        var isLoopback = IPAddress.TryParse(uri.Host, out var ipAddress)
            ? IPAddress.IsLoopback(ipAddress)
            : string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase);
        if (!uri.IsAbsoluteUri ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) ||
            !isLoopback ||
            uri.Port is < 1 or > 65535 ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            uri.AbsolutePath != "/" ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new InvalidDataException("The backend address must be an HTTP loopback origin with a valid port.");
        }

        return new Uri(uri.GetLeftPart(UriPartial.Authority));
    }

    private static bool HasRepositoryMarkers(string root) =>
        RepositoryMarkers.All(marker => File.Exists(Path.Combine(root, marker)));

    private async Task DrainStdoutAsync(
        Process process,
        TaskCompletionSource<Uri> readiness,
        CancellationToken cancellationToken)
    {
        try
        {
            while (await process.StandardOutput.ReadLineAsync(cancellationToken) is { } line)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                try
                {
                    var address = ParseReadyMessage(line);
                    if (address is not null)
                    {
                        readiness.TrySetResult(address);
                    }
                }
                catch (Exception error) when (error is JsonException or InvalidDataException or InvalidOperationException)
                {
                    AppendDiagnostic($"Invalid backend stdout protocol: {error.Message}");
                    readiness.TrySetException(error);
                }
            }

        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (IOException error)
        {
            readiness.TrySetException(new InvalidOperationException(
                $"Could not read the backend readiness stream: {error.Message}{DiagnosticSuffix()}",
                error));
        }
    }

    private async Task DrainStderrAsync(Process process, CancellationToken cancellationToken)
    {
        try
        {
            while (await process.StandardError.ReadLineAsync(cancellationToken) is { } line)
            {
                AppendDiagnostic(line);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (IOException error)
        {
            AppendDiagnostic($"Could not drain backend stderr: {error.Message}");
        }
    }

    private async Task MonitorExitAsync(
        Process process,
        TaskCompletionSource<Uri> readiness)
    {
        try
        {
            await process.WaitForExitAsync();
            if (_stderrDrain is not null)
            {
                await _stderrDrain;
            }

            readiness.TrySetException(new InvalidOperationException(
                $"The local backend exited with code {process.ExitCode} before becoming ready.{DiagnosticSuffix()}"));

            var notify = false;
            lock (_stateLock)
            {
                if (ReferenceEquals(_process, process))
                {
                    _backendAddress = null;
                    notify = !_stopRequested;
                }
            }

            if (notify)
            {
                BackendExited?.Invoke(this, EventArgs.Empty);
            }
        }
        catch (InvalidOperationException)
        {
            readiness.TrySetException(new InvalidOperationException(
                $"The local backend exited before becoming ready.{DiagnosticSuffix()}"));
        }
    }

    private async Task StopProcessCoreAsync(bool graceful)
    {
        var process = _process;
        if (process is null)
        {
            lock (_stateLock)
            {
                _backendAddress = null;
            }

            return;
        }

        lock (_stateLock)
        {
            _stopRequested = true;
            _backendAddress = null;
        }

        LastShutdownWasForced = false;
        var forceKill = !graceful;
        if (!process.HasExited && graceful)
        {
            try
            {
                await process.StandardInput.WriteLineAsync("{\"type\":\"shutdown\"}");
                await process.StandardInput.FlushAsync();
            }
            catch (IOException error)
            {
                AppendDiagnostic($"Graceful shutdown request failed: {error.Message}");
                forceKill = true;
            }
            catch (ObjectDisposedException error)
            {
                AppendDiagnostic($"Graceful shutdown stream was unavailable: {error.Message}");
                forceKill = true;
            }
        }

        try
        {
            if (!process.HasExited && !forceKill)
            {
                try
                {
                    await process.WaitForExitAsync().WaitAsync(_shutdownTimeout);
                }
                catch (TimeoutException)
                {
                    AppendDiagnostic("Graceful shutdown timed out; terminating the owned backend process tree.");
                    forceKill = true;
                }
            }

            if (!process.HasExited && forceKill)
            {
                LastShutdownWasForced = true;
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
        finally
        {
            _readerCancellation?.Cancel();
            var drains = new[] { _stdoutDrain, _stderrDrain }
                .Where(task => task is not null)
                .Cast<Task>()
                .ToArray();
            if (drains.Length > 0)
            {
                await Task.WhenAll(drains);
            }

            process.Dispose();
            lock (_stateLock)
            {
                if (ReferenceEquals(_process, process))
                {
                    _process = null;
                    _readiness = null;
                    _readerCancellation?.Dispose();
                    _readerCancellation = null;
                    _stdoutDrain = null;
                    _stderrDrain = null;
                    _exitMonitor = null;
                }
            }
        }
    }

    internal static Uri? ParseReadyMessage(string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("type", out var typeElement) ||
            typeElement.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException("Backend protocol messages must include a string type.");
        }

        var type = typeElement.GetString();
        if (type == "startup-error")
        {
            var message = root.TryGetProperty("message", out var messageElement) &&
                          messageElement.ValueKind == JsonValueKind.String
                ? messageElement.GetString()
                : null;
            throw new InvalidOperationException(
                $"The backend reported a startup error: {message ?? "No details provided."}");
        }

        if (type != "ready")
        {
            return null;
        }

        if (!root.TryGetProperty("address", out var addressElement) ||
            addressElement.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException("The backend readiness message is missing its lowercase address property.");
        }

        return ValidateBackendAddress(addressElement.GetString()!);
    }

    private void AppendDiagnostic(string message)
    {
        lock (_stateLock)
        {
            _diagnostics.AppendLine(message);
            if (_diagnostics.Length > DiagnosticCapacity)
            {
                _diagnostics.Remove(0, _diagnostics.Length - DiagnosticCapacity);
            }
        }
    }

    private string DiagnosticSuffix()
    {
        var diagnostics = DiagnosticOutput;
        return string.IsNullOrWhiteSpace(diagnostics) ? string.Empty : $" Details: {diagnostics}";
    }
}
