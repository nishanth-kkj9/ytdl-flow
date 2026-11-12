using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using YtdlFlow.Desktop.Models;
using YtdlFlow.Desktop.Services;
using YtdlFlow.Desktop.ViewModels;
using Xunit;

namespace YtdlFlow.Desktop.Tests;

public sealed class DownloadWorkflowTests
{
    [Fact]
    public void DownloadItemPreservesCancellationAcrossLateResults()
    {
        var item = NewItem();
        item.ApplyProgress(50, 100, 25, "video.mp4");

        Assert.Equal(DownloadStatus.Downloading, item.Status);
        Assert.Equal(50, item.ProgressPercent);
        Assert.Contains("25", item.ProgressDetails);
        Assert.True(item.BeginCancellation());
        Assert.Equal(DownloadStatus.Cancelling, item.Status);
        Assert.True(item.ApplyCancelled());

        Assert.False(item.ApplyResult("Finished title", @"C:\downloads\video.mp4"));
        Assert.Equal(DownloadStatus.Cancelled, item.Status);
        Assert.Equal("Finished title", item.Title);
        Assert.Equal(@"C:\downloads\video.mp4", item.FilePath);
        Assert.False(item.ApplyFailure("late failure"));
    }

    [Fact]
    public void CancellationWaitsForSubmissionAcknowledgementAndRestoresStateOnRequestFailure()
    {
        var item = NewItem();

        Assert.True(item.BeginCancellation());
        Assert.True(item.AcknowledgeSubmission());
        Assert.Equal(DownloadStatus.Cancelling, item.Status);

        item.CancellationRequestFailed("cancel endpoint unavailable");

        Assert.Equal(DownloadStatus.Downloading, item.Status);
        Assert.Equal("cancel endpoint unavailable", item.ErrorMessage);
    }

    [Fact]
    public void FailureEventCannotFinishACancellationBeforeCancelledEventArrives()
    {
        var item = NewItem();
        item.AcknowledgeSubmission();
        Assert.True(item.BeginCancellation());

        Assert.False(item.ApplyFailure("worker stopped"));
        Assert.Equal(DownloadStatus.Cancelling, item.Status);
        Assert.True(item.ApplyCancelled());
        Assert.Equal(DownloadStatus.Cancelled, item.Status);
    }

    [Fact]
    public void CancellationErrorBecomesUnknownAndCanBeRecoveredByAnActiveSnapshot()
    {
        var queue = new DownloadQueue();
        var item = NewItem();
        Assert.True(queue.TryAdd(item));
        item.AcknowledgeSubmission();
        Assert.True(item.BeginCancellation());

        item.CancellationResolutionUnknown("cancel target was no longer active");

        Assert.Equal(DownloadStatus.Unknown, item.Status);
        Assert.False(item.CanCancel);
        Assert.True(queue.Reconcile(
            [new BackendJob { Id = item.Id, Status = "running" }],
            engineReady: true));
        Assert.Equal(DownloadStatus.Downloading, item.Status);
    }

    [Fact]
    public void QueueReconciliationIsConservativeAndDoesNotResurrectTerminalRows()
    {
        var queue = new DownloadQueue();
        var job = new BackendJob
        {
            Id = "job-1",
            Status = "running",
            Url = "https://youtu.be/abcdefghijk",
            Format = "mp4",
            Quality = "best",
            Mode = "video",
        };

        Assert.False(queue.Reconcile([job], engineReady: false));
        Assert.Empty(queue);
        Assert.True(queue.Reconcile([job], engineReady: true));
        var item = Assert.Single(queue);
        Assert.Equal(DownloadStatus.Downloading, item.Status);
        Assert.Equal("video", item.Mode);

        Assert.True(queue.Reconcile([], engineReady: true));
        Assert.Equal(DownloadStatus.Downloading, item.Status);
        Assert.True(queue.Reconcile([], engineReady: true, markMissingUnknown: true));
        Assert.Equal(DownloadStatus.Unknown, item.Status);

        Assert.True(queue.Reconcile([job], engineReady: true, markMissingUnknown: true));
        Assert.Equal(DownloadStatus.Downloading, item.Status);
        Assert.True(item.ApplyFailure("failed"));
        Assert.True(queue.Reconcile([job], engineReady: true, markMissingUnknown: true));
        Assert.Equal(DownloadStatus.Failed, item.Status);
    }

