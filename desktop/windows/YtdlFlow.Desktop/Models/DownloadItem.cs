namespace YtdlFlow.Desktop.Models;

public sealed class DownloadItem
{
    public string Title { get; set; } = "Untitled";
    public string Status { get; set; } = "queued";
    public string? FilePath { get; set; }
}
