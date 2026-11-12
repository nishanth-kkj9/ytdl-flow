using CommunityToolkit.Mvvm.ComponentModel;

namespace YtdlFlow.Desktop.Models;

public enum DownloadStatus
{
    Queued,
    Starting,
    Downloading,
    Retrying,
    Cancelling,
    Unknown,
    Completed,
    Failed,
    Cancelled,
}

public sealed partial class DownloadItem : ObservableObject
{
    private DownloadStatus _status;
    private DownloadStatus _statusBeforeCancellation;

    public DownloadItem(
        string id,
        string url,
        string mode,
        string format,
        string quality,
        string? title = null,
        string? uploader = null,
        string? thumbnailUrl = null,
        double? duration = null,
        double? trimStart = null,
        double? trimEnd = null)
    {
        Id = id;
        Url = url;
        Mode = mode;
        Format = format;
        Quality = quality;
        Title = string.IsNullOrWhiteSpace(title) ? "Untitled" : title;
        Uploader = uploader;
        ThumbnailUrl = thumbnailUrl;
        Duration = duration;
        TrimStart = trimStart;
        TrimEnd = trimEnd;
        _status = DownloadStatus.Starting;
        _statusBeforeCancellation = DownloadStatus.Starting;
    }

    public string Id { get; }

    public string Url { get; }

    public string Mode { get; }

    public string Format { get; }

    public string Quality { get; }

    public string JobDetails => $"{Mode} | {Format} | {Quality}";

    public string? Uploader { get; }

    public string? ThumbnailUrl { get; }

    public double? Duration { get; }

    public double? TrimStart { get; }

    public double? TrimEnd { get; }

    [ObservableProperty]
    private string title = "Untitled";

    [ObservableProperty]
    private string? filePath;

    [ObservableProperty]
    private string? errorMessage;

    [ObservableProperty]
    private string? fileName;

    [ObservableProperty]
    private long downloadedBytes;

    [ObservableProperty]
    private long totalBytes;

    [ObservableProperty]
    private double speedBytesPerSecond;

    [ObservableProperty]
    private bool submissionAcknowledged;

    [ObservableProperty]
    private bool retrySubmitted;

    public DownloadStatus Status
    {
        get => _status;
        private set
        {
            if (!SetProperty(ref _status, value))
            {
                return;
            }

            OnPropertyChanged(nameof(StatusLabel));
            OnPropertyChanged(nameof(ProgressPercent));
            OnPropertyChanged(nameof(CanCancel));
            OnPropertyChanged(nameof(CanRetry));
            OnPropertyChanged(nameof(IsActive));
        }
    }

    public string StatusLabel => Status switch
    {
        DownloadStatus.Queued => "Queued",
        DownloadStatus.Starting => "Submitting",
        DownloadStatus.Downloading => "Downloading",
        DownloadStatus.Retrying => "Retrying",
        DownloadStatus.Cancelling => "Cancelling",
        DownloadStatus.Unknown => "Status unknown",
        DownloadStatus.Completed => "Completed",
        DownloadStatus.Failed => "Failed",
        DownloadStatus.Cancelled => "Cancelled",
        _ => "Unknown",
    };

    public double ProgressPercent => TotalBytes > 0
        ? Math.Clamp(DownloadedBytes * 100d / TotalBytes, 0, 100)
        : 0;

    public bool CanCancel => Status is DownloadStatus.Queued or
        DownloadStatus.Starting or DownloadStatus.Downloading or DownloadStatus.Retrying;

    public bool CanRetry => Status == DownloadStatus.Failed && !RetrySubmitted;

    public bool CanOpenFile => !string.IsNullOrWhiteSpace(FilePath);

    public bool IsActive => Status is DownloadStatus.Queued or
        DownloadStatus.Starting or DownloadStatus.Downloading or DownloadStatus.Retrying or
        DownloadStatus.Cancelling or DownloadStatus.Unknown;

    public bool BeginCancellation()
    {
        if (!CanCancel)
        {
            return false;
        }

        _statusBeforeCancellation = Status;
        Status = DownloadStatus.Cancelling;
        return true;
    }

    public bool AcknowledgeSubmission()
    {
        SubmissionAcknowledged = true;
        if (Status == DownloadStatus.Cancelling)
        {
            return true;
        }

        if (!IsTerminal(Status))
        {
            Status = DownloadStatus.Downloading;
        }

        return false;
    }

    public void ApplyStarted()
    {
        if (!IsTerminal(Status) && Status != DownloadStatus.Cancelling)
        {
            Status = DownloadStatus.Downloading;
        }
    }

    public void ApplyProgress(long? downloaded, long? total, double? speed, string? currentFileName)
    {
        if (IsTerminal(Status))
        {
            return;
        }

        if (downloaded is >= 0)
        {
            DownloadedBytes = downloaded.Value;
        }

        if (total is > 0)
        {
            TotalBytes = total.Value;
        }

        if (speed is >= 0 && double.IsFinite(speed.Value))
        {
            SpeedBytesPerSecond = speed.Value;
        }

        if (!string.IsNullOrWhiteSpace(currentFileName))
        {
            FileName = Path.GetFileName(currentFileName);
        }

        if (Status != DownloadStatus.Cancelling)
        {
            Status = DownloadStatus.Downloading;
        }

        OnPropertyChanged(nameof(ProgressPercent));
    }

