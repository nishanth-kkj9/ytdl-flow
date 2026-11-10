using YtdlFlow.Desktop.Services;
using Xunit;

namespace YtdlFlow.Desktop.Tests;

public sealed class SettingsServiceTests
{
    [Fact]
    public void FolderChangeRollbackRestoresThePreviouslySavedDirectory()
    {
        using var directory = new TemporaryDirectory();
        var settings = new SettingsService(directory.Path);
        var previous = Path.Combine(directory.Path, "previous");
        var requested = Path.Combine(directory.Path, "requested");

        settings.SaveDownloadDirectory(previous);
        settings.SaveDownloadDirectory(requested);
        settings.SaveDownloadDirectory(previous);

        Assert.Equal(Path.GetFullPath(previous), settings.LoadDownloadDirectory());
    }

    [Fact]
    public void BackendEnvironmentUsesLocalDataAndAbsoluteSharedBackendPaths()
    {
        using var directory = new TemporaryDirectory();
        var settings = new SettingsService(Path.Combine(directory.Path, "local-app-data"));
        var root = Path.Combine(directory.Path, "repository");
        var download = Path.Combine(directory.Path, "downloads");

        var environment = settings.CreateBackendEnvironment(root, download);

        Assert.Equal(Path.GetFullPath(Path.Combine(root, "dist")), environment["YTDL_DIST_DIR"]);
        Assert.Equal(Path.GetFullPath(Path.Combine(root, "python-engine", "ipc_main.py")), environment["YTDL_ENGINE_ENTRY"]);
        Assert.Equal(Path.GetFullPath(Path.Combine(root, "python-engine")), environment["YTDL_ENGINE_CWD"]);
        Assert.Equal(Path.GetFullPath(download), environment["YTDL_DOWNLOADS_DIR"]);
        Assert.Equal(Path.Combine(settings.ApplicationDataDirectory, "data"), environment["YTDL_DATA_DIR"]);
        Assert.Equal(Path.Combine(settings.ApplicationDataDirectory, "logs"), environment["YTDL_LOG_DIR"]);
        Assert.DoesNotContain("YTDL_COOKIES_FILE", environment.Keys);
        Assert.DoesNotContain("DENO", environment.Keys);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "ytdl-flow-settings-tests",
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
