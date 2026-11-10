using System.Net.Http.Json;
using System.Text.Json.Serialization;
using YtdlFlow.Desktop.Models;

namespace YtdlFlow.Desktop.Services;

public sealed class BackendService : IDisposable
{
    private readonly HttpClient _httpClient = new();

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
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<BackendStatus>(
                   cancellationToken: cancellationToken)
               ?? throw new InvalidDataException("The backend returned an empty status response.");
    }

    public async Task<string> ProbeAsync(string url, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/probe", new { url }, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException(
                $"Probe request failed with HTTP {(int)response.StatusCode}: {body}");
        }

        var payload = await response.Content.ReadFromJsonAsync<ProbeResponse>(
            cancellationToken: cancellationToken)
            ?? throw new InvalidDataException("The backend returned an empty probe response.");
        if (string.IsNullOrWhiteSpace(payload.Id))
        {
            throw new InvalidDataException("The backend probe response did not contain a request id.");
        }

        return payload.Id;
    }

    public void Dispose() => _httpClient.Dispose();

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
