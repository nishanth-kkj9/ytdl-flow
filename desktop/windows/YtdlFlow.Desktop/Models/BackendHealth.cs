using System.Text.Json.Serialization;

namespace YtdlFlow.Desktop.Models;

public sealed class BackendHealth
{
    public bool Ok { get; set; }
    public bool EngineReady { get; set; }
    public string Message { get; set; } = "Unknown";
}

public sealed class BackendStatus
{
    [JsonPropertyName("engineReady")]
    public bool EngineReady { get; set; }

    [JsonPropertyName("downloadDir")]
    public string? DownloadDirectory { get; set; }

    [JsonPropertyName("activeJobs")]
    public List<BackendJob> ActiveJobs { get; set; } = [];
}

public sealed class BackendJob
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("fmt")]
    public string? Format { get; set; }

    [JsonPropertyName("quality")]
    public string? Quality { get; set; }

    [JsonPropertyName("mode")]
    public string? Mode { get; set; }
}
