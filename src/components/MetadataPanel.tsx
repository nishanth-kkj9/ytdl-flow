import { useState, useMemo } from "react";
import { AlertTriangle, CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { useDownloadStore } from "../stores/downloadStore";
import type { MetadataResult } from "../types";

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  upload_date: "Date",
  genre: "Genre",
  language: "Language",
  video_id: "Video ID",
  webpage_url: "Source URL",
  description: "Description",
  channel: "Channel",
  duration: "Duration",
};

const FIELD_PRIORITY = [
  "title", "artist", "album", "upload_date", "genre",
  "language", "video_id", "webpage_url", "description",
  "channel", "duration",
];

type CheckState = "pass" | "fail" | "na";

interface CheckEntry {
  label: string;
  key: string;
  state: CheckState;
}

/**
 * Verification contract (python-engine verify_metadata):
 *   • key in `verify`  → PASS (true) or FAIL (false): the field was embedded
 *     and read back + compared against what we asked to embed.
 *   • key absent from `verify` → NOT verifiable for this container, or never
 *     requested (source had no value) → rendered as gray "N/A", never as a
 *     red failure. (WAV/RIFF cannot store video_id/description/cover art;
 *     MKV/WebM cannot store cover art via the ffmpeg muxer.)
 */
function buildChecklist(meta: MetadataResult): CheckEntry[] {
  const v = meta.verify;
  const state = (key: string): CheckState => {
    if (key in v) return v[key] ? "pass" : "fail";
    return "na";
  };
  return [
    { label: "Title", key: "title", state: state("title") },
    { label: "Artist", key: "artist", state: state("artist") },
    { label: "Album", key: "album", state: state("album") },
    { label: "Date", key: "upload_date", state: state("upload_date") },
    { label: "Genre", key: "genre", state: state("genre") },
    { label: "Language", key: "language", state: state("language") },
    { label: "Video ID", key: "video_id", state: state("video_id") },
    // P2-26: the "Comment" row was removed — the backend never embeds or
    // verifies a comment field, so this row could only ever render "N/A".
    { label: "Cover Art", key: "cover_art", state: state("cover_art") },
    { label: "Description", key: "description", state: state("description") },
  ];
}

export function MetadataPanel() {
  const metadataResult = useDownloadStore((s) => s.metadataResult);
  const [descExpanded, setDescExpanded] = useState(false);

  const orderedFields = useMemo(() => {
    if (!metadataResult) return [];
    const entries: { label: string; value: string }[] = [];
    for (const key of FIELD_PRIORITY) {
      const val = metadataResult.fields[key];
      if (val) {
        entries.push({ label: FIELD_LABELS[key] || key, value: val });
      }
    }
    return entries;
  }, [metadataResult]);

  const checklist = useMemo(
    () => (metadataResult ? buildChecklist(metadataResult) : []),
    [metadataResult],
  );

  const verifiedCount = useMemo(
    () => checklist.filter((c) => c.state === "pass").length,
    [checklist],
  );

  const totalCount = checklist.length;
  // "All verified" means zero genuine FAILs — N/A fields (unsupported by the
  // container or never requested) don't count against the pass.
  const failedFields = useMemo(
    () => checklist.filter((c) => c.state === "fail"),
    [checklist],
  );
  const allVerified = failedFields.length === 0;

  if (!metadataResult) return null;

  return (
    <section
      className="card overflow-hidden animate-fade-in-up"
    >
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-success text-base">●</span>
            <h2 className="eyebrow">Metadata Embedded</h2>
          </div>
          <span className="text-xs tabular-nums text-text-muted">
            {verifiedCount} / {totalCount} fields
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
          {metadataResult.container && (
            <span>Container: <span className="font-medium text-text-secondary">{metadataResult.container}</span></span>
          )}
          {metadataResult.engine && (
            <span>Engine: <span className="font-medium text-text-secondary">{metadataResult.engine}</span></span>
          )}
          <span>
            Cover:{" "}
            <span className={`font-medium ${metadataResult.cover_art ? "text-success" : "text-error"}`}>
              {metadataResult.cover_art ? "Yes" : "No"}
            </span>
          </span>
        </div>
      </div>

      {orderedFields.length > 0 && (
        <div className="divide-y divide-border px-5 py-2">
          {orderedFields.map(({ label, value }) => {
            const isDesc = label === "Description";
            const showToggle = isDesc && value.length > 120;
            const displayVal = showToggle && !descExpanded
              ? value.slice(0, 120) + "…"
              : value;
            return (
              <div
                key={label}
                className="flex items-start gap-4 py-2 text-xs"
              >
                <span className="w-24 shrink-0 font-medium text-text-muted">
                  {label}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-text break-words">
                    {displayVal}
                  </span>
                  {showToggle && (
                    <button
                      type="button"
                      onClick={() => setDescExpanded(!descExpanded)}
                      className="ml-1 shrink-0 font-medium text-accent-audio hover:text-accent-audio transition-colors"
                    >
                      {descExpanded ? "Show Less" : "Show More"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="border-t border-border px-5 py-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-text">
            {allVerified ? (
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-accent-audio" aria-hidden="true" />
            )}
            Verification
          </span>
          <span className={`text-xs tabular-nums font-medium ${
            allVerified ? "text-success" : "text-accent-audio"
          }`}>
            {allVerified ? "Passed" : `${verifiedCount} / ${totalCount} Verified`}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
          {checklist.map((item) => {
            // ADR-010: lucide icons, matching the toasts/header — the text
            // glyphs used before were inconsistent with the rest of the app
            // and, being aria-hidden, silently hid the pass state from
            // screen readers.
            const Icon =
              item.state === "pass" ? CheckCircle2 :
              item.state === "fail" ? XCircle : MinusCircle;
            const iconClass =
              item.state === "pass" ? "text-success" :
              item.state === "fail" ? "text-error" : "text-text-muted/60";
            const labelClass =
              item.state === "fail" ? "text-text-secondary" :
              item.state === "pass" ? "text-text-secondary" : "text-text-muted/70";
            return (
              <div
                key={item.key}
                className="flex items-center gap-1.5 text-xs"
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} aria-hidden="true" />
                <span className={labelClass}>
                  {item.label}
                  {item.state === "pass" && <span className="sr-only"> verified</span>}
                  {item.state === "fail" && (
                    <span className="ml-1 text-error">(Failed)</span>
                  )}
                  {item.state === "na" && (
                    <span className="ml-1 text-text-muted/60">(N/A)</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {!allVerified && failedFields.length > 0 && (
          <div className="mt-3 rounded-md bg-error/10 px-3 py-2">
            <p className="text-xs font-medium text-error">Failed verification:</p>
            <ul className="mt-1 list-inside list-disc text-xs text-error/70">
              {failedFields.map((m) => (
                <li key={m.key}>{m.label}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
