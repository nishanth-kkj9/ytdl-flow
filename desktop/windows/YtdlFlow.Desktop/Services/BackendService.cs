using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using YtdlFlow.Desktop.Models;

namespace YtdlFlow.Desktop.Services;

public sealed class BackendService : IDisposable
{
    private readonly HttpClient _httpClient;

    public BackendService()
        : this(new HttpClient())
    {
    }

    internal BackendService(HttpMessageHandler handler)
        : this(new HttpClient(handler))
    {
    }

    private BackendService(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public void SetBaseAddress(Uri baseAddress)
    {
        _httpClient.BaseAddress = BackendSupervisor.ValidateBackendAddress(baseAddress);
    }

    public async Task<BackendHealth> GetHealthAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.GetAsync("/api/health", cancellationToken);
        response.EnsureSuccessStatusCode();
        var payload = await response.Content.ReadFromJsonAsync<BackendHealthResponse>(
            cancellationToken: cancellationToken)
            ?? throw new InvalidDataException("The backend returned an empty health response.");

        return new BackendHealth
        {
            Ok = payload.Ok,
            EngineReady = payload.EngineReady,
            Message = payload.EngineReady ? "Engine ready" : "Server live, engine starting",
        };
    }

    public async Task<BackendStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.GetAsync("/api/status", cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        var status = await response.Content.ReadFromJsonAsync<BackendStatus>(
                   cancellationToken: cancellationToken)
               ?? throw new InvalidDataException("The backend returned an empty status response.");
        if (status.ActiveJobs is null)
        {
            throw new InvalidDataException("The backend status response did not contain an active job list.");
        }

        if (status.ActiveJobs.Any(job =>
                string.IsNullOrWhiteSpace(job.Id) ||
                string.IsNullOrWhiteSpace(job.Status)))
        {
            throw new InvalidDataException("The backend returned an incomplete active job.");
        }

        return status;
    }

    public async Task<string> ProbeAsync(string url, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/probe", new { url }, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var payload = await response.Content.ReadFromJsonAsync<ProbeResponse>(
            cancellationToken: cancellationToken)
            ?? throw new InvalidDataException("The backend returned an empty probe response.");
        if (string.IsNullOrWhiteSpace(payload.Id))
        {
            throw new InvalidDataException("The backend probe response did not contain a request id.");
        }

        return payload.Id;
    }

    public async Task<string> SubmitDownloadAsync(
        DownloadRequest request,
        CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync(
            "/api/download",
            request,
            cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var payload = await response.Content.ReadFromJsonAsync<DownloadSubmissionResponse>(
            cancellationToken: cancellationToken)
            ?? throw new InvalidDataException("The backend returned an empty download response.");
        if (string.IsNullOrWhiteSpace(payload.Id))
        {
            throw new InvalidDataException("The backend download response did not contain a job id.");
        }

        if (!string.Equals(payload.Id, request.Id, StringComparison.Ordinal))
        {
            throw new InvalidDataException("The backend acknowledged a different download job id.");
        }

        return payload.Id;
    }

    public async Task CancelDownloadAsync(string id, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync(
            "/api/download/cancel",
            new DownloadCancelRequest { Id = id },
            cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var payload = await response.Content.ReadFromJsonAsync<DownloadCancelResponse>(
            cancellationToken: cancellationToken)
            ?? throw new InvalidDataException("The backend returned an empty cancellation response.");
        if (!payload.Ok)
        {
            throw new InvalidOperationException("The backend did not accept the cancellation request.");
        }
    }

    public async Task<IReadOnlyList<DownloadHistoryRecord>> GetHistoryAsync(
        CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.GetAsync(
            "/api/history?limit=100&offset=0",
            cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var records = await response.Content.ReadFromJsonAsync<List<DownloadHistoryRecord>>(
            cancellationToken: cancellationToken)
            ?? throw new InvalidDataException("The backend returned an empty download history response.");
        if (records.Count > 100)
        {
            throw new InvalidDataException("The backend returned more than 100 history records.");
        }

        return records;
    }

    public async Task ClearHistoryAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.DeleteAsync("/api/history", cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);

        var payload = await response.Content.ReadFromJsonAsync<DownloadCancelResponse>(
            cancellationToken: cancellationToken)
            ?? throw new InvalidDataException("The backend returned an empty history response.");
        if (!payload.Ok)
        {
            throw new InvalidOperationException("The backend did not confirm clearing download history.");
        }
    }

    public void Dispose() => _httpClient.Dispose();

    private static async Task EnsureSuccessAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        var message = body;
        if (!string.IsNullOrWhiteSpace(body))
        {
            try
            {
                using var document = JsonDocument.Parse(body);
                var root = document.RootElement;
                if (root.ValueKind == JsonValueKind.Object &&
                    (root.TryGetProperty("error", out var error) ||
                     root.TryGetProperty("message", out error)) &&
                    error.ValueKind == JsonValueKind.String)
                {
                    message = error.GetString() ?? body;
                }
            }
            catch (JsonException)
            {
                message = body;
            }
        }

        if (string.IsNullOrWhiteSpace(message))
        {
            message = response.ReasonPhrase ?? "The backend request failed.";
        }

        throw new HttpRequestException(
            $"Backend request failed with HTTP {(int)response.StatusCode}: {message}",
            null,
            response.StatusCode);
    }

    private sealed class BackendHealthResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("engineReady")]
        public bool EngineReady { get; set; }
    }

    private sealed class ProbeResponse
    {
        [JsonPropertyName("id")]
        public string? Id { get; set; }
    }
}
