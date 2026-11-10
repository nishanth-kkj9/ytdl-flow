using CommunityToolkit.Mvvm.ComponentModel;
using System.ComponentModel;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using System.Net.WebSockets;
using System.Text.Json;
using Windows.Storage.Pickers;
using WinRT.Interop;
using YtdlFlow.Desktop.Services;

namespace YtdlFlow.Desktop.ViewModels;

public partial class MainViewModel : ObservableObject
{
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(90);
    private readonly SettingsService _settingsService;
    private readonly BackendSupervisor _backendSupervisor;
    private readonly BackendService _backendService = new();
    private readonly EngineEventClient _eventClient = new();
    private readonly DispatcherQueue _dispatcher;
    private readonly CancellationTokenSource _lifetime = new();
    private Task? _statusMonitor;
    private bool _initialized;

    public MainViewModel(DispatcherQueue dispatcher)
    {
        _dispatcher = dispatcher;
        _settingsService = new SettingsService();
        DownloadDirectory = _settingsService.LoadDownloadDirectory();
        _backendSupervisor = new BackendSupervisor(_settingsService);
        _backendSupervisor.BackendExited += OnBackendExited;
        _eventClient.ConnectionStateChanged += OnConnectionStateChanged;
        _eventClient.EventReceived += OnEngineEvent;
    }

    [ObservableProperty]
    private string url = string.Empty;

    [ObservableProperty]
    private string statusMessage = "Starting the local backend...";

    [ObservableProperty]
    private string backendStatus = "Node server starting";

    [ObservableProperty]
    private string engineStatus = "Python engine starting";

    [ObservableProperty]
    private string webSocketStatus = "WebSocket disconnected";

    [ObservableProperty]
    private string downloadDirectory = string.Empty;

    [ObservableProperty]
    private string metadataTitle = "No metadata yet";

    [ObservableProperty]
    private string metadataDetails = "Paste a YouTube URL and select Probe to retrieve its metadata.";

    [ObservableProperty]
    private string errorMessage = string.Empty;

    [ObservableProperty]
    private bool isProbing;

    [ObservableProperty]
    private bool isChangingFolder;

    public bool ProbeEnabled => !IsProbing && !IsChangingFolder;

    public bool FolderPickerEnabled => !IsChangingFolder;

