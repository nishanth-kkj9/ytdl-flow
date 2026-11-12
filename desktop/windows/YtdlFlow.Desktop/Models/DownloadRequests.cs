using System.Globalization;
using System.Text.Json.Serialization;

namespace YtdlFlow.Desktop.Models;

public sealed class DownloadRequest
{
    [JsonPropertyName("url")]
    public required string Url { get; init; }

    [JsonPropertyName("mode")]
    public required string Mode { get; init; }

    [JsonPropertyName("format")]
    public required string Format { get; init; }

    [JsonPropertyName("quality")]
    public required string Quality { get; init; }

    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("title")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Title { get; init; }

    [JsonPropertyName("uploader")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Uploader { get; init; }

    [JsonPropertyName("thumbnail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Thumbnail { get; init; }

    [JsonPropertyName("duration")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Duration { get; init; }

    [JsonPropertyName("webpage_url")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? WebpageUrl { get; init; }

    [JsonPropertyName("trim_start")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? TrimStart { get; init; }

    [JsonPropertyName("trim_end")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? TrimEnd { get; init; }
}

public sealed class DownloadSubmissionResponse
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }
}

public sealed class DownloadCancelRequest
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }
}

public sealed class DownloadCancelResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }
}

public sealed class DownloadHistoryRecord
{
    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("fmt")]
    public string? Format { get; set; }

    [JsonPropertyName("size")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)]
    public long? Size { get; set; }

    [JsonPropertyName("duration")]
    [JsonNumberHandling(JsonNumberHandling.AllowReadingFromString)]
    public double? Duration { get; set; }

    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("downloaded_at")]
    public string? DownloadedAt { get; set; }

    [JsonPropertyName("filepath")]
    public string? FilePath { get; set; }

    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("status")]
    public string? Status { get; set; }

    [JsonPropertyName("thumbnail")]
    public string? Thumbnail { get; set; }

    public bool CanOpenFile => !string.IsNullOrWhiteSpace(FilePath);

    public string Summary =>
        string.Join(
            " | ",
            new[]
            {
                Type,
                Format,
                Size is > 0 ? $"{Size.Value.ToString("N0", CultureInfo.InvariantCulture)} bytes" : null,
                Duration is > 0 ? $"{Duration.Value.ToString("0", CultureInfo.InvariantCulture)} seconds" : null,
            }.Where(value => !string.IsNullOrWhiteSpace(value)));
}
