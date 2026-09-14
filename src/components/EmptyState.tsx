export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface/30 px-6 py-8 text-center">
      <div className="badge-play mb-4" aria-hidden="true">
        <img src="/branding/ytdl-flow-icon.svg" alt="" width={18} height={18} />
      </div>
      <h2 className="text-base font-semibold tracking-tight text-text">Paste a YouTube link to get started</h2>
      <p className="mt-1.5 max-w-md text-sm text-text-muted">
        Paste a link above, hit <kbd className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">Enter</kbd> or Probe to fetch metadata.
      </p>
      <div className="mt-4 flex items-center gap-2 text-xs text-text-muted">
        <span className="flex items-center gap-1.5"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-audio-dim text-[10px] font-bold text-accent-audio">A</span> Audio (MP3, Opus, M4A, WAV)</span>
        <span className="flex items-center gap-1.5"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-video-dim text-[10px] font-bold text-accent-video">V</span> Video (MP4, WebM, MKV)</span>
      </div>
    </div>
  );
}
