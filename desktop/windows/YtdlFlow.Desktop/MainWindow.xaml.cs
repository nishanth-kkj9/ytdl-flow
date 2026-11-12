using Microsoft.UI.Xaml;
using Microsoft.UI.Windowing;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Controls;
using YtdlFlow.Desktop.Models;
using YtdlFlow.Desktop.ViewModels;

namespace YtdlFlow.Desktop;

public sealed partial class MainWindow : Window
{
    private bool _allowClose;
    private bool _closeConfirmationOpen;

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
            AppWindow.Closing += OnAppWindowClosing;
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

    private async void SubmitDownloadButton_Click(object sender, RoutedEventArgs e)
    {
        await ViewModel.SubmitDownloadAsync();
    }

    private async void CancelDownloadButton_Click(object sender, RoutedEventArgs e)
    {
        if (GetDownloadItem(sender) is { } item)
        {
            await ViewModel.CancelDownloadAsync(item);
        }
    }

    private async void RetryDownloadButton_Click(object sender, RoutedEventArgs e)
    {
        if (GetDownloadItem(sender) is { } item)
        {
            await ViewModel.RetryDownloadAsync(item);
        }
    }

    private void OpenDownloadButton_Click(object sender, RoutedEventArgs e)
    {
        var path = GetFilePath(sender);
        ViewModel.OpenDownloadFile(path);
    }

    private void RevealDownloadButton_Click(object sender, RoutedEventArgs e)
    {
        var path = GetFilePath(sender);
        ViewModel.RevealDownloadFile(path);
    }

    private void NavigationView_SelectionChanged(
        NavigationView sender,
        NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItemContainer?.Tag is string page)
        {
            ViewModel.NavigateTo(page);
        }
    }

    private async void ClearHistoryButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new ContentDialog
        {
            Title = "Clear download history?",
            Content = "This removes saved history records only. Downloaded files will not be deleted.",
            PrimaryButtonText = "Clear history",
            CloseButtonText = "Keep history",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = Content.XamlRoot,
        };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
        {
            await ViewModel.ClearHistoryAsync();
        }
    }

    private async void OnAppWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_allowClose || !ViewModel.HasActiveJobs)
        {
            return;
        }

        if (_closeConfirmationOpen)
        {
            args.Cancel = true;
            return;
        }

        args.Cancel = true;
        _closeConfirmationOpen = true;
        var closeAfterConfirmation = false;
        try
        {
            var dialog = new ContentDialog
            {
                Title = "Downloads are still active",
                Content = "Closing the desktop app will stop the shared backend and its active downloads.",
                PrimaryButtonText = "Close anyway",
                CloseButtonText = "Keep running",
                DefaultButton = ContentDialogButton.Close,
                XamlRoot = Content.XamlRoot,
            };
            if (await dialog.ShowAsync() == ContentDialogResult.Primary)
            {
                closeAfterConfirmation = true;
            }
        }
        finally
        {
            _closeConfirmationOpen = false;
        }

        if (closeAfterConfirmation)
        {
            _allowClose = true;
            Close();
        }
    }

    private static DownloadItem? GetDownloadItem(object sender) =>
        (sender as FrameworkElement)?.DataContext as DownloadItem;

    private static string? GetFilePath(object sender) =>
        (sender as FrameworkElement)?.DataContext switch
        {
            DownloadItem item => item.FilePath,
            DownloadHistoryRecord record => record.FilePath,
            _ => null,
        };
}