    public void ApplyRetry(string? message)
    {
        if (IsTerminal(Status) || Status == DownloadStatus.Cancelling)
        {
            return;
        }

        ErrorMessage = message;
        Status = DownloadStatus.Retrying;
    }

    public bool ApplyResult(string? title, string? path)
    {
        if (Status == DownloadStatus.Cancelled)
        {
            AttachResultDetails(title, path);
            return false;
        }

        if (IsTerminal(Status))
        {
            return false;
        }

        AttachResultDetails(title, path);
        ErrorMessage = null;
        Status = DownloadStatus.Completed;
        if (TotalBytes > 0)
        {
            DownloadedBytes = TotalBytes;
            OnPropertyChanged(nameof(ProgressPercent));
        }

        return true;
    }

    public bool ApplyFailure(string? message)
    {
        if (IsTerminal(Status))
        {
            return false;
        }

        ErrorMessage = string.IsNullOrWhiteSpace(message) ? "The download failed." : message;
        if (Status == DownloadStatus.Cancelling)
        {
            return false;
        }

        Status = DownloadStatus.Failed;
        return true;
    }

    public void SubmissionFailed(string message, bool outcomeUnknown)
    {
        if (IsTerminal(Status))
        {
            return;
        }

        ErrorMessage = message;
        Status = outcomeUnknown ? DownloadStatus.Unknown : DownloadStatus.Failed;
    }

    public bool ApplyCancelled()
    {
        if (Status is DownloadStatus.Completed or DownloadStatus.Failed or DownloadStatus.Cancelled)
        {
            return false;
        }

        ErrorMessage = null;
        Status = DownloadStatus.Cancelled;
        return true;
    }

    public void CancellationRequestFailed(string message)
    {
        if (Status != DownloadStatus.Cancelling)
        {
            return;
        }

        ErrorMessage = message;
        Status = SubmissionAcknowledged
            ? DownloadStatus.Downloading
            : _statusBeforeCancellation;
    }

    public void CancellationResolutionUnknown(string message)
    {
        if (Status != DownloadStatus.Cancelling)
        {
            return;
        }

        ErrorMessage = message;
        Status = DownloadStatus.Unknown;
    }

    public void ApplyBackendStatus(string? status)
    {
        if (IsTerminal(Status) || Status == DownloadStatus.Cancelling)
        {
            return;
        }

        if (string.Equals(status, "queued", StringComparison.OrdinalIgnoreCase))
        {
            Status = DownloadStatus.Queued;
        }
        else if (string.Equals(status, "running", StringComparison.OrdinalIgnoreCase))
        {
            Status = DownloadStatus.Downloading;
        }
        else
        {
            MarkUnknown();
            return;
        }

        SubmissionAcknowledged = true;
    }

    public void MarkUnknown()
    {
        if (!IsTerminal(Status) && Status != DownloadStatus.Cancelling)
        {
            Status = DownloadStatus.Unknown;
        }
    }

    partial void OnRetrySubmittedChanged(bool value) =>
        OnPropertyChanged(nameof(CanRetry));

    partial void OnFilePathChanged(string? value) =>
        OnPropertyChanged(nameof(CanOpenFile));

    partial void OnDownloadedBytesChanged(long value) =>
        OnPropertyChanged(nameof(ProgressDetails));

    partial void OnTotalBytesChanged(long value) =>
        OnPropertyChanged(nameof(ProgressDetails));

    partial void OnSpeedBytesPerSecondChanged(double value) =>
        OnPropertyChanged(nameof(ProgressDetails));

    public string ProgressDetails =>
        $"{FormatBytes(DownloadedBytes)} / {FormatBytes(TotalBytes)} | {FormatSpeed(SpeedBytesPerSecond)}";

    public void ApplyHistory(string? title, string? path)
    {
        if (Status == DownloadStatus.Cancelled)
        {
            AttachResultDetails(title, path);
            return;
        }

        if (!IsTerminal(Status))
        {
            AttachResultDetails(title, path);
            Status = DownloadStatus.Completed;
        }
    }

    private void AttachResultDetails(string? title, string? path)
    {
        if (!string.IsNullOrWhiteSpace(title))
        {
            Title = title;
        }

        if (!string.IsNullOrWhiteSpace(path))
        {
            FilePath = path;
        }
    }

    private static bool IsTerminal(DownloadStatus status) =>
        status is DownloadStatus.Completed or DownloadStatus.Failed or DownloadStatus.Cancelled;

    private static string FormatBytes(long value)
    {
        if (value <= 0)
        {
            return "0 B";
        }

        var units = new[] { "B", "KB", "MB", "GB", "TB" };
        var size = (double)value;
        var unit = 0;
        while (size >= 1024 && unit < units.Length - 1)
        {
            size /= 1024;
            unit++;
        }

        return $"{size:0.##} {units[unit]}";
    }

    private static string FormatSpeed(double value) =>
        value > 0 && double.IsFinite(value)
            ? $"{FormatBytes((long)Math.Min(value, long.MaxValue))}/s"
            : "n/a";
}