    public async Task InitializeAsync()
    {
        if (_initialized)
        {
            return;
        }

        _initialized = true;
        try
        {
            var endpoint = await _backendSupervisor.StartAsync(DownloadDirectory, _lifetime.Token);
            _backendService.SetBaseAddress(endpoint);
            BackendStatus = "Node server running";
            await _eventClient.StartAsync(endpoint, _lifetime.Token);
            await RefreshBackendStatusAsync(_lifetime.Token);
            _statusMonitor = MonitorBackendStatusAsync(_lifetime.Token);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (Exception error) when (IsBackendFailure(error))
        {
            BackendStatus = "Backend unavailable";
            EngineStatus = "Engine unavailable";
            ErrorMessage = error.Message;
            StatusMessage = $"Could not start the shared backend: {error.Message}";
        }
    }

    public async Task ProbeAsync()
    {
        if (IsProbing || IsChangingFolder)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(Url))
        {
            ErrorMessage = "Paste a YouTube URL before probing.";
            StatusMessage = "A YouTube URL is required.";
            return;
        }

        IsProbing = true;
        ErrorMessage = string.Empty;
        StatusMessage = "Connecting to the backend event stream...";
        try
        {
            await _eventClient.WaitUntilConnectedAsync(TimeSpan.FromSeconds(15), _lifetime.Token);
            StatusMessage = "Requesting metadata from the Python engine...";
            var requestId = await _backendService.ProbeAsync(Url.Trim(), _lifetime.Token);
            var probeResult = await _eventClient.WaitForProbeResultAsync(
                requestId,
                ProbeTimeout,
                _lifetime.Token);
            if (!string.Equals(probeResult.Id, requestId, StringComparison.Ordinal))
            {
                throw new InvalidDataException("The backend returned a metadata result for a different request.");
            }

            if (probeResult.Success != true)
            {
                throw new InvalidOperationException(
                    probeResult.Message ?? "The Python engine could not retrieve metadata for this URL.");
            }

            if (probeResult.Info is not { ValueKind: JsonValueKind.Object } info)
            {
                throw new InvalidDataException("The probe result did not contain video metadata.");
            }

            var title = ReadString(info, "title");
            if (string.IsNullOrWhiteSpace(title))
            {
                throw new InvalidDataException("The probe result did not contain a video title.");
            }

            var uploader = ReadString(info, "uploader");
            var duration = ReadDuration(info);
            var metadataUrl = ReadString(info, "webpage_url");
            MetadataTitle = title;
            MetadataDetails = string.Join(
                Environment.NewLine,
                new[] { uploader, duration, metadataUrl }.Where(value => !string.IsNullOrWhiteSpace(value)));
            StatusMessage = "Metadata probe completed successfully.";
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (TimeoutException error)
        {
            ErrorMessage = "Timed out waiting for the backend or metadata event.";
            StatusMessage = error.Message;
        }
        catch (Exception error) when (IsBackendFailure(error) ||
                                      error is InvalidDataException or InvalidOperationException)
        {
            ErrorMessage = error.Message;
            StatusMessage = "Metadata probe failed.";
        }
        finally
        {
            IsProbing = false;
        }
    }

    public async Task PickDownloadFolderAsync(Window owner)
    {
        var picker = new FolderPicker();
        picker.FileTypeFilter.Add("*");
        InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(owner));

        var result = await picker.PickSingleFolderAsync();
        if (result is null)
        {
            return;
        }

        IsChangingFolder = true;
        ErrorMessage = string.Empty;
        try
        {
            var currentStatus = await _backendService.GetStatusAsync(_lifetime.Token);
            if (currentStatus.ActiveJobs.Count > 0)
            {
                StatusMessage = "The download folder cannot change while downloads are active.";
                ErrorMessage = StatusMessage;
                return;
            }

            var previousDirectory = currentStatus.DownloadDirectory;
            if (string.IsNullOrWhiteSpace(previousDirectory))
            {
                throw new InvalidDataException("The backend did not report its active download directory.");
            }

            await ApplyDownloadDirectoryAsync(result.Path, previousDirectory, _lifetime.Token);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (Exception error) when (IsBackendFailure(error) ||
                                      error is InvalidDataException or InvalidOperationException)
        {
            ErrorMessage = error.Message;
            StatusMessage = $"Could not change the download folder: {error.Message}";
        }
        finally
        {
            IsChangingFolder = false;
        }
    }

    public async Task ShutdownAsync()
    {
        _lifetime.Cancel();
        var failures = new List<Exception>();
        if (_statusMonitor is not null)
        {
            try
            {
                await _statusMonitor;
            }
            catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
            {
            }
            catch (Exception error)
            {
                failures.Add(error);
            }
        }

        try
        {
            await _eventClient.DisposeAsync();
        }
        catch (Exception error)
        {
            failures.Add(error);
        }

        try
        {
            await _backendSupervisor.DisposeAsync();
        }
        catch (Exception error)
        {
            failures.Add(error);
        }

        _backendService.Dispose();
        _lifetime.Dispose();
        if (failures.Count > 0)
        {
            throw new AggregateException("The desktop app could not fully stop its local services.", failures);
        }
    }

    private async Task ApplyDownloadDirectoryAsync(
        string selectedDirectory,
        string previousDirectory,
        CancellationToken cancellationToken)
    {
        var target = Path.GetFullPath(selectedDirectory);
        var previous = Path.GetFullPath(previousDirectory);
        if (PathsEqual(target, previous))
        {
            DownloadDirectory = previous;
            StatusMessage = "The selected folder is already confirmed by the backend.";
            return;
        }

        _settingsService.SaveDownloadDirectory(target);
        try
        {
            await _eventClient.DisconnectAsync(cancellationToken);
            await _backendSupervisor.StopAsync(cancellationToken);
            await RestartBackendAsync(target, cancellationToken);
            var status = await _backendService.GetStatusAsync(cancellationToken);
            if (string.IsNullOrWhiteSpace(status.DownloadDirectory) ||
                !PathsEqual(Path.GetFullPath(status.DownloadDirectory), target))
            {
                throw new InvalidOperationException("The backend did not confirm the requested download directory.");
            }

            DownloadDirectory = status.DownloadDirectory;
            StatusMessage = $"Download folder confirmed by the backend: {DownloadDirectory}";
        }
        catch (Exception changeError)
        {
            try
            {
                await _eventClient.DisconnectAsync(CancellationToken.None);
                await _backendSupervisor.StopAsync(CancellationToken.None);
                _settingsService.SaveDownloadDirectory(previous);
                await RestartBackendAsync(previous, CancellationToken.None);
                var restoredStatus = await _backendService.GetStatusAsync(CancellationToken.None);
                if (string.IsNullOrWhiteSpace(restoredStatus.DownloadDirectory) ||
                    !PathsEqual(Path.GetFullPath(restoredStatus.DownloadDirectory), previous))
                {
                    throw new InvalidOperationException("The backend did not confirm the restored download directory.");
                }

                DownloadDirectory = restoredStatus.DownloadDirectory;
                throw new InvalidOperationException(
                    $"The folder change failed and was rolled back: {changeError.Message}",
                    changeError);
            }
            catch (InvalidOperationException rollbackResult) when (
                rollbackResult.InnerException == changeError)
            {
                throw;
            }
            catch (Exception rollbackError)
            {
                BackendStatus = "Backend unavailable";
                ErrorMessage = $"Folder change failed: {changeError.Message} Rollback failed: {rollbackError.Message}";
                throw new AggregateException(
                    "The download directory change failed and the previous backend configuration could not be restored.",
                    changeError,
                    rollbackError);
            }
        }
    }

    private async Task RestartBackendAsync(string downloadDirectory, CancellationToken cancellationToken)
    {
        var endpoint = await _backendSupervisor.StartAsync(downloadDirectory, cancellationToken);
        _backendService.SetBaseAddress(endpoint);
        BackendStatus = "Node server running";
        await _eventClient.StartAsync(endpoint, cancellationToken);
        await _eventClient.WaitUntilConnectedAsync(TimeSpan.FromSeconds(15), cancellationToken);
        await RefreshBackendStatusAsync(cancellationToken);
    }

    private async Task MonitorBackendStatusAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            await RefreshBackendStatusAsync(cancellationToken);
        }
    }

    private async Task RefreshBackendStatusAsync(CancellationToken cancellationToken)
    {
        try
        {
            var health = await _backendService.GetHealthAsync(cancellationToken);
            BackendStatus = health.Ok ? "Node server running" : $"Backend unavailable: {health.Message}";
            EngineStatus = health.EngineReady ? "Engine ready" : "Python engine starting";

            var status = await _backendService.GetStatusAsync(cancellationToken);
            if (!string.IsNullOrWhiteSpace(status.DownloadDirectory))
            {
                DownloadDirectory = status.DownloadDirectory;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error) when (IsBackendFailure(error))
        {
            BackendStatus = "Backend unavailable";
            EngineStatus = "Engine status unavailable";
            ErrorMessage = error.Message;
        }
    }

    private void OnBackendExited(object? sender, EventArgs args) =>
        Dispatch(() =>
        {
            BackendStatus = "Backend unavailable";
            EngineStatus = "Engine unavailable";
            StatusMessage = "The supervised Node backend exited.";
        });

    private void OnConnectionStateChanged(EngineConnectionState state) =>
        Dispatch(() => WebSocketStatus = state switch
        {
            EngineConnectionState.Connected => "WebSocket connected",
            EngineConnectionState.Connecting => "WebSocket connecting",
            _ => "WebSocket disconnected",
        });

    private void OnEngineEvent(EngineEventMessage message)
    {
        Dispatch(() =>
        {
            switch (message.Type)
            {
                case "engine_ready":
                    EngineStatus = message.Ready == true ? "Engine ready" : "Python engine starting";
                    break;
                case "engine_error":
                case "fatal_error":
                    EngineStatus = "Engine unavailable";
                    ErrorMessage = message.Message ?? "The Python engine reported an error.";
                    break;
                case "engine_crashed":
                    EngineStatus = "Python engine restarting";
                    ErrorMessage = message.Message ?? "The Python engine stopped unexpectedly.";
                    break;
                case "engine_log" when !string.IsNullOrWhiteSpace(message.Message):
                    StatusMessage = message.Message;
                    break;
            }
        });
    }

    private void Dispatch(Action action)
    {
        if (!_dispatcher.TryEnqueue(() =>
            {
                if (!_lifetime.IsCancellationRequested)
                {
                    action();
                }
            }))
        {
            System.Diagnostics.Debug.WriteLine("The WinUI dispatcher rejected a backend status update.");
        }
    }

    private static string? ReadString(JsonElement info, string propertyName) =>
        info.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string? ReadDuration(JsonElement info)
    {
        if (!info.TryGetProperty("duration", out var value) ||
            value.ValueKind != JsonValueKind.Number ||
            !value.TryGetDouble(out var seconds) ||
            seconds < 0)
        {
            return null;
        }

        return $"Duration: {TimeSpan.FromSeconds(seconds):hh\\:mm\\:ss}";
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(left),
            Path.TrimEndingDirectorySeparator(right),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static bool IsBackendFailure(Exception error) =>
        error is HttpRequestException or IOException or JsonException or
            InvalidDataException or TimeoutException or WebSocketException or
            InvalidOperationException or UnauthorizedAccessException or
            DirectoryNotFoundException or FileNotFoundException or
            TaskCanceledException or AggregateException or ArgumentException or
            Win32Exception;

    partial void OnIsProbingChanged(bool value) => OnPropertyChanged(nameof(ProbeEnabled));

    partial void OnIsChangingFolderChanged(bool value)
    {
        OnPropertyChanged(nameof(ProbeEnabled));
        OnPropertyChanged(nameof(FolderPickerEnabled));
    }
}