    [Fact]
    public void QueueRejectsDuplicateIdsAndEvictsOnlyTerminalRowsAtItsBound()
    {
        var queue = new DownloadQueue();
        var first = NewItem("duplicate");
        Assert.True(queue.TryAdd(first));
        Assert.False(queue.TryAdd(NewItem("duplicate")));

        first.ApplyFailure("done");
        for (var index = 1; index < DownloadQueue.MaximumItems; index++)
        {
            Assert.True(queue.TryAdd(NewItem($"job-{index}")));
        }

        Assert.True(queue.TryAdd(NewItem("last")));
        Assert.Equal(DownloadQueue.MaximumItems, queue.Count);
        Assert.Null(queue.Find("duplicate"));
        Assert.NotNull(queue.Find("last"));
    }

    [Theory]
    [InlineData("audio", "aac", "maximum", true)]
    [InlineData("video", "mkv", "2160p", true)]
    [InlineData("video", "aac", "best", false)]
    [InlineData("audio", "mp3", "2160p", false)]
    public void DownloadSelectionMatchesBackendOptions(
        string mode,
        string format,
        string quality,
        bool expected)
    {
        Assert.Equal(expected, MainViewModel.IsValidDownloadSelection(mode, format, quality));
    }

    [Fact]
    public void TrimValidationAcceptsSecondsAndClockValuesAndRejectsPartialOrInvalidWindows()
    {
        Assert.True(MainViewModel.TryParseTrimWindow(
            "1.5",
            "00:01:30",
            out var start,
            out var end,
            out var error));
        Assert.Equal(1.5, start);
        Assert.Equal(90, end);
        Assert.Empty(error);

        Assert.False(MainViewModel.TryParseTrimWindow(
            "00:60",
            "02:00",
            out _,
            out _,
            out _));
        Assert.False(MainViewModel.TryParseTrimWindow(
            "10",
            "",
            out _,
            out _,
            out _));
        Assert.False(MainViewModel.TryParseTrimWindow(
            "20",
            "10",
            out _,
            out _,
            out _));
    }

    [Fact]
    public void ProbeMetadataMatchesCanonicalVideoIdsAndThumbnailsRequireTrustedHttpsHosts()
    {
        Assert.True(MainViewModel.SameVideo(
            "https://youtu.be/abcdefghijk",
            "https://music.youtube.com/watch?v=abcdefghijk"));
        Assert.False(MainViewModel.SameVideo(
            "https://youtu.be/abcdefghijk",
            "https://youtube.com/watch?v=lmnopqrstuv"));
        Assert.True(MainViewModel.IsAllowedThumbnail(
            "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"));
        Assert.False(MainViewModel.IsAllowedThumbnail(
            "http://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"));
        Assert.False(MainViewModel.IsAllowedThumbnail(
            "https://i.ytimg.com.attacker.invalid/thumbnail.jpg"));
    }

    [Fact]
    public async Task DownloadSubmissionSerializesBackendContractAndChecksAcknowledgedId()
    {
        const string expectedId = "8ed83c5e-2aed-49d4-a5ba-1a9c1ef4e18a";
        string? receivedBody = null;
        using var service = CreateBackendService(async (request, cancellationToken) =>
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal("/api/download", request.RequestUri?.AbsolutePath);
            receivedBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return JsonResponse(HttpStatusCode.OK, $$"""{"id":"{{expectedId}}"}""");
        });

        var responseId = await service.SubmitDownloadAsync(new DownloadRequest
        {
            Url = "https://www.youtube.com/watch?v=abcdefghijk",
            Mode = "audio",
            Format = "mp3",
            Quality = "high",
            Id = expectedId,
            Title = "A title",
            Uploader = "An artist",
            Duration = 125,
            WebpageUrl = "https://www.youtube.com/watch?v=abcdefghijk",
            TrimStart = 5,
            TrimEnd = 25,
        });

