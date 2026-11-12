using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace YtdlFlow.Desktop.Services;

public enum EngineConnectionState
{
    Disconnected,
    Connecting,
    Connected,
}

public sealed record EngineEventMessage(string Type, JsonElement Payload)
{
    public string? Id => GetString("id");

    public string? Message => GetString("message") ?? GetString("error");

    public bool? Success => GetBoolean("success");

    public bool? Ready => GetBoolean("ready");

    public JsonElement? Info =>
        Payload.ValueKind == JsonValueKind.Object &&
        Payload.TryGetProperty("info", out var info)
            ? info
            : null;

    private string? GetString(string name) =>
        Payload.ValueKind == JsonValueKind.Object &&
        Payload.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private bool? GetBoolean(string name) =>
        Payload.ValueKind == JsonValueKind.Object &&
        Payload.TryGetProperty(name, out var value) &&
        value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : null;
}

public sealed class EngineEventClient : IAsyncDisposable
{
    private const int MaximumMessageBytes = 1024 * 1024;
    private const int MaximumEarlyResults = 100;
    private const int MaximumDiagnostics = 100;
    private static readonly HashSet<string> SupportedEvents = new(StringComparer.Ordinal)
    {
        "engine_ready",
        "engine_error",
        "engine_crashed",
        "fatal_error",
        "probe_result",
        "download_started",
        "progress",
        "result",
        "cancelled",
        "error",
        "download_retry",
        "engine_log",
    };

    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
    private readonly object _stateLock = new();
    private readonly object _probeLock = new();
    private readonly Dictionary<string, TaskCompletionSource<EngineEventMessage>> _pendingProbes = new();
    private readonly Dictionary<string, EngineEventMessage> _earlyProbeResults = new();
    private readonly Queue<string> _earlyProbeOrder = new();
    private readonly Queue<string> _diagnostics = new();
    private CancellationTokenSource? _connectionLifetime;
    private Task? _connectionLoop;
    private Uri? _endpoint;
    private TaskCompletionSource _connected = NewConnectionSource();
    private EngineConnectionState _connectionState = EngineConnectionState.Disconnected;

    public event Action<EngineEventMessage>? EventReceived;

    public event Action<EngineConnectionState>? ConnectionStateChanged;

    public EngineConnectionState ConnectionState
    {
        get
        {
            lock (_stateLock)
            {
                return _connectionState;
            }
        }
    }

    public string DiagnosticLog
    {
        get
        {
            lock (_stateLock)
            {
                return string.Join(Environment.NewLine, _diagnostics);
            }
        }
    }

    public async Task StartAsync(Uri backendAddress, CancellationToken cancellationToken = default)
    {
        var endpoint = BackendSupervisor.ValidateBackendAddress(backendAddress);
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            if (_connectionLoop is { IsCompleted: false } && _endpoint == endpoint)
            {
                return;
            }

            await StopConnectionCoreAsync();
            _endpoint = endpoint;
            _connectionLifetime = new CancellationTokenSource();
            _connected = NewConnectionSource();
            SetConnectionState(EngineConnectionState.Connecting);
            _connectionLoop = RunConnectionLoopAsync(endpoint, _connectionLifetime.Token);
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async Task WaitUntilConnectedAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        Task connectionTask;
        lock (_stateLock)
        {
            connectionTask = _connectionState == EngineConnectionState.Connected
                ? Task.CompletedTask
                : _connected.Task;
        }

        await connectionTask.WaitAsync(timeout, cancellationToken);
    }

    public async Task<EngineEventMessage> WaitForProbeResultAsync(
        string requestId,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(requestId))
        {
            throw new ArgumentException("A probe request id is required.", nameof(requestId));
        }

        TaskCompletionSource<EngineEventMessage> source;
        lock (_probeLock)
        {
            if (_earlyProbeResults.Remove(requestId, out var earlyResult))
            {
                return earlyResult;
            }

            if (_pendingProbes.ContainsKey(requestId))
            {
                throw new InvalidOperationException($"Probe '{requestId}' is already being awaited.");
            }

            source = new TaskCompletionSource<EngineEventMessage>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _pendingProbes.Add(requestId, source);
        }

