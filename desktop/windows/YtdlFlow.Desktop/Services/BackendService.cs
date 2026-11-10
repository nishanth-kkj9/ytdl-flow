using System.Net.Http.Json;
using YtdlFlow.Desktop.Models;

namespace YtdlFlow.Desktop.Services;

public sealed class BackendService
{
    private readonly HttpClient _httpClient;

    public BackendService(string baseAddress = "http://127.0.0.1:3000")
    {
        _httpClient = new HttpClient
        {
            BaseAddress = new Uri(baseAddress)
        };
    }

    public void SetBaseAddress(string baseAddress)
    {
        _httpClient.BaseAddress = new Uri(baseAddress);
    }

    public async Task<BackendHealth?> GetHealthAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var response = await _httpClient.GetAsync("/api/health", cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                return new BackendHealth { Ok = false, EngineReady = false, Message = $"HTTP {response.StatusCode}" };
            }

            var payload = await response.Content.ReadFromJsonAsync<BackendHealthResponse>(cancellationToken);
            return new BackendHealth
            {
                Ok = payload?.Ok ?? true,
                EngineReady = payload?.EngineReady ?? false,
                Message = payload?.Ok == true ? "Backend reachable" : "Backend responded but engine is not ready",
            };
        }
        catch (Exception ex)
        {
            return new BackendHealth
            {
                Ok = false,
                EngineReady = false,
                Message = ex.Message,
            };
        }
    }

    public async Task<string> ProbeAsync(string url, CancellationToken cancellationToken = default)
    {
        var response = await _httpClient.PostAsJsonAsync("/api/probe", new { url }, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Probe request failed: {response.StatusCode}");
        }

        var payload = await response.Content.ReadFromJsonAsync<ProbeResponse>(cancellationToken);
        return payload?.Title ?? payload?.Url ?? url;
    }

    private sealed class BackendHealthResponse
    {
        public bool Ok { get; set; }
        public bool EngineReady { get; set; }
    }

    private sealed class ProbeResponse
    {
        public string? Title { get; set; }
        public string? Url { get; set; }
    }
}
