using CommunityToolkit.Mvvm.ComponentModel;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Globalization;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using System.Net.WebSockets;
using System.Text.Json;
using Windows.Storage.Pickers;
using WinRT.Interop;
using YtdlFlow.Desktop.Models;
using YtdlFlow.Desktop.Services;

namespace YtdlFlow.Desktop.ViewModels;

public partial class MainViewModel : ObservableObject
{
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(90);
    private readonly SettingsService _settingsService;
    private readonly BackendSupervisor _backendSupervisor;
    private readonly BackendService _backendService = new();
    private readonly EngineEventClient _eventClient = new();
    private readonly DownloadQueue _downloadQueue = new();
    private readonly SemaphoreSlim _historyGate = new(1, 1);
    private readonly DispatcherQueue _dispatcher;
    private readonly CancellationTokenSource _lifetime = new();
    private ProbeMetadata? _probeMetadata;
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

    [ObservableProperty]
    private string selectedMode = "audio";

    [ObservableProperty]
    private string selectedFormat = "mp3";

    [ObservableProperty]
    private string selectedQuality = "high";

    [ObservableProperty]
    private string trimStartText = string.Empty;

    [ObservableProperty]
    private string trimEndText = string.Empty;

    [ObservableProperty]
    private bool isSubmittingDownload;

    [ObservableProperty]
    private string currentPage = "Download";

    [ObservableProperty]
    private bool isLoadingHistory;

    [ObservableProperty]
    private bool isClearingHistory;

    [ObservableProperty]
    private string historyStatusMessage = string.Empty;

    [ObservableProperty]
    private ImageSource? probeThumbnail;

    public IReadOnlyList<string> ModeOptions { get; } = ["audio", "video"];

    public ObservableCollection<string> FormatOptions { get; } = ["mp3", "opus", "m4a", "aac", "wav"];

    public ObservableCollection<string> QualityOptions { get; } = ["maximum", "high", "medium", "low"];

    public DownloadQueue Queue => _downloadQueue;

    public ObservableCollection<DownloadHistoryRecord> History { get; } = [];

    public bool ProbeEnabled => !IsProbing && !IsChangingFolder;

    public bool FolderPickerEnabled => !IsChangingFolder;

    public bool SubmitEnabled => !IsSubmittingDownload && !IsChangingFolder;

    public bool IsDownloadPage => CurrentPage == "Download";

    public bool IsQueuePage => CurrentPage == "Queue";

    public bool IsHistoryPage => CurrentPage == "History";

    public Visibility DownloadPageVisibility =>
        IsDownloadPage ? Visibility.Visible : Visibility.Collapsed;

    public Visibility QueuePageVisibility =>
        IsQueuePage ? Visibility.Visible : Visibility.Collapsed;

    public Visibility HistoryPageVisibility =>
        IsHistoryPage ? Visibility.Visible : Visibility.Collapsed;

    public bool HasActiveJobs => _downloadQueue.Any(item => item.IsActive);

    public bool HistoryActionsEnabled => !IsClearingHistory;

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
            await RefreshHistoryAsync(_lifetime.Token);
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

        var probeUrl = Url.Trim();
        if (string.IsNullOrWhiteSpace(probeUrl))
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
            var requestId = await _backendService.ProbeAsync(probeUrl, _lifetime.Token);
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
            if (!SameVideo(probeUrl, string.IsNullOrWhiteSpace(metadataUrl) ? probeUrl : metadataUrl))
            {
                throw new InvalidDataException("The probe result did not match the requested video.");
            }

            var thumbnailUrl = ReadString(info, "thumbnail");
            _probeMetadata = new ProbeMetadata(
                title,
                uploader,
                thumbnailUrl,
                ReadDurationSeconds(info),
                string.IsNullOrWhiteSpace(metadataUrl) ? probeUrl : metadataUrl);
            if (!SameVideo(Url.Trim(), _probeMetadata.WebpageUrl))
            {
                _probeMetadata = null;
                StatusMessage = "Metadata was received for the previous URL and was not applied.";
                return;
            }

            MetadataTitle = title;
            MetadataDetails = string.Join(
                Environment.NewLine,
                new[] { uploader, duration, metadataUrl }.Where(value => !string.IsNullOrWhiteSpace(value)));
            ProbeThumbnail = CreateSafeThumbnail(thumbnailUrl);
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
            if (currentStatus.ActiveJobs.Count > 0 || _downloadQueue.Any(item => item.IsActive))
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

