using System.Diagnostics;

namespace YtdlFlow.Desktop.Services;

public sealed class DownloadFileService
{
    private readonly string _downloadDirectory;
    private readonly Action<ProcessStartInfo> _startProcess;

    public DownloadFileService(
        string downloadDirectory,
        Action<ProcessStartInfo>? startProcess = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(downloadDirectory);
        _downloadDirectory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(downloadDirectory));
        Directory.CreateDirectory(_downloadDirectory);
        _startProcess = startProcess ?? StartProcess;
    }

    public string ResolveExistingFile(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        var target = Path.GetFullPath(path, _downloadDirectory);
        var relative = Path.GetRelativePath(_downloadDirectory, target);
        if (relative == "." ||
            Path.IsPathRooted(relative) ||
            relative == ".." ||
            relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("The selected file is outside the configured download folder.");
        }

        var segments = relative.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries);
        var current = _downloadDirectory;
        for (var index = 0; index < segments.Length; index++)
        {
            current = Path.Combine(current, segments[index]);
            FileSystemInfo entry = index == segments.Length - 1
                ? new FileInfo(current)
                : new DirectoryInfo(current);
            if (!entry.Exists)
            {
                throw new FileNotFoundException("The selected download file no longer exists.", current);
            }

            if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new UnauthorizedAccessException("Downloads through symbolic links are not allowed.");
            }
        }

        if (!File.Exists(target))
        {
            throw new FileNotFoundException("The selected download file no longer exists.", target);
        }

        return target;
    }

    public void OpenFile(string path)
    {
        var target = ResolveExistingFile(path);
        _startProcess(new ProcessStartInfo
        {
            FileName = target,
            UseShellExecute = true,
        });
    }

    public void RevealInExplorer(string path)
    {
        var target = ResolveExistingFile(path);
        var startInfo = new ProcessStartInfo
        {
            FileName = "explorer.exe",
            UseShellExecute = true,
        };
        startInfo.ArgumentList.Add($"/select,{target}");
        _startProcess(startInfo);
    }

    private static void StartProcess(ProcessStartInfo startInfo)
    {
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Windows could not start the file action.");
    }
}
