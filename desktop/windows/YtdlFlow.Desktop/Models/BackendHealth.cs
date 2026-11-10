namespace YtdlFlow.Desktop.Models;

public sealed class BackendHealth
{
    public bool Ok { get; set; }
    public bool EngineReady { get; set; }
    public string Message { get; set; } = "Unknown";
}