    public void NavigateTo(string page)
    {
        if (page is not ("Download" or "Queue" or "History"))
        {
            throw new ArgumentOutOfRangeException(nameof(page), "The selected desktop page is not supported.");
        }

        CurrentPage = page;
        if (page == "History")
        {
            _ = RefreshHistoryAsync(_lifetime.Token);
        }
    }

    public async Task SubmitDownloadAsync()
    {
        if (IsSubmittingDownload || IsChangingFolder)
        {
            return;
        }

        var targetUrl = Url.Trim();
        if (string.IsNullOrWhiteSpace(targetUrl))
        {
            ErrorMessage = "Paste a YouTube URL before starting a download.";
            return;
        }

        if (!TryParseTrimWindow(out var trimStart, out var trimEnd, out var trimError))
        {
            ErrorMessage = trimError;
            return;
        }

        if (!IsValidDownloadSelection(SelectedMode, SelectedFormat, SelectedQuality))
        {
            ErrorMessage = "Choose a supported mode, format, and quality.";
            return;
        }

        var metadata = _probeMetadata is not null &&
                       SameVideo(targetUrl, _probeMetadata.WebpageUrl)
            ? _probeMetadata
            : null;
        var id = Guid.NewGuid().ToString("D");
        var item = new DownloadItem(
            id,
            targetUrl,
            SelectedMode,
            SelectedFormat,
            SelectedQuality,
            metadata?.Title,
            metadata?.Uploader,
            metadata?.ThumbnailUrl,
            metadata?.Duration,
            trimStart,
            trimEnd);
        if (!_downloadQueue.TryAdd(item))
        {
            ErrorMessage = "The local queue is full. Finish or remove completed jobs before adding another.";
            return;
        }

        IsSubmittingDownload = true;
        ErrorMessage = string.Empty;
        StatusMessage = "Submitting the download to the backend...";
        var submissionAttempted = false;
        try
        {
            await _eventClient.WaitUntilConnectedAsync(TimeSpan.FromSeconds(15), _lifetime.Token);
            submissionAttempted = true;
            var request = new DownloadRequest
            {
                Url = targetUrl,
                Mode = item.Mode,
                Format = item.Format,
                Quality = item.Quality,
                Id = item.Id,
                Title = metadata?.Title,
                Uploader = metadata?.Uploader,
                Thumbnail = metadata?.ThumbnailUrl,
                Duration = metadata?.Duration,
                WebpageUrl = metadata?.WebpageUrl,
                TrimStart = trimStart,
                TrimEnd = trimEnd,
            };
            await _backendService.SubmitDownloadAsync(request, _lifetime.Token);
            var sendDeferredCancellation = item.AcknowledgeSubmission();
            if (string.Equals(Url.Trim(), targetUrl, StringComparison.Ordinal))
            {
                Url = string.Empty;
                TrimStartText = string.Empty;
                TrimEndText = string.Empty;
            }

            StatusMessage = $"Download queued: {item.Title}";
            if (sendDeferredCancellation)
            {
                await SendCancellationAsync(item, _lifetime.Token);
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (Exception error) when (IsWorkflowFailure(error))
        {
            var outcomeUnknown = submissionAttempted && IsSubmissionOutcomeUnknown(error);
            item.SubmissionFailed(error.Message, outcomeUnknown);
            ErrorMessage = error.Message;
            StatusMessage = outcomeUnknown
                ? "The submission outcome is unknown; checking backend state."
                : "The download could not be submitted.";
            if (outcomeUnknown)
            {
                _ = RefreshAfterReconnectAsync();
            }
        }
        finally
        {
            IsSubmittingDownload = false;
        }
    }

    public async Task CancelDownloadAsync(DownloadItem item)
    {
        if (!item.BeginCancellation())
        {
            return;
        }

        ErrorMessage = string.Empty;
        StatusMessage = $"Cancellation requested for {item.Title}.";
        if (!item.SubmissionAcknowledged)
        {
            return;
        }

        await SendCancellationAsync(item, _lifetime.Token);
    }

    public async Task RetryDownloadAsync(DownloadItem original)
    {
        if (!original.CanRetry)
        {
            return;
        }

        var retry = new DownloadItem(
            Guid.NewGuid().ToString("D"),
            original.Url,
            original.Mode,
            original.Format,
            original.Quality,
            original.Title,
            original.Uploader,
            original.ThumbnailUrl,
            original.Duration,
            original.TrimStart,
            original.TrimEnd);
        if (!_downloadQueue.TryAdd(retry))
        {
            ErrorMessage = "The local queue is full. Finish or remove completed jobs before retrying.";
            return;
        }

        original.RetrySubmitted = true;
        await SubmitExistingItemAsync(retry);
    }

    public void OpenDownloadFile(string? path) => RunFileAction(path, reveal: false);

    public void RevealDownloadFile(string? path) => RunFileAction(path, reveal: true);

    public async Task ClearHistoryAsync()
    {
        if (IsClearingHistory)
        {
            return;
        }

        IsClearingHistory = true;
        var gateAcquired = false;
        ErrorMessage = string.Empty;
        try
        {
            await _historyGate.WaitAsync(_lifetime.Token);
            gateAcquired = true;
            await _backendService.ClearHistoryAsync(_lifetime.Token);
            History.Clear();
            HistoryStatusMessage = "Download history cleared. Downloaded files were not deleted.";
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (Exception error) when (IsWorkflowFailure(error))
        {
            ErrorMessage = error.Message;
            HistoryStatusMessage = "Could not clear download history.";
        }
        finally
        {
            if (gateAcquired)
            {
                _historyGate.Release();
            }

            IsClearingHistory = false;
        }
    }

    private async Task SubmitExistingItemAsync(DownloadItem item)
    {
        ErrorMessage = string.Empty;
        StatusMessage = $"Submitting retry for {item.Title}...";
        var submissionAttempted = false;
        try
        {
            await _eventClient.WaitUntilConnectedAsync(TimeSpan.FromSeconds(15), _lifetime.Token);
            submissionAttempted = true;
            await _backendService.SubmitDownloadAsync(CreateDownloadRequest(item), _lifetime.Token);
            var sendDeferredCancellation = item.AcknowledgeSubmission();
            StatusMessage = $"Retry queued: {item.Title}";
            if (sendDeferredCancellation)
            {
                await SendCancellationAsync(item, _lifetime.Token);
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
        catch (Exception error) when (IsWorkflowFailure(error))
        {
            var outcomeUnknown = submissionAttempted && IsSubmissionOutcomeUnknown(error);
            item.SubmissionFailed(error.Message, outcomeUnknown);
            ErrorMessage = error.Message;
            StatusMessage = outcomeUnknown
                ? "The retry outcome is unknown; checking backend state."
                : "The retry could not be submitted.";
            if (outcomeUnknown)
            {
                _ = RefreshAfterReconnectAsync();
            }
        }
    }

    private async Task SendCancellationAsync(DownloadItem item, CancellationToken cancellationToken)
    {
        try
        {
            await _backendService.CancelDownloadAsync(item.Id, cancellationToken);
            StatusMessage = $"Cancellation is pending for {item.Title}.";
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception error) when (IsWorkflowFailure(error))
        {
            item.CancellationRequestFailed(error.Message);
            ErrorMessage = error.Message;
            StatusMessage = $"Could not cancel {item.Title}.";
        }
    }

    private async Task RefreshHistoryAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _historyGate.WaitAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return;
        }

        IsLoadingHistory = true;
        try
        {
            var records = await _backendService.GetHistoryAsync(cancellationToken);
            History.Clear();
            foreach (var record in records)
            {
                History.Add(record);
                _downloadQueue.Find(record.Id)?.ApplyHistory(record.Title, record.FilePath);
            }

            HistoryStatusMessage = records.Count == 0
                ? "No completed downloads yet."
                : $"{records.Count} recent downloads.";
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception error) when (IsWorkflowFailure(error))
        {
            ErrorMessage = error.Message;
            HistoryStatusMessage = "Could not load download history.";
        }
        finally
        {
            IsLoadingHistory = false;
            _historyGate.Release();
        }
    }

    private void RunFileAction(string? path, bool reveal)
    {
        try
        {
            var fileService = new DownloadFileService(DownloadDirectory);
            if (reveal)
            {
                fileService.RevealInExplorer(path ?? string.Empty);
                StatusMessage = "Opened the download location.";
            }
            else
            {
                fileService.OpenFile(path ?? string.Empty);
                StatusMessage = "Opened the downloaded file.";
            }

            ErrorMessage = string.Empty;
        }
        catch (Exception error) when (IsWorkflowFailure(error))
        {
            ErrorMessage = error.Message;
            StatusMessage = "The file action could not be completed.";
        }
    }

    private bool TryParseTrimWindow(out double? trimStart, out double? trimEnd, out string error) =>
        TryParseTrimWindow(TrimStartText, TrimEndText, out trimStart, out trimEnd, out error);

    internal static bool TryParseTrimWindow(
        string startValue,
        string endValue,
        out double? trimStart,
        out double? trimEnd,
        out string error)
    {
        trimStart = null;
        trimEnd = null;
        error = string.Empty;
        var startText = startValue.Trim();
        var endText = endValue.Trim();
        if (startText.Length == 0 && endText.Length == 0)
        {
            return true;
        }

        if (startText.Length == 0 || endText.Length == 0 ||
            !TryParseTrimValue(startText, out var start) ||
            !TryParseTrimValue(endText, out var end))
        {
            error = "Enter both trim values as seconds, MM:SS, or HH:MM:SS.";
            return false;
        }

        if (end <= start)
        {
            error = "The trim end must be greater than the trim start.";
            return false;
        }

        trimStart = start;
        trimEnd = end;
        return true;
    }

    private static bool TryParseTrimValue(string value, out double seconds)
    {
        if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out seconds))
        {
            return seconds >= 0 && double.IsFinite(seconds);
        }

        var parts = value.Split(':');
        if (parts.Length is not (2 or 3) ||
            !int.TryParse(parts[^1], NumberStyles.None, CultureInfo.InvariantCulture, out var secondPart) ||
            secondPart >= 60)
        {
            seconds = 0;
            return false;
        }

        if (parts.Length == 2)
        {
            if (!int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var minutes))
            {
                seconds = 0;
                return false;
            }

            seconds = minutes * 60d + secondPart;
            return true;
        }

        if (!int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var hours) ||
            !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var minutesPart) ||
            minutesPart >= 60)
        {
            seconds = 0;
            return false;
        }

        seconds = hours * 3600d + minutesPart * 60d + secondPart;
        return true;
    }

    internal static bool IsValidDownloadSelection(string mode, string format, string quality) =>
        mode switch
        {
            "audio" => new[] { "mp3", "opus", "m4a", "aac", "wav" }.Contains(format, StringComparer.Ordinal) &&
                       new[] { "maximum", "high", "medium", "low" }.Contains(quality, StringComparer.Ordinal),
            "video" => new[] { "mp4", "webm", "mkv" }.Contains(format, StringComparer.Ordinal) &&
                       new[]
                       {
                           "maximum", "best", "2160p", "1080p", "720p", "480p", "360p", "high", "medium", "low",
                       }.Contains(quality, StringComparer.Ordinal),
            _ => false,
        };

    private static DownloadRequest CreateDownloadRequest(DownloadItem item) => new()
    {
        Url = item.Url,
        Mode = item.Mode,
        Format = item.Format,
        Quality = item.Quality,
        Id = item.Id,
        Title = item.Title == "Untitled" ? null : item.Title,
        Uploader = item.Uploader,
        Thumbnail = item.ThumbnailUrl,
        Duration = item.Duration,
        WebpageUrl = item.Url,
        TrimStart = item.TrimStart,
        TrimEnd = item.TrimEnd,
    };

    internal static bool SameVideo(string left, string right)
    {
        var leftId = ReadYoutubeVideoId(left);
        var rightId = ReadYoutubeVideoId(right);
        return leftId is not null &&
               string.Equals(leftId, rightId, StringComparison.Ordinal);
    }

    private static string? ReadYoutubeVideoId(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https"))
        {
            return null;
        }

        var host = uri.Host.ToLowerInvariant();
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        string? id = null;
        if (host == "youtu.be" || host == "www.youtu.be")
        {
            id = segments.FirstOrDefault();
        }
        else if (host == "youtube.com" || host.EndsWith(".youtube.com", StringComparison.Ordinal))
        {
            if (uri.AbsolutePath == "/watch")
            {
                id = uri.Query.TrimStart('?')
                    .Split('&', StringSplitOptions.RemoveEmptyEntries)
                    .Select(pair => pair.Split('=', 2))
                    .FirstOrDefault(pair => pair.Length == 2 && pair[0] == "v") is { } videoParameter
                    ? Uri.UnescapeDataString(videoParameter[1])
                    : null;
            }
            else if (segments.Length >= 2 &&
                     segments[0] is "shorts" or "embed" or "v" or "live")
            {
                id = segments[1];
            }
        }

        return id is { Length: 11 } && id.All(character =>
            char.IsAsciiLetterOrDigit(character) || character is '_' or '-')
            ? id
            : null;
    }

    private static ImageSource? CreateSafeThumbnail(string? value) =>
        IsAllowedThumbnail(value) ? new BitmapImage(new Uri(value!)) : null;

    internal static bool IsAllowedThumbnail(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps ||
            !uri.IsDefaultPort ||
            !string.IsNullOrEmpty(uri.UserInfo))
        {
            return false;
        }

        var host = uri.Host.ToLowerInvariant();
        var safeHost = host.EndsWith(".ytimg.com", StringComparison.Ordinal) ||
                       host.EndsWith(".googleusercontent.com", StringComparison.Ordinal) ||
                       host.EndsWith(".googlevideo.com", StringComparison.Ordinal) ||
                       host == "youtube.com" ||
                       host.EndsWith(".youtube.com", StringComparison.Ordinal);
        return safeHost;
    }

    private static long? ReadLong(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(propertyName, out var value) ||
            value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt64(out var number))
        {
            return null;
        }

        return number;
    }

    private static double? ReadDouble(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(propertyName, out var value) ||
            value.ValueKind != JsonValueKind.Number ||
            !value.TryGetDouble(out var number) ||
            !double.IsFinite(number))
        {
            return null;
        }

        return number;
    }

    private static bool ReadBoolean(JsonElement payload, string propertyName) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty(propertyName, out var value) &&
        value.ValueKind == JsonValueKind.True;


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

    private async Task RefreshBackendStatusAsync(
        CancellationToken cancellationToken,
        bool markMissingUnknown = false)
    {
        try
        {
            var health = await _backendService.GetHealthAsync(cancellationToken);
            BackendStatus = health.Ok ? "Node server running" : $"Backend unavailable: {health.Message}";
            EngineStatus = health.EngineReady ? "Engine ready" : "Python engine starting";

            var status = await _backendService.GetStatusAsync(cancellationToken);
            _downloadQueue.Reconcile(status.ActiveJobs, status.EngineReady, markMissingUnknown);
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
        Dispatch(() =>
        {
            WebSocketStatus = state switch
            {
                EngineConnectionState.Connected => "WebSocket connected",
                EngineConnectionState.Connecting => "WebSocket connecting",
                _ => "WebSocket disconnected",
            };
            if (state == EngineConnectionState.Connected)
            {
                _ = RefreshAfterReconnectAsync();
            }
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
                case "download_started":
                    _downloadQueue.Find(message.Id)?.ApplyStarted();
                    break;
                case "progress":
                    if (_downloadQueue.Find(message.Id) is { } progressItem)
                    {
                        progressItem.ApplyProgress(
                            ReadLong(message.Payload, "downloaded"),
                            ReadLong(message.Payload, "total"),
                            ReadDouble(message.Payload, "speed"),
                            ReadString(message.Payload, "filename"));
                    }

                    break;
                case "download_retry":
                    _downloadQueue.Find(message.Id)?.ApplyRetry(message.Message);
                    break;
                case "cancelled":
                    _downloadQueue.Find(message.Id)?.ApplyCancelled();
                    break;
                case "error":
                {
                    var failedItem = _downloadQueue.Find(message.Id);
                    if (failedItem?.Status == DownloadStatus.Cancelling)
                    {
                        failedItem.CancellationResolutionUnknown(
                            message.Message ?? "The backend could not confirm cancellation.");
                        StatusMessage = $"Cancellation status is unknown for {failedItem.Title}; checking backend state.";
                        _ = RefreshAfterReconnectAsync();
                    }
                    else if (failedItem?.ApplyFailure(message.Message) == true)
                    {
                        StatusMessage = $"Download failed: {failedItem.Title}";
                    }

                    break;
                }
                case "result":
                    if (_downloadQueue.Find(message.Id) is { } completedItem)
                    {
                        if (ReadBoolean(message.Payload, "success"))
                        {
                            completedItem.ApplyResult(
                                ReadString(message.Payload, "title"),
                                ReadString(message.Payload, "filepath"));
                            _ = RefreshHistoryAfterResultAsync();
                        }
                        else
                        {
                            completedItem.ApplyFailure(
                                ReadString(message.Payload, "error") ??
                                "The backend returned an unsuccessful download result.");
                        }
                    }

                    break;
            }
        });
    }

    private async Task RefreshAfterReconnectAsync()
    {
        try
        {
            await RefreshBackendStatusAsync(_lifetime.Token, markMissingUnknown: true);
            await RefreshHistoryAsync(_lifetime.Token);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
    }

    private async Task RefreshHistoryAfterResultAsync()
    {
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(150), _lifetime.Token);
            await RefreshHistoryAsync(_lifetime.Token);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
        }
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
        info.ValueKind == JsonValueKind.Object &&
        info.TryGetProperty(propertyName, out var value) &&
        value.ValueKind == JsonValueKind.String
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

    private static double? ReadDurationSeconds(JsonElement info) =>
        info.TryGetProperty("duration", out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetDouble(out var seconds) &&
        seconds >= 0 &&
        double.IsFinite(seconds)
            ? seconds
            : null;

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

    private static bool IsWorkflowFailure(Exception error) =>
        IsBackendFailure(error) ||
        error is UnauthorizedAccessException or NotSupportedException or FormatException;

    private static bool IsSubmissionOutcomeUnknown(Exception error) =>
        error is HttpRequestException { StatusCode: null } or
            IOException or TaskCanceledException or TimeoutException or JsonException or InvalidDataException;

    partial void OnSelectedModeChanged(string value)
    {
        FormatOptions.Clear();
        if (value == "video")
        {
            foreach (var format in new[] { "mp4", "webm", "mkv" })
            {
                FormatOptions.Add(format);
            }

            SelectedFormat = "mp4";
            QualityOptions.Clear();
            foreach (var quality in new[]
                     {
                         "maximum", "best", "2160p", "1080p", "720p", "480p", "360p", "high", "medium", "low",
                     })
            {
                QualityOptions.Add(quality);
            }

            SelectedQuality = "best";
        }
        else
        {
            foreach (var format in new[] { "mp3", "opus", "m4a", "aac", "wav" })
            {
                FormatOptions.Add(format);
            }

            SelectedFormat = "mp3";
            QualityOptions.Clear();
            foreach (var quality in new[] { "maximum", "high", "medium", "low" })
            {
                QualityOptions.Add(quality);
            }

            SelectedQuality = "high";
        }
    }

    partial void OnCurrentPageChanged(string value)
    {
        OnPropertyChanged(nameof(IsDownloadPage));
        OnPropertyChanged(nameof(IsQueuePage));
        OnPropertyChanged(nameof(IsHistoryPage));
        OnPropertyChanged(nameof(DownloadPageVisibility));
        OnPropertyChanged(nameof(QueuePageVisibility));
        OnPropertyChanged(nameof(HistoryPageVisibility));
    }

    partial void OnIsSubmittingDownloadChanged(bool value) =>
        OnPropertyChanged(nameof(SubmitEnabled));

    partial void OnIsClearingHistoryChanged(bool value) =>
        OnPropertyChanged(nameof(HistoryActionsEnabled));

    partial void OnUrlChanged(string value)
    {
        if (_probeMetadata is null || SameVideo(value, _probeMetadata.WebpageUrl))
        {
            return;
        }

        _probeMetadata = null;
        ProbeThumbnail = null;
        MetadataTitle = "No metadata yet";
        MetadataDetails = "Paste a YouTube URL and select Probe to retrieve its metadata.";
    }

    partial void OnIsProbingChanged(bool value) => OnPropertyChanged(nameof(ProbeEnabled));

    partial void OnIsChangingFolderChanged(bool value)
    {
        OnPropertyChanged(nameof(ProbeEnabled));
        OnPropertyChanged(nameof(FolderPickerEnabled));
    }

    private sealed record ProbeMetadata(
        string Title,
        string? Uploader,
        string? ThumbnailUrl,
        double? Duration,
        string WebpageUrl);
}
