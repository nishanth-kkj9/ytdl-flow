using System.Collections.ObjectModel;

namespace YtdlFlow.Desktop.Models;

public sealed class DownloadQueue : ObservableCollection<DownloadItem>
{
    public const int MaximumItems = 200;

    public bool TryAdd(DownloadItem item)
    {
        if (string.IsNullOrWhiteSpace(item.Id) ||
            this.Any(existing => string.Equals(existing.Id, item.Id, StringComparison.Ordinal)))
        {
            return false;
        }

        while (Count >= MaximumItems)
        {
            var removable = this.FirstOrDefault(candidate => !candidate.IsActive);
            if (removable is null)
            {
                return false;
            }

            Remove(removable);
        }

        Add(item);
        return true;
    }

    public DownloadItem? Find(string? id) =>
        string.IsNullOrWhiteSpace(id)
            ? null
            : this.FirstOrDefault(item => string.Equals(item.Id, id, StringComparison.Ordinal));

    public bool Reconcile(
        IEnumerable<BackendJob> activeJobs,
        bool engineReady,
        bool snapshotAvailable,
        bool markMissingUnknown = false)
    {
        if (!engineReady || !snapshotAvailable)
        {
            return false;
        }

        var activeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var job in activeJobs)
        {
            if (string.IsNullOrWhiteSpace(job.Id))
            {
                continue;
            }

            activeIds.Add(job.Id);
            var item = Find(job.Id);
            if (item is null)
            {
                item = new DownloadItem(
                    job.Id,
                    job.Url ?? string.Empty,
                    job.Mode ?? "audio",
                    job.Format ?? "mp3",
                    job.Quality ?? "high");
                if (!TryAdd(item))
                {
                    continue;
                }
            }

            item.ApplyBackendStatus(job.Status);
            item.ObserveCancellationStillActive();
        }

        foreach (var item in this.Where(item => item.IsActive && !activeIds.Contains(item.Id)))
        {
            if (item.Status == DownloadStatus.Cancelling)
            {
                item.CancellationResolutionUnknown(
                    "The backend no longer reports this download as active, but no cancellation event was received. Its outcome is unknown.");
            }
            else if (markMissingUnknown)
            {
                item.MarkUnknown();
            }
        }

        return true;
    }
}
