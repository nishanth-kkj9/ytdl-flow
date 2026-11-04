#!/usr/bin/env python3
"""IPC wrapper for the ytdl engine.

Reads newline-delimited JSON from stdin and writes newline-delimited JSON to stdout.
Supported commands:
  - probe
  - download
  - cancel

Each download runs in its own thread, and all stdout writes are flushed immediately.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any


_YDL_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# Ensure only JSON goes to stdout — redirect all other output to stderr.
# This MUST happen before the engine import below: an import-time stdout
# write (library banner, warning) would otherwise corrupt the NDJSON
# protocol before the guard exists.
_ORIGINAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

from engine import AudioDownloadEngine, DownloadResult, classify_error_type, _MUTAGEN_OK, _YDL_OK  # noqa: E402


# ── Bot-check circuit breaker ────────────────────────────────────────────────
# When YouTube flags this IP, every further probe/download fails fast AND
# hardens the block. This breaker trips after consecutive BotDetectionErrors
# and short-circuits new work with the actionable hint for a cooldown window
# instead of spending yt-dlp extractions that only make it worse. Resets on
# any success. Thread-safe: 2 probe + 5 download threads share it.
_BOT_BREAKER_LOCK = threading.Lock()
_BOT_BREAKER_FAILURES = 0
_BOT_BREAKER_OPEN_UNTIL = 0.0
_BOT_BREAKER_THRESHOLD = 3
_BOT_BREAKER_COOLDOWN_S = 300.0  # 5 minutes
_BOT_BREAKER_LAST_ERROR = ""


def _bot_breaker_check() -> str | None:
    """Return the cooldown error message if the breaker is open, else None."""
    import time as _time

    with _BOT_BREAKER_LOCK:
        if _BOT_BREAKER_OPEN_UNTIL and _time.monotonic() < _BOT_BREAKER_OPEN_UNTIL:
            remaining = int(_BOT_BREAKER_OPEN_UNTIL - _time.monotonic())
            return (
                f"YouTube bot-check is active on this IP (cooling down, "
                f"~{remaining}s left). {_bot_hint_text()}"
            )
        return None


def _bot_hint_text() -> str:
    try:
        from engine import bot_fix_hint as _hint

        return _hint()
    except Exception:
        return "Set YTDL_COOKIES_FILE and retry after a few minutes."


def _bot_breaker_success() -> None:
    global _BOT_BREAKER_FAILURES, _BOT_BREAKER_OPEN_UNTIL, _BOT_BREAKER_LAST_ERROR
    with _BOT_BREAKER_LOCK:
        _BOT_BREAKER_FAILURES = 0
        _BOT_BREAKER_OPEN_UNTIL = 0.0
        _BOT_BREAKER_LAST_ERROR = ""


def _bot_breaker_failure(error: str) -> None:
    global _BOT_BREAKER_FAILURES, _BOT_BREAKER_OPEN_UNTIL, _BOT_BREAKER_LAST_ERROR
    import time as _time

    with _BOT_BREAKER_LOCK:
        _BOT_BREAKER_FAILURES += 1
        _BOT_BREAKER_LAST_ERROR = error[:300]
        if _BOT_BREAKER_FAILURES >= _BOT_BREAKER_THRESHOLD:
            _BOT_BREAKER_OPEN_UNTIL = _time.monotonic() + _BOT_BREAKER_COOLDOWN_S


def _bot_breaker_status() -> dict[str, Any]:
    import time as _time

    with _BOT_BREAKER_LOCK:
        open_ = bool(
            _BOT_BREAKER_OPEN_UNTIL and _time.monotonic() < _BOT_BREAKER_OPEN_UNTIL
        )
        return {
            "open": open_,
            "consecutive_failures": _BOT_BREAKER_FAILURES,
            "cooldown_seconds": max(
                0, int(_BOT_BREAKER_OPEN_UNTIL - _time.monotonic())
            )
            if open_
            else 0,
        }


def _emit_ready() -> None:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    deno = shutil.which("deno")
    try:
        from engine import AudioDownloadEngine as _Eng

        cookies = _Eng.cookie_status()
    except Exception:
        cookies = {"configured": False, "source": "none"}
    _write_message({
        "type": "engine_ready",
        # IPC protocol version — bumped on any incompatible NDJSON change so a
        # stale engine paired with a newer server is detectable, never silent.
        "protocol_version": 1,
        "ffmpeg": bool(ffmpeg),
        "ffprobe": bool(ffprobe),
        "deno": bool(deno),
        "yt_dlp": _YDL_OK,
        "mutagen": _MUTAGEN_OK,
        # Cookie-auth observability (source only, never contents): the UI can
        # warn "no YouTube auth configured" before the first bot-check lands.
        "cookies": cookies,
    })

_DOWNLOAD_JOBS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()
# Bound concurrent downloads — yt-dlp + ffmpeg are CPU/I/O heavy, and more
# than a handful at once degrades the whole system.
_EXECUTOR = ThreadPoolExecutor(max_workers=5)
# Bound concurrent probes — each probe does network I/O (yt-dlp extraction
# with retries), so unbounded threads would exhaust system resources.
_PROBE_EXECUTOR = ThreadPoolExecutor(max_workers=2)


def _write_message(message: dict[str, Any]) -> None:
    try:
        _ORIGINAL_STDOUT.write(json.dumps(message, default=str) + "\n")
        _ORIGINAL_STDOUT.flush()
    except Exception:
        # If stdout is broken, abort.
        raise


def _write_error(id_: str | None, error_type: str, error: str) -> None:
    _write_message({
        "type": "error",
        "id": id_ or "",
        "error_type": error_type,
        "error": error,
    })


def _write_progress(id_: str, status: str, downloaded: int, total: int, speed: float, filename: str) -> None:
    _write_message({
        "type": "progress",
        "id": id_,
        "status": status,
        "downloaded": downloaded,
        "total": total,
        "speed": speed,
        "filename": filename,
    })


def _write_result(id_: str, result: DownloadResult) -> None:
    payload = {
        "type": "result",
        "id": id_,
        "success": result.success,
        "url": result.url,
        "title": result.title,
        "uploader": result.uploader,
        "filepath": result.filepath,
        "filename": result.filename,
        "fmt": result.fmt,
        "file_size": result.file_size,
        "duration": result.duration,
        "video_id": result.video_id,
        "avg_speed": result.avg_speed,
        "peak_speed": result.peak_speed,
        "elapsed": result.elapsed,
        "bitrate": result.bitrate,
        "thumbnail_ok": result.thumbnail_ok,
        "format_ok": result.format_ok,
        "error": result.error,
        "error_type": result.error_type,
        "metadata_fields": result.metadata_fields,
        "metadata_verify": result.metadata_verify,
        "metadata_engine": result.metadata_engine,
        "metadata_container": result.metadata_container,
        "metadata_cover_art": result.metadata_cover_art,
        # Round-4 audit fix (N-01): the dataclass carried `warnings` but the
        # payload omitted it — the browser's "Completed — …" note and the
        # honesty warnings were dead code end-to-end.
        "warnings": result.warnings,
    }
    _write_message(payload)


def _probe(url: str, id_: str) -> None:
    # Circuit breaker: skip the yt-dlp extraction entirely while cooling
    # down — each attempt would fail AND harden YouTube's IP block.
    blocked = _bot_breaker_check()
    if blocked is not None:
        _write_error(id_, "BotDetectionError", blocked)
        return
    try:
        engine = AudioDownloadEngine()
        info, error = engine.probe(url)
        if info is not None:
            _bot_breaker_success()
            _write_message({
                "type": "probe_result",
                "id": id_,
                "success": True,
                "info": info,
            })
        else:
            if not _YDL_OK:
                error = (
                    "yt-dlp is not installed in the Python interpreter running the engine "
                    f"({sys.executable}). Install: pip install -r python-engine/requirements.lock"
                )
            elif not error:
                error = "Probe returned no info; verify network, yt-dlp, and URL compatibility."
            error_type = classify_error_type(error)
            if error_type == "BotDetectionError":
                _bot_breaker_failure(error)
            # NOTE: engine.probe() already appends bot_fix_hint() for
            # BotDetectionError — do not append again here (no double hint).
            _write_error(id_, error_type, error)
    except Exception as exc:
        _write_error(id_, "ProbeError", f"{type(exc).__name__}: {exc}")


def _run_download(id_: str, url: str, audio_format: str, quality: str, output_dir: str, mode: str, cancel_event: threading.Event, trim_start: float | None = None, trim_end: float | None = None) -> None:
    # Flip the job's status to "running" once the executor picks it up, so the
    # `jobs` snapshot distinguishes queued-but-not-started from active work.
    with _LOCK:
        job = _DOWNLOAD_JOBS.get(id_)
        if job is not None:
            job["status"] = "running"

    def progress_cb(status: str, downloaded: int, total: int, speed: float, filename: str) -> None:
        _write_progress(id_, status, downloaded, total, speed, filename)

    # Surface automatic retries as events so the UI can say "retrying…" instead
    # of looking frozen during yt-dlp's exponential back-off wait.
    def retry_cb(attempt: int, delay: float, error: str) -> None:
        _write_message({
            "type": "download_retry",
            "id": id_,
            "attempt": attempt,
            "delay_seconds": delay,
            "error": error,
        })

    try:
        engine = AudioDownloadEngine(
            output_dir=output_dir,
            audio_format=audio_format,
            quality=quality,
            mode=mode,
            progress_cb=progress_cb,
            cancel_event=cancel_event,
            embed_metadata=True,
            cover_art=True,
            trim_start=trim_start,
            trim_end=trim_end,
        )
        result = engine.download(url, retry_cb=retry_cb)

        if result.success:
            _bot_breaker_success()
            _write_result(id_, result)
        else:
            if (result.error_type or "") == "BotDetectionError":
                _bot_breaker_failure(result.error or "")
            _write_error(id_, result.error_type or "DownloadError", result.error or "Download failed")
    except Exception as exc:
        _write_error(id_, "DownloadError", str(exc) or "Download exception")
    finally:
        with _LOCK:
            _DOWNLOAD_JOBS.pop(id_, None)


def _resolve_output_dir(output_dir: str) -> str | None:
    """Resolve output_dir and enforce it stays within the project downloads folder.

    Returns a canonical absolute path on success, or None to signal rejection.
    This is a defense-in-depth guard: the Node layer already locks `output_dir`
    to `config.downloadsDir`, but the engine must not blindly trust its input
    if that boundary is ever bypassed. `realpath` also resolves symlinks, so a
    symlink inside downloads that points elsewhere is rejected.
    """
    if not output_dir:
        output_dir = os.path.join(_YDL_PROJECT_ROOT, "..", "downloads")

    expected_base = os.path.realpath(os.path.join(_YDL_PROJECT_ROOT, "..", "downloads"))

    resolved = os.path.realpath(output_dir)
    resolved_norm = os.path.normcase(resolved)
    base_norm = os.path.normcase(expected_base)

    if resolved_norm != base_norm and not resolved_norm.startswith(base_norm + os.sep):
        return None
    return resolved


def _opt_float(command: dict[str, Any], key: str) -> float | None:
    """Read an optional float field; invalid/missing → None (F-10)."""
    raw = command.get(key)
    if raw is None or raw == "":
        return None
    try:
        val = float(raw)
        return val if 0 <= val < 86400 * 7 else None
    except (TypeError, ValueError):
        return None


def _start_download(command: dict[str, Any]) -> None:
    id_ = str(command.get("id", "")).strip()
    url = str(command.get("url", "")).strip()
    audio_format = str(command.get("format", "opus")).strip() or "opus"
    quality = str(command.get("quality", "high")).strip() or "high"
    output_dir = str(command.get("output_dir", "")).strip()
    mode = str(command.get("mode", "audio")).strip() or "audio"
    # F-10: optional trim window — CLI-side mirror of the Node parseTimestamp
    # gate; identically bounded (0 .. 7 days).
    trim_start = _opt_float(command, "trim_start")
    trim_end = _opt_float(command, "trim_end")
    if trim_start is not None and trim_end is not None and trim_end <= trim_start:
        with _LOCK:
            _DOWNLOAD_JOBS.pop(id_, None)
        _write_error(id_, "InvalidCommand", "trim_end must be greater than trim_start")
        return

    if not id_ or not url:
        _write_error(id_, "InvalidCommand", "download command requires 'id' and 'url'")
        return

    # Circuit breaker: reject at the gate while cooling down so a queued burst
    # of 5 downloads doesn't each burn a yt-dlp extraction against a flagged
    # IP (the block deepens with every attempt). No job is registered, so the
    # UI row resolves immediately with the actionable cooldown message.
    blocked = _bot_breaker_check()
    if blocked is not None:
        _write_error(id_ or "", "BotDetectionError", blocked)
        return

    # Register the job synchronously under the lock, BEFORE submitting to the
    # executor. This closes the duplicate-ID race: two rapid same-ID commands
    # can no longer both pass the check before either is registered.
    # `status` backs the `jobs` query command (used by the Node layer to
    # reconcile browser state after a WebSocket reconnect).
    cancel_event = threading.Event()
    with _LOCK:
        if id_ in _DOWNLOAD_JOBS:
            _write_error(id_, "DuplicateId", f"Download id '{id_}' is already active")
            return
        _DOWNLOAD_JOBS[id_] = {
            "cancel_event": cancel_event,
            "status": "queued",
            # Enriched for browser queue-restore (F-02): a page refresh empties
            # the client queue while the engine keeps working; the /api/status
            # jobs snapshot is the only place the surviving state exists.
            "url": url,
            "fmt": audio_format,
            "quality": quality,
            "mode": mode,
        }

    resolved_output = _resolve_output_dir(output_dir)
    if resolved_output is None:
        with _LOCK:
            _DOWNLOAD_JOBS.pop(id_, None)
        _write_error(
            id_,
            "InvalidPath",
            f"output_dir '{output_dir}' is outside the allowed downloads directory",
        )
        return
    output_dir = resolved_output

    os.makedirs(output_dir, exist_ok=True)
    # Write the ack BEFORE submitting: a fast executor worker could otherwise
    # emit `progress` ahead of `download_started` on the wire, and the Node
    # layer/browser would see progress for an unknown id.
    _write_message({
        "type": "download_started",
        "id": id_,
        "url": url,
        "fmt": audio_format,
        "quality": quality,
    })
    _EXECUTOR.submit(_run_download, id_, url, audio_format, quality, output_dir, mode, cancel_event, trim_start, trim_end)


def _cancel(command: dict[str, Any]) -> None:
    id_ = str(command.get("id", "")).strip()
    if not id_:
        _write_error(id_, "InvalidCommand", "cancel command requires 'id'")
        return

    with _LOCK:
        job = _DOWNLOAD_JOBS.get(id_)
        if not job:
            _write_error(id_, "NotFound", f"No active download with id '{id_}'")
            return
        cancel_event: threading.Event = job["cancel_event"]
        cancel_event.set()

    _write_message({
        "type": "cancelled",
        "id": id_,
    })


def _handle_command(command: dict[str, Any]) -> None:
    cmd = str(command.get("cmd", "")).strip().lower()
    if cmd == "download":
        _start_download(command)
    elif cmd == "probe":
        id_ = str(command.get("id", "")).strip() or ""
        url = str(command.get("url", "")).strip()
        if not id_ or not url:
            _write_error(id_, "InvalidCommand", "probe command requires 'id' and 'url'")
            return
        _PROBE_EXECUTOR.submit(_probe, url, id_)
    elif cmd == "cancel":
        _cancel(command)
    elif cmd == "jobs":
        # Snapshot of active download jobs — used by the Node layer on browser
        # reconnect to reconcile queue items that may have missed terminal
        # events while the WebSocket was down.
        request_id = str(command.get("request_id", "")).strip()
        with _LOCK:
            jobs = [
                {
                    "id": jid,
                    "status": job.get("status", "queued"),
                    # F-02: surface what the UI needs to rebuild a row after a
                    # page refresh (titles arrive only after extraction).
                    "url": job.get("url", ""),
                    "fmt": job.get("fmt", ""),
                    "quality": job.get("quality", ""),
                    "mode": job.get("mode", ""),
                }
                for jid, job in _DOWNLOAD_JOBS.items()
            ]
        _write_message({
            "type": "jobs_result",
            "request_id": request_id,
            "jobs": jobs,
            # P2-13: backpressure signal — how many accepted downloads are
            # still waiting for a worker slot. The Node layer can surface the
            # real queue depth instead of assuming every job starts at once.
            "queued": sum(1 for j in jobs if j["status"] == "queued"),
            # Bot-check observability: lets /api/status surface the cooldown
            # and cookie-auth state without a dedicated round-trip.
            "bot_breaker": _bot_breaker_status(),
        })
    else:
        _write_error(str(command.get("id", "")), "UnknownCommand", f"Unsupported cmd: {cmd}")


def _dispatch_safely(command: dict[str, Any]) -> None:
    # P0-2: a bare exception here (e.g. os.makedirs hitting EACCES or a
    # disk-full error inside _start_download) used to propagate to the
    # top-level handler and EXIT the engine — killing all in-flight
    # downloads and the IPC channel for every queued job. Contain it: emit a
    # terminal InternalError for this command and keep reading the channel.
    # (Extracted from main() so the guard is unit-testable.)
    try:
        _handle_command(command)
    except Exception as exc:
        _write_error(
            str(command.get("id", "")),
            "InternalError",
            f"Command dispatch failed: {type(exc).__name__}: {exc}",
        )


def main() -> None:
    _emit_ready()
    while True:
        # Read raw bytes and decode leniently: one corrupted byte in the
        # parent's write must not raise UnicodeDecodeError and kill the whole
        # engine (it would take every in-flight download with it).
        raw = sys.stdin.buffer.readline()
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue

        try:
            command = json.loads(line)
        except json.JSONDecodeError as exc:
            _write_error(None, "JSONDecodeError", f"Invalid JSON: {exc}")
            continue

        if not isinstance(command, dict):
            _write_error(None, "InvalidCommand", "Top-level JSON value must be an object")
            continue

        # P0-2: dispatch through the guard so no command can kill the loop.
        _dispatch_safely(command)

    # stdin closed — stop accepting work. wait=False so the process can exit
    # even with in-flight downloads (workers are non-daemon by default).
    _EXECUTOR.shutdown(wait=False)
    _PROBE_EXECUTOR.shutdown(wait=False)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception:
        _write_error(None, "FatalError", traceback.format_exc())
