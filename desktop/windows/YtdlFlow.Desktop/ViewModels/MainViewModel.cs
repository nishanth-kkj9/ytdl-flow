using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Xaml;
using Windows.Storage.Pickers;
using WinRT.Interop;
using YtdlFlow.Desktop.Models;
using YtdlFlow.Desktop.Services;

namespace YtdlFlow.Desktop.ViewModels;

public partial class MainViewModel : ObservableObject
{
    private readonly BackendSupervisor _backendSupervisor = new();
    private readonly BackendService _backendService = new();

    [ObservableProperty]
    private string url = string.Empty;

    [ObservableProperty]
    private string statusMessage = "Greeting the local backend...";

    [ObservableProperty]
    private string connectionStatus = "Checking backend health...";

    [ObservableProperty]
    private string downloadDirectory = SettingsService.LoadDownloadDirectory();

    public ObservableCollection<DownloadItem> Jobs { get; } = new();

    public async Task InitializeAsync()
    {
        try
        {
            await _backendSupervisor.StartAsync();
            if (!string.IsNullOrWhiteSpace(_backendSupervisor.BackendAddress))
            {
                _backendService.SetBaseAddress(_backendSupervisor.BackendAddress);
            }
        }
        catch (Exception ex)
        {
            StatusMessage = $"Backend startup waiting: {ex.Message}";
            ConnectionStatus = "Starting shared backend...";
        }

        await RefreshBackendStatusAsync();
        await RefreshQueueAsync();
    }

    public async Task ProbeAsync()
    {
        if (string.IsNullOrWhiteSpace(Url))
        {
            StatusMessage = "Paste a YouTube URL before probing.";
            return;
        }

        StatusMessage = "Probing URL...";
        try
        {
            var title = await _backendService.ProbeAsync(Url);
            StatusMessage = $"Probe complete: {title}";
            var item = new DownloadItem { Title = title, Status = "ready" };
            if (Jobs.Count == 0)
            {
                Jobs.Add(item);
            }
            else
            {
                Jobs[0] = item;
            }
        }
        catch (Exception ex)
        {
            StatusMessage = $"Probe failed: {ex.Message}";
        }
    }

    public async Task PickDownloadFolderAsync(Window owner)
    {
        var picker = new FolderPicker();
        picker.FileTypeFilter.Add("*");
        InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(owner));

        var result = await picker.PickSingleFolderAsync();
        if (result is null)
        {
            return;
        }

        var selected = result.Path;
        SettingsService.SaveDownloadDirectory(selected);
        DownloadDirectory = selected;
        StatusMessage = $"Download folder ready: {selected}";
    }

    private async Task RefreshBackendStatusAsync()
    {
        var health = await _backendService.GetHealthAsync();
        if (health is null)
        {
            ConnectionStatus = "Backend status is unavailable.";
            StatusMessage = "The local backend is not responding yet.";
            return;
        }

        ConnectionStatus = health.Ok ? (health.EngineReady ? "Backend ready" : "Server live, engine starting") : $"Backend unavailable: {health.Message}";
        StatusMessage = health.Ok ? "Ready to download." : "The desktop app is waiting for the shared backend.";
    }

    private async Task RefreshQueueAsync()
    {
        try
        {
            Jobs.Clear();
            Jobs.Add(new DownloadItem { Title = "No active jobs", Status = "idle" });
            _ = await _backendService.GetHealthAsync();
        }
        catch
        {
            // Keep the UI lightweight and resilient while the backend boots.
        }
    }
}
