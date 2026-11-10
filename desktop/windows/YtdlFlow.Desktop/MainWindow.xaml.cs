using Microsoft.UI.Xaml;
using Microsoft.UI.Windowing;
using Microsoft.UI.Dispatching;
using YtdlFlow.Desktop.ViewModels;

namespace YtdlFlow.Desktop;

public sealed partial class MainWindow : Window
{
    public MainViewModel ViewModel { get; }

    public MainWindow()
    {
        ViewModel = new MainViewModel(DispatcherQueue.GetForCurrentThread());
        InitializeComponent();
        Closed += OnClosed;

        if (AppWindow is not null)
        {
            AppWindow.Resize(new Windows.Graphics.SizeInt32(1100, 760));
            AppWindow.Move(new Windows.Graphics.PointInt32(200, 120));
        }

        StartInitialization();
    }

    private async void StartInitialization()
    {
        try
        {
            await ViewModel.InitializeAsync();
        }
        catch (Exception error)
        {
            ViewModel.StatusMessage = "The desktop backend could not be initialized.";
            ViewModel.ErrorMessage = error.Message;
        }
    }

    private async void OnClosed(object sender, WindowEventArgs e)
    {
        try
        {
            await ViewModel.ShutdownAsync();
        }
        catch (Exception error)
        {
            System.Diagnostics.Debug.WriteLine($"Desktop shutdown failed: {error}");
        }
    }

    private async void ProbeButton_Click(object sender, RoutedEventArgs e)
    {
        await ViewModel.ProbeAsync();
    }

    private async void ChooseFolderButton_Click(object sender, RoutedEventArgs e)
    {
        await ViewModel.PickDownloadFolderAsync(this);
    }
}