        Assert.Equal(expectedId, responseId);
        using var json = JsonDocument.Parse(receivedBody!);
        var payload = json.RootElement;
        Assert.Equal("audio", payload.GetProperty("mode").GetString());
        Assert.Equal("mp3", payload.GetProperty("format").GetString());
        Assert.Equal(expectedId, payload.GetProperty("id").GetString());
        Assert.Equal(5, payload.GetProperty("trim_start").GetDouble());
        Assert.Equal(25, payload.GetProperty("trim_end").GetDouble());
        Assert.False(payload.TryGetProperty("unknown", out _));
    }

    [Fact]
    public async Task BackendErrorsExposeSafeJsonMessageAndStatusCode()
    {
        using var service = CreateBackendService((_, _) =>
            Task.FromResult(JsonResponse(HttpStatusCode.BadRequest, """{"error":"unsupported quality"}""")));

        var error = await Assert.ThrowsAsync<HttpRequestException>(
            () => service.SubmitDownloadAsync(new DownloadRequest
            {
                Url = "https://youtu.be/abcdefghijk",
                Mode = "audio",
                Format = "mp3",
                Quality = "invalid",
                Id = "job-1",
            }));

        Assert.Equal(HttpStatusCode.BadRequest, error.StatusCode);
        Assert.Contains("unsupported quality", error.Message);
    }

    [Fact]
    public async Task StatusSnapshotDeserializesActiveJobMetadata()
    {
        using var service = CreateBackendService((_, _) =>
            Task.FromResult(JsonResponse(
                HttpStatusCode.OK,
                """{"engineReady":true,"downloadDir":"C:\\downloads","activeJobs":[{"id":"job-1","status":"running","url":"https://youtu.be/abcdefghijk","fmt":"mp4","quality":"best","mode":"video"}]}""")));

        var status = await service.GetStatusAsync();

        Assert.True(status.EngineReady);
        Assert.Equal(@"C:\downloads", status.DownloadDirectory);
        var job = Assert.Single(status.ActiveJobs);
        Assert.Equal("running", job.Status);
        Assert.Equal("video", job.Mode);
        Assert.Equal("mp4", job.Format);
    }

    [Fact]
    public async Task CancelAndHistoryUseBackendOwnedEndpointsAndExactHistoryShape()
    {
        var requests = new List<string>();
        using var service = CreateBackendService(async (request, cancellationToken) =>
        {
            requests.Add($"{request.Method} {request.RequestUri?.PathAndQuery}");
            if (request.RequestUri?.AbsolutePath == "/api/download/cancel")
            {
                var body = await request.Content!.ReadAsStringAsync(cancellationToken);
                Assert.Contains("\"id\":\"job-1\"", body);
                return JsonResponse(HttpStatusCode.OK, """{"ok":true}""");
            }

            if (request.Method == HttpMethod.Delete)
            {
                return JsonResponse(HttpStatusCode.OK, """{"ok":true}""");
            }

            return JsonResponse(
                HttpStatusCode.OK,
                """[{"id":"job-1","title":"A video","fmt":"mp4","size":"123","duration":"10","url":"https://youtu.be/abcdefghijk","downloaded_at":"2026-01-02T03:04:05.000Z","filepath":"C:\\downloads\\video.mp4","type":"video","status":"completed","thumbnail":"https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"}]""");
        });

        await service.CancelDownloadAsync("job-1");
        var history = await service.GetHistoryAsync();
        await service.ClearHistoryAsync();

        var record = Assert.Single(history);
        Assert.Equal("A video", record.Title);
        Assert.Equal("mp4", record.Format);
        Assert.Equal(123, record.Size);
        Assert.Equal(@"C:\downloads\video.mp4", record.FilePath);
        Assert.Equal(
            [
                "POST /api/download/cancel",
                "GET /api/history?limit=100&offset=0",
                "DELETE /api/history",
            ],
            requests);
    }

    [Fact]
    public void FileActionsRejectPathsOutsideDownloadRootAndUseArgumentListForExplorer()
    {
        using var temporary = new TemporaryDirectory();
        var root = Path.Combine(temporary.Path, "downloads");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "video with spaces.mp4");
        File.WriteAllText(path, "video");
        var outsidePath = Path.Combine(temporary.Path, "outside.mp4");
        File.WriteAllText(outsidePath, "outside");
        ProcessStartInfo? launched = null;
        var service = new DownloadFileService(root, info => launched = info);

        Assert.Equal(Path.GetFullPath(path), service.ResolveExistingFile("video with spaces.mp4"));
        Assert.Throws<UnauthorizedAccessException>(() => service.ResolveExistingFile(outsidePath));
        service.OpenFile(path);
        Assert.Equal(Path.GetFullPath(path), launched?.FileName);
        Assert.True(launched!.UseShellExecute);

        service.RevealInExplorer(path);

        Assert.Equal("explorer.exe", launched?.FileName);
        Assert.True(launched!.UseShellExecute);
        Assert.Equal($"/select,{Path.GetFullPath(path)}", Assert.Single(launched!.ArgumentList));
    }

    [Fact]
    public void EventHandlingFollowsLifecycleAndProtectsTerminalStates()
    {
        var item = NewItem("lifecycle-job");
        Assert.Equal(DownloadStatus.Starting, item.Status);
        Assert.True(item.CanCancel);
        Assert.False(item.CanRetry);

        item.ApplyStarted();
        Assert.Equal(DownloadStatus.Downloading, item.Status);

        item.ApplyProgress(500, 1000, 250, @"C:\downloads\sample.mp4");
        Assert.Equal(50, item.ProgressPercent);
        Assert.Equal("sample.mp4", item.FileName);
        Assert.Equal(500, item.DownloadedBytes);
        Assert.Equal(1000, item.TotalBytes);
        Assert.Equal(250, item.SpeedBytesPerSecond);
        Assert.Contains("500 B / 1000 B", item.ProgressDetails);

        // Malformed progress values should be ignored safely without breaking existing progress
        item.ApplyProgress(-10, -500, double.NaN, null);
        Assert.Equal(500, item.DownloadedBytes);
        Assert.Equal(1000, item.TotalBytes);
        Assert.Equal(250, item.SpeedBytesPerSecond);
        Assert.Equal("sample.mp4", item.FileName);

        // The engine's "finished" sentinel reports 0/0/0; it must not erase progress
        item.ApplyProgress(0, 0, 0, null);
        Assert.Equal(500, item.DownloadedBytes);
        Assert.Equal(1000, item.TotalBytes);
        Assert.Equal(250, item.SpeedBytesPerSecond);

        item.ApplyRetry("Transient network issue");
        Assert.Equal(DownloadStatus.Retrying, item.Status);
        Assert.Equal("Transient network issue", item.ErrorMessage);

        // Applying result transitions to Completed and updates fields
        Assert.True(item.ApplyResult("Sample Video", @"C:\downloads\sample.mp4"));
        Assert.Equal(DownloadStatus.Completed, item.Status);
        Assert.Equal("Sample Video", item.Title);
        Assert.Equal(@"C:\downloads\sample.mp4", item.FilePath);
        Assert.True(item.CanOpenFile);
        Assert.False(item.CanCancel);
        Assert.False(item.CanRetry);
        Assert.False(item.IsActive);
        Assert.Equal(100, item.ProgressPercent);

        // Late events on a completed item must be ignored
        item.ApplyProgress(200, 1000, 50, "other.mp4");
        Assert.Equal(1000, item.DownloadedBytes);
        Assert.False(item.ApplyFailure("late error"));
        item.ApplyRetry("late retry");
        Assert.False(item.ApplyCancelled());
        Assert.False(item.ApplyResult("duplicate", @"C:\downloads\other.mp4"));
        Assert.Equal(DownloadStatus.Completed, item.Status);
    }

    [Fact]
    public void FailedJobAllowsRetryWithFreshIdAndCleanState()
    {
        var original = new DownloadItem(
            "job-fail-1",
            "https://youtu.be/abcdefghijk",
            "audio",
            "mp3",
            "high",
            title: "Music Track",
            uploader: "Artist",
            thumbnailUrl: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
            duration: 180,
            trimStart: 10,
            trimEnd: 40);

        original.ApplyProgress(100, 500, 50, "track.mp3");
        Assert.True(original.ApplyFailure("Download timed out"));
        Assert.Equal(DownloadStatus.Failed, original.Status);
        Assert.True(original.CanRetry);
        Assert.False(original.CanCancel);

        // Retrying creates a new item with a fresh ID, reset progress and error, and preserved parameters
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

        Assert.NotEqual(original.Id, retry.Id);
        Assert.Equal(original.Url, retry.Url);
        Assert.Equal(original.Mode, retry.Mode);
        Assert.Equal(original.Format, retry.Format);
        Assert.Equal(original.Quality, retry.Quality);
        Assert.Equal(original.Title, retry.Title);
        Assert.Equal(original.TrimStart, retry.TrimStart);
        Assert.Equal(original.TrimEnd, retry.TrimEnd);
        Assert.Equal(DownloadStatus.Starting, retry.Status);
        Assert.Equal(0, retry.DownloadedBytes);
        Assert.Null(retry.ErrorMessage);

        original.RetrySubmitted = true;
        Assert.False(original.CanRetry);
    }

    [Fact]
    public async Task BackendServiceValidatesResponsesAndRejectsMalformedPayloads()
    {
        // Response missing ID
        using var missingIdService = CreateBackendService((_, _) =>
            Task.FromResult(JsonResponse(HttpStatusCode.OK, """{"id":""}""")));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            missingIdService.SubmitDownloadAsync(new DownloadRequest
            {
                Url = "https://youtu.be/abcdefghijk",
                Mode = "audio",
                Format = "mp3",
                Quality = "high",
                Id = "expected-id",
            }));

        // Response with mismatched ID
        using var mismatchIdService = CreateBackendService((_, _) =>
            Task.FromResult(JsonResponse(HttpStatusCode.OK, """{"id":"different-id"}""")));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            mismatchIdService.SubmitDownloadAsync(new DownloadRequest
            {
                Url = "https://youtu.be/abcdefghijk",
                Mode = "audio",
                Format = "mp3",
                Quality = "high",
                Id = "expected-id",
            }));

        // Cancellation returning ok: false
        using var cancelFailService = CreateBackendService((_, _) =>
            Task.FromResult(JsonResponse(HttpStatusCode.OK, """{"ok":false}""")));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            cancelFailService.CancelDownloadAsync("job-1"));

        // Clear history returning ok: false
        using var clearFailService = CreateBackendService((_, _) =>
            Task.FromResult(JsonResponse(HttpStatusCode.OK, """{"ok":false}""")));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            clearFailService.ClearHistoryAsync());
    }

    [Fact]
    public void FileServiceRejectsMissingAndInvalidFiles()
    {
        using var temporary = new TemporaryDirectory();
        var root = Path.Combine(temporary.Path, "downloads");
        Directory.CreateDirectory(root);
        var service = new DownloadFileService(root);

        Assert.Throws<ArgumentException>(() => service.ResolveExistingFile("   "));
        Assert.Throws<FileNotFoundException>(() => service.ResolveExistingFile("nonexistent.mp4"));
        Assert.Throws<UnauthorizedAccessException>(() => service.ResolveExistingFile(@"..\secret.txt"));
    }

    [Fact]
    public void HistoryRecordCalculatesSummaryAndCanOpenFileAccurately()
    {
        var record = new DownloadHistoryRecord
        {
            Id = "hist-1",
            Title = "Video Title",
            Format = "mp4",
            Type = "video",
            Size = 10485760,
            Duration = 120,
            FilePath = @"C:\downloads\video.mp4",
            DownloadedAt = "2026-03-01T12:00:00Z",
        };

        Assert.True(record.CanOpenFile);
        Assert.Contains("video", record.Summary);
        Assert.Contains("mp4", record.Summary);
        Assert.Contains("10,485,760 bytes", record.Summary);
        Assert.Contains("120 seconds", record.Summary);

        var emptyRecord = new DownloadHistoryRecord { Id = "hist-2" };
        Assert.False(emptyRecord.CanOpenFile);
        Assert.Empty(emptyRecord.Summary);
    }

    private static DownloadItem NewItem(string id = "job-1") =>
        new(id, "https://youtu.be/abcdefghijk", "video", "mp4", "best");

    private static BackendService CreateBackendService(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond)
    {
        var service = new BackendService(new CallbackHandler(respond));
        service.SetBaseAddress(new Uri("http://127.0.0.1:49173"));
        return service;
    }

    private static HttpResponseMessage JsonResponse(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class CallbackHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            respond(request, cancellationToken);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "ytdl-flow-download-tests",
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
