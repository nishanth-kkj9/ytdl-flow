"""
ytdl_modern.logger
─────────────────────
Thread-safe file logger that writes timestamped entries to:
  <project_root>/logs/ytdl_pro_YYYYMMDD.log

All download details, errors, metadata events, and system info are
captured here so users have a permanent audit trail.
"""
from __future__ import annotations

import os
import shutil
import threading
from datetime import datetime
from typing import Optional

_MAX_LOG_BYTES = 5 * 1024 * 1024  # 5 MB
_MAX_LOG_BACKUPS = 3

_lock = threading.Lock()
_log_path: Optional[str] = None
_log_date: Optional[str] = None


def _rotate(path: str) -> None:
    """Rotate log file if it exceeds _MAX_LOG_BYTES."""
    try:
        if os.path.getsize(path) <= _MAX_LOG_BYTES:
            return
    except OSError:
        return
    # Remove oldest backup, shift the rest
    oldest = f"{path}.{_MAX_LOG_BACKUPS}"
    if os.path.exists(oldest):
        try:
            os.remove(oldest)
        except OSError:
            pass
    for i in range(_MAX_LOG_BACKUPS - 1, 0, -1):
        src = f"{path}.{i}"
        dst = f"{path}.{i + 1}"
        if os.path.exists(src):
            try:
                shutil.move(src, dst)
            except OSError:
                pass
    try:
        shutil.move(path, f"{path}.1")
    except OSError:
        pass


def _get_log_path() -> str:
    global _log_path, _log_date
    date_tag = datetime.now().strftime("%Y%m%d")
    if _log_path is None or _log_date != date_tag:
        # Re-evaluate the configured log folder on date change (REL-02).
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        logs_dir = os.environ.get("YTDL_LOG_DIR") or os.path.join(project_root, "logs")
        logs_dir = os.path.abspath(logs_dir)
        os.makedirs(logs_dir, exist_ok=True)
        _log_date = date_tag
        _log_path = os.path.join(logs_dir, f"ytdl_pro_{date_tag}.log")
    return _log_path


def _write(level: str, message: str) -> None:
    # P2-16: titles/URLs are attacker-controlled strings; a raw newline would
    # forge extra log entries and unbounded titles bloat the file. Collapse
    # line breaks and cap the length (call sites already emit one line each).
    message = " ".join(str(message).splitlines()).strip()[:500]
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level:<7}] {message}\n"
    try:
        with _lock:
            path = _get_log_path()
            _rotate(path)
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass  # Never crash the app over a logging failure


def info(msg: str) -> None:
    _write("INFO", msg)


def warn(msg: str) -> None:
    _write("WARNING", msg)


def error(msg: str) -> None:
    _write("ERROR", msg)


def debug(msg: str) -> None:
    _write("DEBUG", msg)


def separator() -> None:
    _write("-----", "-" * 60)


def log_download_start(url: str, fmt: str, quality: str) -> None:
    separator()
    info(f"DOWNLOAD START")
    info(f"  URL     : {url}")
    info(f"  Format  : {fmt.upper()}")
    info(f"  Quality : {quality}")


def log_download_success(title: str, filepath: str, file_size: int,
                         duration: float, avg_speed: float, elapsed: float) -> None:
    info(f"DOWNLOAD SUCCESS")
    info(f"  Title    : {title}")
    info(f"  File     : {filepath}")
    info(f"  Size     : {file_size:,} bytes ({file_size / 1024 / 1024:.2f} MB)")
    info(f"  Duration : {int(duration)}s")
    info(f"  Avg Speed: {avg_speed / 1024:.1f} KB/s")
    info(f"  Elapsed  : {elapsed:.1f}s")
    separator()


def log_download_error(url: str, error_type: str, error_msg: str) -> None:
    error(f"DOWNLOAD FAILED")
    error(f"  URL        : {url}")
    error(f"  Error Type : {error_type}")
    error(f"  Error Msg  : {error_msg[:500]}")
    separator()


def log_probe(url: str, title: str, duration: float, uploader: str) -> None:
    info(f"PROBE SUCCESS")
    info(f"  URL      : {url}")
    info(f"  Title    : {title}")
    info(f"  Uploader : {uploader}")
    info(f"  Duration : {int(duration)}s")


def log_probe_error(url: str, error_type: str, msg: str) -> None:
    error(f"PROBE FAILED: [{error_type}] {msg[:300]}")
    error(f"  URL: {url}")


def log_metadata(filepath: str, fmt: str, cover_art: bool) -> None:
    info(f"METADATA EMBEDDED: {os.path.basename(filepath)} [{fmt.upper()}] "
         f"cover_art={'yes' if cover_art else 'no'}")


def log_format_verify(filepath: str, expected: str, actual: str, ok: bool) -> None:
    if ok:
        info(f"FORMAT VERIFIED: {os.path.basename(filepath)} → {actual.upper()} ✔")
    else:
        warn(f"FORMAT MISMATCH: expected={expected.upper()} actual={actual.upper()} "
             f"file={os.path.basename(filepath)}")