        try
        {
            return await source.Task.WaitAsync(timeout, cancellationToken);
        }
        finally
        {
            lock (_probeLock)
            {
                if (_pendingProbes.TryGetValue(requestId, out var current) &&
                    ReferenceEquals(current, source))
                {
                    _pendingProbes.Remove(requestId);
                }
            }
        }
    }

    public async Task DisconnectAsync(CancellationToken cancellationToken = default)
    {
        await _lifecycleGate.WaitAsync(cancellationToken);
        try
        {
            await StopConnectionCoreAsync();
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await DisconnectAsync();
        _lifecycleGate.Dispose();
    }

    private async Task RunConnectionLoopAsync(Uri endpoint, CancellationToken cancellationToken)
    {
        var attempt = 0;
        var socketAddress = new UriBuilder(endpoint)
        {
            Scheme = "ws",
            Path = "/ws",
            Query = string.Empty,
            Fragment = string.Empty,
        }.Uri;

        while (!cancellationToken.IsCancellationRequested)
        {
            using var socket = new ClientWebSocket();
            SetConnectionState(EngineConnectionState.Connecting);
            try
            {
                await socket.ConnectAsync(socketAddress, cancellationToken);
                SetConnectionState(EngineConnectionState.Connected);
                attempt = 0;
                await ReceiveMessagesAsync(socket, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                AddDiagnostic($"WebSocket connection failed: {error.Message}");
            }

            SetConnectionState(EngineConnectionState.Disconnected);
            if (cancellationToken.IsCancellationRequested)
            {
                break;
            }

            var delay = TimeSpan.FromMilliseconds(Math.Min(1000 * Math.Pow(2, attempt), 15000));
            attempt = Math.Min(attempt + 1, 4);
            try
            {
                await Task.Delay(delay, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }

        SetConnectionState(EngineConnectionState.Disconnected);
    }

    private async Task ReceiveMessagesAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        using var message = new MemoryStream();
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return;
            }

            if (result.MessageType != WebSocketMessageType.Text)
            {
                AddDiagnostic("Ignored a non-text WebSocket frame.");
                message.SetLength(0);
                continue;
            }

            if (message.Length + result.Count > MaximumMessageBytes)
            {
                throw new InvalidDataException("A backend WebSocket event exceeded the 1 MiB message limit.");
            }

            message.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage)
            {
                continue;
            }

            DispatchMessage(message.GetBuffer().AsMemory(0, checked((int)message.Length)));
            message.SetLength(0);
        }
    }

    internal void DispatchMessage(ReadOnlyMemory<byte> messageBytes)
    {
        using var document = JsonDocument.Parse(messageBytes);
        var envelope = document.RootElement;
        if (envelope.ValueKind != JsonValueKind.Object ||
            !envelope.TryGetProperty("type", out var typeElement) ||
            typeElement.ValueKind != JsonValueKind.String ||
            !envelope.TryGetProperty("payload", out var payload))
        {
            throw new InvalidDataException("The backend sent an invalid event envelope.");
        }

        var type = typeElement.GetString()!;
        if (!SupportedEvents.Contains(type))
        {
            AddDiagnostic($"Ignored unknown backend event type '{type}'.");
            return;
        }

        var engineEvent = new EngineEventMessage(type, payload.Clone());
        if ((type is "probe_result" or "error") && !string.IsNullOrWhiteSpace(engineEvent.Id))
        {
            lock (_probeLock)
            {
                if (_pendingProbes.TryGetValue(engineEvent.Id, out var pending))
                {
                    pending.TrySetResult(engineEvent);
                }
                else
                {
                    _earlyProbeResults[engineEvent.Id] = engineEvent;
                    _earlyProbeOrder.Enqueue(engineEvent.Id);
                    while (_earlyProbeOrder.Count > MaximumEarlyResults)
                    {
                        var oldest = _earlyProbeOrder.Dequeue();
                        _earlyProbeResults.Remove(oldest);
                    }
                }
            }
        }

        try
        {
            EventReceived?.Invoke(engineEvent);
        }
        catch (Exception error)
        {
            AddDiagnostic($"Backend event handler failed for '{type}': {error.Message}");
        }
    }

    private void SetConnectionState(EngineConnectionState state)
    {
        Action<EngineConnectionState>? handler = null;
        lock (_stateLock)
        {
            if (_connectionState == state)
            {
                return;
            }

            var previousState = _connectionState;
            _connectionState = state;
            if (state == EngineConnectionState.Connected)
            {
                _connected.TrySetResult();
            }
            else if (state == EngineConnectionState.Disconnected &&
                     previousState == EngineConnectionState.Connected)
            {
                _connected = NewConnectionSource();
            }

            handler = ConnectionStateChanged;
        }

        handler?.Invoke(state);
    }

    private async Task StopConnectionCoreAsync()
    {
        var lifetime = _connectionLifetime;
        var loop = _connectionLoop;
        _connectionLifetime = null;
        _connectionLoop = null;
        _endpoint = null;
        lifetime?.Cancel();
        if (loop is not null)
        {
            await loop;
        }

        lifetime?.Dispose();
        lock (_stateLock)
        {
            _connected.TrySetCanceled();
        }
        SetConnectionState(EngineConnectionState.Disconnected);
    }

    private void AddDiagnostic(string message)
    {
        const int maxEntryLength = 1024;
        var entry = message.Length > maxEntryLength ? message[..maxEntryLength] : message;
        lock (_stateLock)
        {
            _diagnostics.Enqueue(entry);
            while (_diagnostics.Count > MaximumDiagnostics)
            {
                _diagnostics.Dequeue();
            }
        }
    }

    private static TaskCompletionSource NewConnectionSource() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}
