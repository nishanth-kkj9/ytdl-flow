using System.Text.Json;

namespace YtdlFlow.Desktop.Services;

public static class SettingsService
{
    private static readonly string SettingsDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "YtdlFlow");

    private static readonly string SettingsFilePath = Path.Combine(SettingsDirectory, "settings.json");

    public static string GetDefaultDownloadDirectory()
    {
        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Downloads",
            "YTDL Flow");

        Directory.CreateDirectory(folder);
        return folder;
    }

    public static string LoadDownloadDirectory()
    {
        try
        {
            if (!File.Exists(SettingsFilePath))
            {
                return GetDefaultDownloadDirectory();
            }

            var payload = File.ReadAllText(SettingsFilePath);
            var settings = JsonSerializer.Deserialize<SettingsState>(payload);
            if (!string.IsNullOrWhiteSpace(settings?.DownloadDirectory) && Path.IsPathRooted(settings.DownloadDirectory))
            {
                Directory.CreateDirectory(settings.DownloadDirectory);
                return settings.DownloadDirectory;
            }
        }
        catch
        {
            // Fall back to a known-safe default when the local settings file is missing or corrupted.
        }

        return GetDefaultDownloadDirectory();
    }

    public static void SaveDownloadDirectory(string directory)
    {
        Directory.CreateDirectory(SettingsDirectory);
        var payload = JsonSerializer.Serialize(new SettingsState { DownloadDirectory = directory }, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(SettingsFilePath, payload);
    }

    private sealed class SettingsState
    {
        public string? DownloadDirectory { get; set; }
    }
}
