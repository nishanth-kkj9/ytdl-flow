using Microsoft.UI.Xaml;
using Microsoft.UI.Windowing;
using YtdlFlow.Desktop.ViewModels;

namespace YtdlFlow.Desktop;

public sealed partial class MainWindow : Window
{
    public MainViewModel ViewModel { get; }

    public MainWindow()
    {
        ViewModel = new MainViewModel();
        InitializeComponent();

        if (AppWindow is not null)
        {
            AppWindow.Resize(new Windows.Graphics.SizeInt32(1100, 760));
            AppWindow.Move(new Windows.Graphics.PointInt32(200, 120));
        }

        _ = ViewModel.InitializeAsync();
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
