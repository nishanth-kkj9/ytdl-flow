using System.Text.Json;

namespace YtdlFlow.Desktop.Services;

public sealed class SettingsService
{
    private readonly string _settingsDirectory;
    private readonly string _settingsFilePath;

    public SettingsService(string? applicationDataDirectory = null)
    {
        var baseDirectory = applicationDataDirectory ??
                            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(baseDirectory))
        {
            throw new InvalidOperationException("The Windows local application-data directory is unavailable.");
        }

        _settingsDirectory = Path.Combine(baseDirectory, "YtdlFlow");
        _settingsFilePath = Path.Combine(_settingsDirectory, "settings.json");
    }

    public string ApplicationDataDirectory => _settingsDirectory;

    public string GetDefaultDownloadDirectory()
    {
        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Downloads",
            "YTDL Flow");
        Directory.CreateDirectory(folder);
        return folder;
    }

    public string LoadDownloadDirectory()
    {
        if (!File.Exists(_settingsFilePath))
        {
            return GetDefaultDownloadDirectory();
        }

        try
        {
            var settings = JsonSerializer.Deserialize<SettingsState>(
                File.ReadAllText(_settingsFilePath));
            if (string.IsNullOrWhiteSpace(settings?.DownloadDirectory) ||
                !Path.IsPathRooted(settings.DownloadDirectory))
            {
                throw new InvalidDataException("The saved download directory is missing or is not an absolute path.");
            }

            Directory.CreateDirectory(settings.DownloadDirectory);
            return Path.GetFullPath(settings.DownloadDirectory);
        }
        catch (JsonException error)
        {
            throw new InvalidDataException(
                $"The desktop settings file '{_settingsFilePath}' contains invalid JSON.",
                error);
        }
    }

    public void SaveDownloadDirectory(string directory)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathRooted(directory))
        {
            throw new ArgumentException("The download directory must be an absolute path.", nameof(directory));
        }

        var fullPath = Path.GetFullPath(directory);
        Directory.CreateDirectory(fullPath);
        Directory.CreateDirectory(_settingsDirectory);
        var temporaryPath = $"{_settingsFilePath}.{Guid.NewGuid():N}.tmp";
        try
        {
            var payload = JsonSerializer.Serialize(
                new SettingsState { DownloadDirectory = fullPath },
                new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(temporaryPath, payload);
            File.Move(temporaryPath, _settingsFilePath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    public IReadOnlyDictionary<string, string> CreateBackendEnvironment(
        string repositoryRoot,
        string downloadDirectory)
    {
        var dataDirectory = Path.Combine(_settingsDirectory, "data");
        var logDirectory = Path.Combine(_settingsDirectory, "logs");
        Directory.CreateDirectory(dataDirectory);
        Directory.CreateDirectory(logDirectory);
        Directory.CreateDirectory(downloadDirectory);

        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["YTDL_DIST_DIR"] = Path.GetFullPath(Path.Combine(repositoryRoot, "dist")),
            ["YTDL_DATA_DIR"] = dataDirectory,
            ["YTDL_DOWNLOADS_DIR"] = Path.GetFullPath(downloadDirectory),
            ["YTDL_LOG_DIR"] = logDirectory,
            ["YTDL_ENGINE_ENTRY"] = Path.GetFullPath(Path.Combine(repositoryRoot, "python-engine", "ipc_main.py")),
            ["YTDL_ENGINE_CWD"] = Path.GetFullPath(Path.Combine(repositoryRoot, "python-engine")),
        };
    }

    private sealed class SettingsState
    {
        public string? DownloadDirectory { get; set; }
    }
}
