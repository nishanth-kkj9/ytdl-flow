"""
ytdl_modern.engine  (v4)
────────────────────────
Self-contained audio download engine.

Improvements over v3:
  • Multiple YouTube player clients (ios, android_music, android, web) for
    maximum bypass of bot-detection / age-gate restrictions.
  • Real format verification — mutagen reads back the file and confirms the
    codec matches what was requested.  Mismatch is logged + user is warned.
  • Maximum-quality thumbnail selection — sorted by resolution, prefers
    maxresdefault / hqdefault from YouTube thumbnail URL patterns.
  • Proper cover-art embedding for ALL three formats:
      opus  → base64-encoded FLAC Picture in metadata_block_picture tag
      mp3   → ID3 APIC frame (image/jpeg)
      aac   → mutagen MP4 covr atom (MP4Cover.FORMAT_JPEG)
  • Full file-logger integration (logger.py).
  • Exponential back-off retry (from audio_downloader).
  • Cooperative cancellation via threading.Event.
"""
from __future__ import annotations

import base64
import contextlib
import math
import os
import re
import shutil
import subprocess
import sys
import time
import threading
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse
from dataclasses import dataclass, field, asdict
from typing import Callable, Optional

try:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import Popen as _YtDlpPopen
    _YDL_OK = True
except ImportError:
    _YDL_OK = False
    _YtDlpPopen = None
    class YoutubeDL:  # type: ignore
        def __init__(self, *a, **kw): pass
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def extract_info(self, *a, **kw): return None

try:
    from mutagen.oggopus import OggOpus
    from mutagen.mp3 import EasyMP3
    from mutagen.mp4 import MP4, MP4Cover
    from mutagen.id3 import (
        ID3, APIC, TIT2, TPE1, TALB, TDRC, TCON, COMM, TXXX, TLAN, error as ID3Error
    )
    from mutagen.flac import Picture
    from mutagen import File as MutagenFile
    _MUTAGEN_OK = True
except ImportError:
    _MUTAGEN_OK = False

from helpers import format_size, format_duration, sanitize_filename
import logger as applog


class DownloadCancelledError(RuntimeError):
    def __init__(self, message: str, output_path: str | None = None):
        super().__init__(message)
        self.output_path = output_path


_FFMPEG_CANCELLATION = threading.local()


@contextlib.contextmanager
def _ffmpeg_cancellation_scope(cancel_event: threading.Event):
    previous_event = getattr(_FFMPEG_CANCELLATION, "event", None)
    _FFMPEG_CANCELLATION.event = cancel_event
    try:
        yield
    finally:
        if previous_event is None:
            del _FFMPEG_CANCELLATION.event
        else:
            _FFMPEG_CANCELLATION.event = previous_event


if _YtDlpPopen is not None:
    _ORIGINAL_YTDLP_POPEN_RUN = _YtDlpPopen.run.__func__

    def _run_cancellable_ytdlp_process(cls, *args, timeout=None, input=None, **kwargs):
        cancel_event = getattr(_FFMPEG_CANCELLATION, "event", None)
        if cancel_event is None:
            return _ORIGINAL_YTDLP_POPEN_RUN(cls, *args, timeout=timeout, input=input, **kwargs)

        if input is not None and kwargs.get("stdin") is None:
            kwargs["stdin"] = subprocess.PIPE
        command = args[0] if args else ""
        command_args = command if isinstance(command, (list, tuple)) else [command]
        is_ffmpeg = bool(command_args and "ffmpeg" in os.path.basename(str(command_args[0])).lower())
        output_path = str(command_args[-1]) if is_ffmpeg and command_args else None
        deadline = time.monotonic() + timeout if timeout is not None else None
        communication_input = input
        text_mode = bool(
            kwargs.get("text") or kwargs.get("universal_newlines")
            or kwargs.get("encoding") or kwargs.get("errors")
        )
        empty_output = "" if text_mode else b""

        with cls(*args, **kwargs) as proc:
            while True:
                try:
                    stdout, stderr = proc.communicate(
                        input=communication_input,
                        timeout=min(0.1, max(0, deadline - time.monotonic()))
                        if deadline is not None
                        else 0.1,
                    )
                    if cancel_event.is_set():
                        raise DownloadCancelledError(
                            "Download cancelled by user.",
                            output_path=output_path,
                        )
                    return stdout or empty_output, stderr or empty_output, proc.returncode
                except subprocess.TimeoutExpired as exc:
                    communication_input = None
                    if cancel_event.is_set():
                        proc.kill()
                        proc.communicate()
                        raise DownloadCancelledError(
                            "Download cancelled by user.",
                            output_path=output_path,
                        ) from exc
                    if deadline is not None and time.monotonic() >= deadline:
                        proc.kill()
                        proc.communicate()
                        raise exc

    _YtDlpPopen.run = classmethod(_run_cancellable_ytdlp_process)

# ── Audio format → codec string ───────────────────────────────────────────────
AUDIO_FORMATS: dict[str, str] = {
    "opus": "opus",
    "mp3":  "mp3",
    "aac":  "m4a",   # yt-dlp always muxes AAC into M4A container
    "m4a":  "m4a",
    "wav":  "wav",
}

# ── Quality presets (from audio_downloader reference) ─────────────────────────
# Audio-mode format selection is deliberately `bestaudio` — NOT
# `bestaudio/best`. The `/best` fallback lets yt-dlp resolve a muxed
# video+audio stream (e.g. YouTube format 18, ~8 MB for a 3:25 track) when it
# fails to resolve an audio-only format — and the engine's old vcodec retry
# then downloaded that same muxed stream a second time with identical options.
# `bestaudio` alone picks an audio-only format on every site that has one;
# if a site truly offers no audio-only track, failing the download is
# preferable to silently fetching and transcoding a full video stream.
QUALITY_PRESETS: dict[str, dict] = {
    "maximum": {"format": "bestaudio", "preferredquality": "0"},
    "high":    {"format": "bestaudio", "preferredquality": "192"},
    "medium":  {"format": "bestaudio", "preferredquality": "128"},
    "low":     {"format": "bestaudio", "preferredquality": "96"},
}

VIDEO_QUALITY_PRESETS: dict[str, dict] = {
    "maximum": {"format": "bestvideo+bestaudio/best[height<=1080]/best"},
    "best":    {"format": "bestvideo+bestaudio/best[height<=1080]/best"},
    "2160p":   {"format": "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best"},
    "1080p":   {"format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"},
    "720p":    {"format": "bestvideo[height<=720]+bestaudio/best[height<=720]/best"},
    "480p":    {"format": "bestvideo[height<=480]+bestaudio/best[height<=480]/best"},
    "360p":    {"format": "bestvideo[height<=360]+bestaudio/best[height<=360]/best"},
    "high":    {"format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"},
    "medium":  {"format": "bestvideo[height<=720]+bestaudio/best[height<=720]/best"},
    "low":     {"format": "bestvideo[height<=480]+bestaudio/best[height<=480]/best"},
}

# ── Expected mutagen file types per output format ─────────────────────────────
_MUTAGEN_TYPE_CHECK = {
    "opus": "OggOpus",
    "mp3":  "MP3",
    "aac":  "MP4",
    "m4a":  "MP4",
    "wav":  "WAVE",
    "mp4":  "MP4",
    "webm": "WebM",
    "mkv":  "Matroska",
}

# NOTE: YouTube URL-shape validation is intentionally enforced upstream in the
# Node layer (web/validate.mjs YOUTUBE_REGEX, checked on every /api/probe and
# /api/download request before any command reaches this process). No Python-side
# copy of the pattern is kept here so the two can't drift apart.

# ── Video quality height map ──────────────────────────────────────────────────
_HEIGHT_MAP = {
    "maximum": 1080, "best": 1080, "2160p": 2160, "1080p": 1080,
    "720p": 720, "480p": 480, "360p": 360, "high": 1080, "medium": 720, "low": 480,
}

_VALID_VIDEO_CONTAINERS = {"mp4", "webm", "mkv"}

_CONTAINER_NAMES = {
    ".opus": "Opus", ".mp3": "MP3", ".m4a": "AAC",
    ".mp4": "MP4", ".mkv": "MKV", ".webm": "WebM",
}


# ══════════════════════════════════════════════════════════════════════════════
#  Retry strategy  (adapted from audio_downloader.error_handler)
# ══════════════════════════════════════════════════════════════════════════════

def _merge_missing_info(target: dict, fallback: dict | None) -> dict:
    """
    Fill fields missing from `target` with values from `fallback`.

    yt-dlp's mobile player clients (ios / android_music) — used on the
    audio-mode retry when the default client resolves to a muxed video
    stream — return info dicts that omit fields the default web client
    provides (notably `uploader` and `webpage_url`). Without this merge,
    retried downloads silently lose the artist and comment ID3 tags and
    metadata verification reports fewer fields embedded.
    """
    if not fallback:
        return target
    for key, value in fallback.items():
        if value in (None, "", [], {}):
            continue
        if target.get(key) in (None, "", [], {}):
            target[key] = value
    return target


class RetryStrategy:
    def __init__(
        self,
        max_retries: int   = 3,
        initial_delay: float = 2.0,
        max_delay: float   = 30.0,
        backoff: float     = 2.0,
    ) -> None:
        self.max_retries   = max_retries
        self.initial_delay = initial_delay
        self.max_delay     = max_delay
        self.backoff       = backoff
        self._attempt      = 0
        self._delay        = initial_delay

    def should_retry(self, exc: Exception) -> bool:
        if self._attempt >= self.max_retries:
            return False
        msg = str(exc).lower()
        # Don't retry user cancellation or unrecoverable errors
        if any(x in msg for x in ("cancelled", "not a youtube url",
                                   "is not a valid url", "ffmpeg")):
            return False
        # Permanent request/configuration errors — identical outcome every
        # attempt, so retrying just wastes 2/4/8s and 4 identical failures.
        if any(x in msg for x in ("unsupported", "output file not found",
                                   "invalid timestamp")):
            return False
        return True

    def next_delay(self) -> float:
        delay = min(self.initial_delay * (self.backoff ** self._attempt),
                    self.max_delay)
        self._attempt += 1
        return delay

    def reset(self) -> None:
        self._attempt = 0
        self._delay   = self.initial_delay


# ══════════════════════════════════════════════════════════════════════════════
#  Download result
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class DownloadResult:
    success:          bool
    url:              str   = ""
    title:            str   = ""
    uploader:         str   = ""
    filepath:         str   = ""
    filename:         str   = ""
    fmt:              str   = ""
    file_size:        int   = 0
    duration:         float = 0.0
    video_id:         str   = ""
    avg_speed:        float = 0.0
    peak_speed:       float = 0.0
    elapsed:          float = 0.0
    bitrate:          int   = 0      # actual bitrate read back from file (kbps)
    thumbnail_ok:     bool  = False  # whether cover art was embedded
    format_ok:        bool  = False  # whether format was verified by mutagen
    error:            str   = ""
    error_type:       str   = ""
    metadata_fields:  dict[str, str] = field(default_factory=dict)
    metadata_verify:  dict[str, bool] = field(default_factory=dict)
    metadata_engine:  str   = ""
    metadata_container: str = ""
    metadata_cover_art: bool = False
    # F-07/11: honest human-readable notes appended to the result message
    # ("file already existed — not re-downloaded", "no FFmpeg — progressive").
    warnings:         str   = "" 


# ══════════════════════════════════════════════════════════════════════════════
#  Error helpers
# ══════════════════════════════════════════════════════════════════════════════

def is_bot_detection_error(msg: str) -> bool:
    # BOT-FIX: only the genuine YouTube auth/bot-check signals fail fast.
    # Generic phrases like "rate limit" / "rate limited" stay retryable —
    # transient 429s / "temporary ... rate limited" blips must keep the
    # normal exponential-backoff path (guarded by test_download_retry_*).
    # "sign in to confirm your AGE" is an age-gate, not an IP bot-check —
    # exclude it so age-gated videos keep normal retry behavior.
    m = msg.lower()
    if "sign in to confirm your age" in m or "confirm your age" in m:
        return False
    indicators = (
        "sign in to confirm", "not a bot", "captcha",
        "too many requests", "http error 429",
        "video unavailable", "age-restricted", "members-only",
        "private video",
    )
    return any(ind in m for ind in indicators)


def bot_fix_hint() -> str:
    """Actionable hint appended to BotDetectionError messages."""
    return (
        "YouTube is bot-checking this IP (common after rapid successive "
        "downloads). Fix: export YouTube cookies from a signed-in browser "
        "(Netscape cookies.txt) and set YTDL_COOKIES_FILE=<path> before "
        "starting the server — or set YTDL_COOKIES_BROWSER=chrome. "
        "Wait a few minutes and space out downloads."
    )


def classify_error_type(msg: str) -> str:
    if is_bot_detection_error(msg):
        return "BotDetectionError"
    net = ("connection", "timeout", "network", "ssl", "certificate",
           "unable to download", "urlopen error", "http error")
    if any(x in msg.lower() for x in net):
        return "NetworkError"
    if "ffmpeg" in msg.lower():
        return "FFmpegError"
    return "AudioDownloaderError"


# ══════════════════════════════════════════════════════════════════════════════
#  Speed tracker
# ══════════════════════════════════════════════════════════════════════════════

class _SpeedTracker:
    def __init__(self) -> None:
        self._start   = time.monotonic()
        self._speeds: list[float] = []

    def record(self, speed: float) -> None:
        if speed > 0:
            self._speeds.append(speed)

    @property
    def avg_speed(self) -> float:
        return sum(self._speeds) / len(self._speeds) if self._speeds else 0.0

    @property
    def peak_speed(self) -> float:
        return max(self._speeds, default=0.0)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self._start


# ══════════════════════════════════════════════════════════════════════════════
#  Metadata sanitization — shared across all writers
# ══════════════════════════════════════════════════════════════════════════════

# Control characters (C0 + C1 + DEL), zero-width, and bidi overrides.
_META_SANITIZE_RE = re.compile(
    r"[\x00-\x1f\x7f\x80-\x9f\u200b\u200e\u200f\u202a-\u202e\ufeff]+"
)

_MAX_META_VALUE = 5000  # characters — safety cap against huge payloads


def _sanitize_meta(value: str) -> str:
    """Strip control/zero-width characters and cap length.

    Preserves Unicode letters, punctuation, and whitespace. Does NOT
    normalize dates (the caller controls that).
    """
    if not value:
        return ""
    return _META_SANITIZE_RE.sub("", value)[:_MAX_META_VALUE].strip()


# ── Normalization for comparison (used by verification) ───────────────────────

def _norm_for_compare(value: str | None) -> str:
    """Normalize a metadata value for equality comparison.

    Rules:
      • Strip leading/trailing whitespace.
      • Collapse internal runs of whitespace to a single space.
      • Unicode NFKC normalization (compatibility forms — '½' → '1⁄2').
      • Case-fold for Latin text.
    Documented normalization decisions:
      • Date: '20260903' is normalized to '2026-09-03' by `Metadata.from_info`
        before reaching verification, so both sides already match here.
      • Duration: stored as human-readable 'Xh Ym Zs' — not compared.
    """
    if not value:
        return ""
    import unicodedata
    v = unicodedata.normalize("NFKC", value).strip()
    return " ".join(v.split()).casefold()


# ── Per-field verification result ────────────────────────────────────────────

class FieldResult:
    """Rich per-field verification outcome (internal use).

    Backward compatibility: `metadata_verify: dict[str, bool]` maps PASS→True,
    everything else→False. NOT_REQUESTED is intentionally absent from the
    dict so consumers don't count un-requested fields as verified or failed.
    """
    PASS           = "pass"
    FAIL           = "fail"
    NOT_SUPPORTED  = "not_supported"
    NOT_REQUESTED  = "not_requested"

    @staticmethod
    def to_bool(result: str) -> bool:
        return result == FieldResult.PASS


# ══════════════════════════════════════════════════════════════════════════════
#  Thumbnail helpers  — maximum quality selection
# ══════════════════════════════════════════════════════════════════════════════

_ALLOWED_THUMBNAIL_DOMAINS = (".ytimg.com", ".googleusercontent.com", ".googlevideo.com", ".youtube.com")


def _is_safe_thumbnail_url(url: str) -> bool:
    """Only fetch thumbnails from YouTube's known CDN domains (SSRF guard)."""
    if not isinstance(url, str) or len(url) > 2048:
        return False
    if not url.startswith(("http://", "https://")):
        return False  # e.g. ftp://i.ytimg.com/... must not pass
    try:
        hostname = urlparse(url).hostname or ""
        return hostname.endswith(_ALLOWED_THUMBNAIL_DOMAINS)
    except Exception:
        return False


class _SSRFSafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirect handler that re-validates every hop against the allowlist.

    urllib follows redirects to ARBITRARY hosts by default — an attacker
    controlling a redirect (or an open redirect on a "safe" domain) could
    bounce a thumbnail fetch to e.g. a cloud metadata endpoint. Every hop
    must independently pass the same allowlist as the initial URL.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _is_safe_thumbnail_url(newurl):
            applog.warn(f"Blocked thumbnail redirect to unsafe URL: {newurl}")
            raise urllib.error.HTTPError(
                req.full_url, code, f"blocked redirect to {newurl}", headers, fp
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_THUMB_OPENER = urllib.request.build_opener(_SSRFSafeRedirectHandler())
# Hard cap on how many bytes we'll pull into memory for cover art.
_MAX_THUMB_BYTES = 10 * 1024 * 1024  # 10 MB


def _best_thumbnail_url(info: dict) -> str:
    """
    Return the highest-resolution thumbnail URL available.

    Strategy (fast path first):
      1. Try YouTube's known HQ thumbnail URLs via HEAD request
         (timeout 3 s each, stops at first 200).
      2. Sorted thumbnails list by pixel area.
      3. Fallback to info["thumbnail"].

    PERF NOTE: The HEAD requests are sequential blocking calls.  To keep
    latency reasonable the timeout is capped at 3 s (was 5 s) and we try
    the info["thumbnail"] URL first — if it is already the best quality
    URL (common case after yt-dlp metadata extraction) we skip all HEADs.
    """
    vid_id = info.get("id", "")

    # Validate video ID — must be alphanumeric / dash / underscore
    if vid_id and not re.fullmatch(r"[\w\-]{5,20}", vid_id):
        vid_id = ""

    # Fast path: use yt-dlp's own thumbnail URL if it looks like a full-res hit
    direct_url = info.get("thumbnail", "")
    if direct_url and (
        "maxresdefault" in direct_url or "sddefault" in direct_url
    ):
        return direct_url if _is_safe_thumbnail_url(direct_url) else ""

    # Strategy 1: probe YouTube's standard thumbnail URL hierarchy (max 2 s each).
    # The HEAD requests run concurrently so the total latency is bounded by the
    # slowest single request (~2s) rather than the sum of all candidates (~8s).
    if vid_id:
        candidates = [
            f"https://i.ytimg.com/vi/{vid_id}/maxresdefault.jpg",
            f"https://i.ytimg.com/vi/{vid_id}/sddefault.jpg",
            f"https://i.ytimg.com/vi/{vid_id}/hqdefault.jpg",
            f"https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg",
        ]

        def _head_ok(url: str) -> bool:
            try:
                req = urllib.request.Request(url, method="HEAD",
                    headers={"User-Agent": "Mozilla/5.0"})
                # Safe opener: re-validates the allowlist on every redirect
                # hop; the `with` also ensures the response is closed.
                with _THUMB_OPENER.open(req, timeout=2) as resp:
                    return resp.status == 200
            except Exception:
                return False

        with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
            results = list(pool.map(_head_ok, candidates))
        for url, ok in zip(candidates, results):
            if ok:
                return url

    # Strategy 2: sorted thumbnails list
    thumbs = info.get("thumbnails") or []
    sorted_thumbs = sorted(
        (t for t in thumbs if t.get("url") and _is_safe_thumbnail_url(t["url"])),
        key=lambda t: (t.get("width") or 0) * (t.get("height") or 0),
        reverse=True,
    )
    if sorted_thumbs:
        return sorted_thumbs[0]["url"]

    # Strategy 3: fallback to thumbnail field
    return direct_url if _is_safe_thumbnail_url(direct_url) else ""


def _download_bytes(url: str, timeout: int = 15) -> bytes | None:
    """Download raw bytes from a URL with a proper browser User-Agent."""
    if not url:
        return None
    if not _is_safe_thumbnail_url(url):
        applog.warn(f"Rejected unsafe thumbnail URL: {url}")
        return None
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                "Accept": "image/webp,image/jpeg,*/*",
            },
        )
        with _THUMB_OPENER.open(req, timeout=timeout) as r:
            # Size-capped read: even a "safe"-domain URL must not be able to
            # stream unbounded bytes into memory. Content-Length is advisory
            # (it can lie), so the cap is enforced on the read itself.
            length = r.headers.get("Content-Length")
            if length and length.isdigit() and int(length) > _MAX_THUMB_BYTES:
                applog.warn(f"Thumbnail too large ({length} bytes) — rejected")
                return None
            data = r.read(_MAX_THUMB_BYTES + 1)
            if len(data) > _MAX_THUMB_BYTES:
                applog.warn(f"Thumbnail exceeded {_MAX_THUMB_BYTES} bytes — rejected")
                return None
            return data
    except Exception as exc:
        applog.warn(f"Thumbnail download failed: {exc}")
        return None


# ══════════════════════════════════════════════════════════════════════════════
#  Metadata collector — immutable dataclass built from yt-dlp info dict
# ══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class Metadata:
    title: str = ""
    artist: str = ""
    album: str = ""
    upload_date: str = ""
    genre: str = ""
    webpage_url: str = ""
    video_id: str = ""
    description: str = ""
    language: str = ""
    channel: str = ""
    channel_url: str = ""
    duration: str = ""
    thumbnail_url: str = ""

    @classmethod
    def from_info(cls, info: dict) -> "Metadata":
        title = info.get("title") or ""
        artist = info.get("uploader") or info.get("channel") or ""
        album = info.get("album") or info.get("playlist") or ""

        date_raw = info.get("upload_date", "")
        upload_date = ""
        if date_raw and len(date_raw) == 8 and date_raw.isdigit():
            try:
                upload_date = f"{date_raw[:4]}-{date_raw[4:6]}-{date_raw[6:]}"
            except Exception:
                pass

        genres = info.get("categories") or info.get("tags") or []
        genre = genres[0] if genres else ""

        webpage_url = info.get("webpage_url") or ""
        video_id = info.get("id") or ""

        desc = _sanitize_meta((info.get("description") or "").strip())

        lang = info.get("language") or ""

        channel = info.get("channel") or info.get("uploader") or ""
        channel_url = info.get("channel_url") or ""
        duration = float(info.get("duration") or 0)
        if duration > 0:
            mins, secs = divmod(int(duration), 60)
            hours, mins = divmod(mins, 60)
            if hours:
                duration_str = f"{hours}h {mins}m {secs}s"
            elif mins:
                duration_str = f"{mins}m {secs}s"
            else:
                duration_str = f"{secs}s"
        else:
            duration_str = ""

        thumbnail_url = _best_thumbnail_url(info)

        return cls(
            title=title, artist=artist, album=album,
            upload_date=upload_date, genre=genre,
            webpage_url=webpage_url, video_id=video_id,
            description=desc, language=lang,
            channel=channel, channel_url=channel_url,
            duration=duration_str, thumbnail_url=thumbnail_url,
        )


# ══════════════════════════════════════════════════════════════════════════════
#  Metadata embedding — dispatcher routes by file extension
# ══════════════════════════════════════════════════════════════════════════════

def _collision_safe_tmp(filepath: str, suffix: str = ".meta") -> str:
    """Return a unique temp path in the same directory as filepath."""
    base, ext = os.path.splitext(filepath)
    return f"{base}.{uuid.uuid4().hex[:12]}{suffix}{ext}"


def _atomic_mutagen_save(
    audio_obj,
    filepath: str,
    save_kwargs: dict | None = None,
) -> None:
    """Save mutagen tags to a collision-safe temp file, then atomically
    replace the original. If saving or verification fails, the original
    file is left untouched.

    Mutagen's save() writes to the path given — so we copy the original
    to a temp path, save tags onto the temp, then os.replace() it over.
    This is crash-safe: the original is never corrupted.
    """
    if save_kwargs is None:
        save_kwargs = {}
    tmp = _collision_safe_tmp(filepath)
    try:
        shutil.copy2(filepath, tmp)
        audio_obj.filename = tmp  # redirect mutagen's save target
        audio_obj.save(**save_kwargs)
        # Sanity: temp must exist and be larger than a bare header.
        if not os.path.exists(tmp) or os.path.getsize(tmp) < 44:
            raise RuntimeError(f"Temp file missing or too small after save: {tmp}")
        os.replace(tmp, filepath)
    except Exception:
        # Clean up temp on failure — never leave debris.
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def embed_metadata(
    filepath: str,
    meta: Metadata,
    cover_art: bool = True,
    ffmpeg_bin: str = "ffmpeg",
) -> tuple[bool, bool]:
    """
    Embed metadata + optional cover art into filepath.
    Routes to the correct handler based on file extension.
    Returns (metadata_ok, cover_art_ok).
    """
    if not _MUTAGEN_OK:
        applog.warn("mutagen not installed — skipping metadata embedding")
        return False, False
    if not os.path.exists(filepath):
        applog.error(f"embed_metadata: file not found: {filepath}")
        return False, False

    ext = os.path.splitext(filepath)[1].lower()

    cover_bytes: bytes | None = None
    if cover_art and meta.thumbnail_url:
        cover_bytes = _download_bytes(meta.thumbnail_url)
        if cover_bytes:
            applog.info(f"Cover art downloaded: {len(cover_bytes):,} bytes")
        else:
            applog.warn("Cover art download failed — no bytes returned")

    meta_ok = False
    art_ok = False
    try:
        if ext == ".opus":
            applog.info("Embedding metadata (Opus)...")
            meta_ok, art_ok = _embed_opus(filepath, meta, cover_bytes)
        elif ext == ".mp3":
            applog.info("Embedding metadata (MP3)...")
            meta_ok, art_ok = _embed_mp3(filepath, meta, cover_bytes)
        elif ext in (".m4a", ".mp4"):
            applog.info(f"Embedding metadata ({ext[1:].upper()})...")
            meta_ok, art_ok = _embed_mp4(filepath, meta, cover_bytes)
        elif ext in (".mkv", ".webm", ".wav"):
            applog.info(f"Embedding metadata ({ext[1:].upper()} via ffmpeg)...")
            meta_ok, art_ok = _embed_ffmpeg(filepath, meta, ffmpeg_bin)
        else:
            applog.warn(f"Unsupported container for metadata: {ext}")
            return False, False

        applog.info("Metadata embedding complete.")
    except Exception as exc:
        applog.error(f"embed_metadata exception: {exc}")

    return meta_ok, art_ok


# ══════════════════════════════════════════════════════════════════════════════
#  Opus (OggOpus) handler
# ══════════════════════════════════════════════════════════════════════════════

def _embed_opus(filepath: str, meta: Metadata, cover: bytes | None) -> tuple[bool, bool]:
    try:
        audio = OggOpus(filepath)
        tag_map = {
            "TITLE": _sanitize_meta(meta.title),
            "ARTIST": _sanitize_meta(meta.artist),
            "ALBUM": _sanitize_meta(meta.album),
            "DATE": _sanitize_meta(meta.upload_date),
            "GENRE": _sanitize_meta(meta.genre),
            "COMMENT": _sanitize_meta(meta.webpage_url) or "Downloaded with ytdl flow",
            "VIDEO_ID": _sanitize_meta(meta.video_id),
            "LANGUAGE": _sanitize_meta(meta.language),
            "DESCRIPTION": _sanitize_meta(meta.description),
        }
        # Vorbis comments: setting the key replaces the old value (idempotent).
        for k, v in tag_map.items():
            if v:
                audio[k] = [v]
        # Clear any keys we own that have no new value (prevent stale remnants).
        for k in tag_map:
            if not tag_map[k] and k in audio:
                del audio[k]

        art_ok = False
        if cover:
            try:
                pic = Picture()
                pic.data  = cover
                pic.type  = 3
                pic.mime  = "image/jpeg"
                pic.desc  = "Cover"
                pic.width = pic.height = pic.depth = pic.colors = 0
                encoded = base64.b64encode(pic.write()).decode("ascii")
                audio["metadata_block_picture"] = [encoded]
                art_ok = True
            except Exception as exc:
                applog.warn(f"Opus cover art embed failed: {exc}")

        _atomic_mutagen_save(audio, filepath)
        return True, art_ok
    except Exception as exc:
        applog.error(f"_embed_opus failed: {exc}")
        return False, False


# ══════════════════════════════════════════════════════════════════════════════
#  MP3 (ID3) handler
# ══════════════════════════════════════════════════════════════════════════════

def _embed_mp3(filepath: str, meta: Metadata, cover: bytes | None) -> tuple[bool, bool]:
    try:
        try:
            tags = ID3(filepath)
        except ID3Error:
            tags = ID3()

        # ── Idempotency: clear owned frames before writing new ones ────────
        # tags.add() APPENDS — calling embed twice would duplicate TIT2,
        # TPE1, APIC, etc. We delete all instances of owned frame types
        # first, then add fresh values. Unrelated tags (e.g. TENC encoder,
        # user TXXX keys we don't own) are preserved.
        _OWNED_SIMPLE_FRAMES = ("TIT2", "TPE1", "TALB", "TDRC", "TCON", "TLAN")
        for fid in _OWNED_SIMPLE_FRAMES:
            tags.delall(fid)
        tags.delall("COMM")       # all COMM frames (we own desc="Comment")
        tags.delall("TXXX")       # we own TXXX:video_id (and don't preserve others)
        tags.delall("APIC")       # all picture frames — replaced on re-embed

        title    = _sanitize_meta(meta.title)
        artist   = _sanitize_meta(meta.artist)
        album    = _sanitize_meta(meta.album)
        date     = _sanitize_meta(meta.upload_date)
        genre    = _sanitize_meta(meta.genre)
        web_url  = _sanitize_meta(meta.webpage_url)
        vid_id   = _sanitize_meta(meta.video_id)
        lang     = _sanitize_meta(meta.language)

        if title:       tags.add(TIT2(encoding=3, text=title))
        if artist:      tags.add(TPE1(encoding=3, text=artist))
        if album:       tags.add(TALB(encoding=3, text=album))
        if date:        tags.add(TDRC(encoding=3, text=date))
        if genre:       tags.add(TCON(encoding=3, text=genre))
        if web_url:
            tags.add(COMM(encoding=3, lang="eng", desc="Comment", text=web_url))
        else:
            tags.add(COMM(encoding=3, lang="eng", desc="Comment",
                          text="Downloaded with ytdl flow"))
        if vid_id:
            tags.add(TXXX(encoding=3, desc="video_id", text=vid_id))
        if lang:
            tags.add(TLAN(encoding=3, text=lang))

        art_ok = False
        if cover:
            try:
                tags.add(APIC(encoding=3, mime="image/jpeg", type=3,
                              desc="Cover", data=cover))
                art_ok = True
            except Exception as exc:
                applog.warn(f"MP3 cover art embed failed: {exc}")

        _atomic_mutagen_save(tags, filepath, save_kwargs={"v2_version": 3})
        return True, art_ok
    except Exception as exc:
        applog.error(f"_embed_mp3 failed: {exc}")
        return False, False


# ══════════════════════════════════════════════════════════════════════════════
#  MP4 handler — handles both audio (.m4a) and video (.mp4)
# ══════════════════════════════════════════════════════════════════════════════

def _embed_mp4(filepath: str, meta: Metadata, cover: bytes | None) -> tuple[bool, bool]:
    try:
        audio = MP4(filepath)
        if audio.tags is None:
            audio.add_tags()

        title    = _sanitize_meta(meta.title)
        artist   = _sanitize_meta(meta.artist)
        album    = _sanitize_meta(meta.album)
        date     = _sanitize_meta(meta.upload_date)
        genre    = _sanitize_meta(meta.genre)
        web_url  = _sanitize_meta(meta.webpage_url)
        vid_id   = _sanitize_meta(meta.video_id)
        lang     = _sanitize_meta(meta.language)
        desc     = _sanitize_meta(meta.description)

        # MP4 atoms: assignment replaces (idempotent).
        if title:       audio.tags["\xa9nam"] = [title]
        if artist:      audio.tags["\xa9ART"] = [artist]
        if album:       audio.tags["\xa9alb"] = [album]
        if date:        audio.tags["\xa9day"] = [date]
        if genre:       audio.tags["\xa9gen"] = [genre]
        comment_parts = []
        if web_url:
            comment_parts.append(web_url)
        if vid_id:
            comment_parts.append(f"ID: {vid_id}")
        if comment_parts:
            audio.tags["\xa9cmt"] = [" | ".join(comment_parts)]
        else:
            audio.tags["\xa9cmt"] = ["Downloaded with ytdl flow"]
        if desc:
            audio.tags["desc"] = [desc]
            audio.tags["ldes"] = [desc]
        if lang:
            audio.tags["\xa9lyr"] = [lang]

        art_ok = False
        if cover:
            try:
                audio.tags["covr"] = [MP4Cover(cover, imageformat=MP4Cover.FORMAT_JPEG)]
                art_ok = True
            except Exception as exc:
                applog.warn(f"MP4 cover art embed failed: {exc}")

        _atomic_mutagen_save(audio, filepath)
        return True, art_ok
    except Exception as exc:
        applog.error(f"_embed_mp4 failed: {exc}")
        return False, False


# ══════════════════════════════════════════════════════════════════════════════
#  MKV / WebM handler — uses FFmpeg -c copy (no re-encode)
# ══════════════════════════════════════════════════════════════════════════════

def _embed_ffmpeg(filepath: str, meta: Metadata, ffmpeg_bin: str) -> tuple[bool, bool]:
    tmp = _collision_safe_tmp(filepath, suffix=".meta")
    # Ensure the temp has the same extension so ffmpeg can detect the muxer.
    if not tmp.lower().endswith(os.path.splitext(filepath)[1].lower()):
        tmp += os.path.splitext(filepath)[1].lower()

    meta_args = []
    if meta.title:       meta_args.extend(["-metadata", f"title={meta.title}"])
    if meta.artist:      meta_args.extend(["-metadata", f"artist={meta.artist}"])
    if meta.album:       meta_args.extend(["-metadata", f"album={meta.album}"])
    if meta.upload_date: meta_args.extend(["-metadata", f"date={meta.upload_date}"])
    if meta.genre:       meta_args.extend(["-metadata", f"genre={meta.genre}"])
    if meta.webpage_url: meta_args.extend(["-metadata", f"comment={meta.webpage_url}"])
    if meta.video_id:    meta_args.extend(["-metadata", f"video_id={meta.video_id}"])
    if meta.language:    meta_args.extend(["-metadata", f"language={meta.language}"])
    if meta.description: meta_args.extend(["-metadata", f"description={meta.description}"])

    if not meta_args:
        return True, False

    atime = mtime = None
    try:
        s = os.stat(filepath)
        atime, mtime = s.st_atime, s.st_mtime
    except OSError:
        pass

    cmd = [ffmpeg_bin, "-nostdin", "-y", "-i", filepath, "-c", "copy"] + meta_args + [tmp]
    try:
        # stdin=DEVNULL is critical: capture_output only redirects stdout/stderr,
        # so ffmpeg would otherwise INHERIT this process's stdin — the live
        # NDJSON command pipe from Node. ffmpeg reads stdin by default and can
        # swallow a pending download/cancel command, silently dropping it.
        r = subprocess.run(cmd, capture_output=True, timeout=120,
                           stdin=subprocess.DEVNULL)
        if r.returncode == 0 and os.path.exists(tmp):
            if atime is not None and mtime is not None:
                try:
                    shutil.copystat(filepath, tmp)
                    os.utime(tmp, (atime, mtime))
                except Exception as exc:
                    applog.warn(f"Timestamp preservation failed: {exc}")
            os.replace(tmp, filepath)
            applog.info("FFmpeg metadata embedding succeeded")
            return True, False
        else:
            err = r.stderr.decode(errors="replace")[:300]
            applog.warn(f"FFmpeg metadata failed (rc={r.returncode}): {err}")
            return False, False
    except Exception as exc:
        applog.error(f"_embed_ffmpeg exception: {exc}")
        return False, False
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _ffprobe_bin() -> str | None:
    """Locate ffprobe. `shutil.which` first (fast path, preserves current
    behavior where PATH resolves); else the engine's own FFmpeg resolution
    (FFMPEG_PATH/HOME, known install paths), so FFMPEG_PATH-only setups
    don't silently downgrade mkv/webm verification to extension-trust (N-06).
    Same falsy contract as shutil.which: absolute path or None."""
    found = shutil.which("ffprobe")
    if found:
        return found
    ff_result = AudioDownloadEngine._find_ffmpeg()
    if ff_result:
        return ff_result[2] or None
    return None


# ══════════════════════════════════════════════════════════════════════════════
#  Metadata verification — re-opens file and checks key fields
# ══════════════════════════════════════════════════════════════════════════════

def verify_metadata(filepath: str, meta: Metadata) -> dict[str, bool]:
    """Read metadata back from filepath and verify it matches expectations.

    Strict verification: for each field, reads the actual value from the
    container and compares it (normalized) against the metadata we intended
    to embed. Returns `dict[str, bool]` for backward compatibility with
    `DownloadResult.metadata_verify` consumers — True = PASS, False = FAIL
    or NOT_SUPPORTED.

    Per-format reader:
      MP3   → mutagen ID3 frames (TIT2, TPE1, TALB, TDRC, TCON, COMM, TXXX, TLAN, APIC)
      Opus  → mutagen Vorbis comments + metadata_block_picture (FLAC Picture)
      M4A   → mutagen MP4 atoms (©nam, ©ART, ©alb, ©day, ©gen, ©cmt, covr, desc)
      WAV   → mutagen.wave.WAVE if available, else ffprobe JSON tags
      MKV   → ffprobe JSON tags
      WebM  → ffprobe JSON tags

    Normalization rules (see `_norm_for_compare`):
      • NFKC Unicode normalization, whitespace collapse, case-fold.
      • Date: `Metadata.from_info` already normalizes 'YYYYMMDD' → 'YYYY-MM-DD'.
    """
    # Only `comment` is unconditionally present: every embedder always writes
    # it (with fallback text when no webpage_url exists). Every other key is
    # added below ONLY when actually requested (non-empty in meta), so a field
    # the source never had stays absent from the dict → the UI reports it as
    # NOT_SUPPORTED/N-A, never as a false FAIL.
    result: dict[str, bool] = {"comment": False}
    if not _MUTAGEN_OK or not os.path.exists(filepath):
        return result

    ext = os.path.splitext(filepath)[1].lower()

    # What we expect to find (sanitized, as the embedder would have written it).
    expected = {
        "title":       _sanitize_meta(meta.title),
        "artist":      _sanitize_meta(meta.artist),
        "album":       _sanitize_meta(meta.album),
        "date":        _sanitize_meta(meta.upload_date),
        "genre":       _sanitize_meta(meta.genre),
        "language":    _sanitize_meta(meta.language),
        "video_id":    _sanitize_meta(meta.video_id),
        "description": _sanitize_meta(meta.description),
    }
    expected_comment = _sanitize_meta(meta.webpage_url) or "Downloaded with ytdl flow"

    # Fields that are NOT_REQUESTED (empty in meta) are absent from the result.
    for key, val in expected.items():
        if not val:
            continue  # not requested → don't include in the verify dict
        result[key] = False  # default: will be set True if read-back matches

    try:
        # ── MP3: ID3 frames ─────────────────────────────────────────────────
        if ext == ".mp3":
            from mutagen.id3 import ID3 as _ID3
            try:
                id3 = _ID3(filepath)
            except ID3Error:
                return result

            def _id3_text(fid: str) -> str:
                frame = id3.get(fid)
                if frame is None:
                    return ""
                text = getattr(frame, "text", [""])[0] if frame.text else ""
                return str(text)

            if "title" in result:
                result["title"] = _norm_for_compare(_id3_text("TIT2")) == _norm_for_compare(expected["title"])
            if "artist" in result:
                result["artist"] = _norm_for_compare(_id3_text("TPE1")) == _norm_for_compare(expected["artist"])
            if "album" in result:
                result["album"] = _norm_for_compare(_id3_text("TALB")) == _norm_for_compare(expected["album"])
            if "date" in result:
                result["date"] = _norm_for_compare(_id3_text("TDRC")) == _norm_for_compare(expected["date"])
            if "genre" in result:
                result["genre"] = _norm_for_compare(_id3_text("TCON")) == _norm_for_compare(expected["genre"])
            if "language" in result:
                result["language"] = _norm_for_compare(_id3_text("TLAN")) == _norm_for_compare(expected["language"])

            # Comment: check any COMM frame exists (we own desc="Comment").
            if True:  # comment is always written (fallback text)
                comms = id3.getall("COMM")
                result["comment"] = len(comms) > 0 and any(
                    _norm_for_compare(c.text[0] if c.text else "") == _norm_for_compare(expected_comment)
                    for c in comms if c.text
                )

            # Cover art: APIC frame with type=3 and data length > 0.
            apics = id3.getall("APIC")
            if apics:
                best = next((a for a in apics if a.type == 3), apics[0])
                result["cover_art"] = bool(best.data and len(best.data) > 100)
            else:
                result["cover_art"] = False

            return result

        # ── Opus: Vorbis comments ────────────────────────────────────────────
        if ext == ".opus":
            f = MutagenFile(filepath)
            if f is None:
                return result
            vorbis_map = {
                "title": "TITLE", "artist": "ARTIST", "album": "ALBUM",
                "date": "DATE", "genre": "GENRE", "language": "LANGUAGE",
                "video_id": "VIDEO_ID", "description": "DESCRIPTION",
            }
            for key, vorbis_key in vorbis_map.items():
                if key not in result:
                    continue
                stored = f.get(vorbis_key, [None])[0]
                result[key] = _norm_for_compare(str(stored or "")) == _norm_for_compare(expected[key])

            # Comment (always present).
            stored_comment = f.get("COMMENT", [None])[0]
            result["comment"] = bool(stored_comment)

            # Cover art: metadata_block_picture → decode FLAC Picture → check data.
            mbp = f.get("metadata_block_picture", [None])[0]
            if mbp:
                try:
                    pic_data = base64.b64decode(mbp)
                    pic = Picture(data=pic_data)
                    result["cover_art"] = bool(pic.data and len(pic.data) > 100)
                except Exception:
                    result["cover_art"] = False
            else:
                result["cover_art"] = False

            return result

        # ── M4A / MP4: iTunes-style atoms ────────────────────────────────────
        if ext in (".m4a", ".mp4"):
            f = MutagenFile(filepath)
            if f is None or not hasattr(f, "tags") or not f.tags:
                return result
            atom_map = {
                "title": "\xa9nam", "artist": "\xa9ART", "album": "\xa9alb",
                "date": "\xa9day", "genre": "\xa9gen", "language": "\xa9lyr",
                "description": "desc",
            }
            for key, atom in atom_map.items():
                if key not in result:
                    continue
                stored = f.tags.get(atom, [None])[0]
                result[key] = _norm_for_compare(str(stored or "")) == _norm_for_compare(expected[key])

            # Comment: always written.
            cmt = f.tags.get("\xa9cmt", [None])[0]
            result["comment"] = bool(cmt)

            # Cover art: covr atom with MP4Cover data.
            covr = f.tags.get("covr", [])
            if covr:
                result["cover_art"] = bool(covr[0] and len(covr[0]) > 100)
            else:
                result["cover_art"] = False

            return result

        # ── WAV: mutagen.wave.WAVE (RIFF INFO) or ffprobe ───────────────────
        if ext == ".wav":
            # Try mutagen.wave.WAVE first (it can read RIFF INFO chunks).
            tags_found = False
            try:
                from mutagen.wave import WAVE
                w = WAVE(filepath)
                tags = w.tags or {}
                if tags:  # Only proceed if mutagen actually found tags
                    tags_found = True
                    tag_get = lambda k: str(tags.get(k, "") or "")
                    if "title" in result:
                        result["title"] = _norm_for_compare(tag_get("INAM")) == _norm_for_compare(expected["title"]) or \
                                          _norm_for_compare(tag_get("title")) == _norm_for_compare(expected["title"])
                    if "artist" in result:
                        result["artist"] = _norm_for_compare(tag_get("IART")) == _norm_for_compare(expected["artist"]) or \
                                          _norm_for_compare(tag_get("artist")) == _norm_for_compare(expected["artist"])
                    if "date" in result:
                        result["date"] = _norm_for_compare(tag_get("ICRD")) == _norm_for_compare(expected["date"]) or \
                                        _norm_for_compare(tag_get("date")) == _norm_for_compare(expected["date"])
                    if "genre" in result:
                        result["genre"] = _norm_for_compare(tag_get("IGNR")) == _norm_for_compare(expected["genre"])
                    # Comment: ICMT chunk.
                    result["comment"] = bool(tag_get("ICMT") or tag_get("comment"))
                    # WAV/RIFF INFO has no standard chunks for video_id or
                    # description — omit them (NOT_SUPPORTED), matching the
                    # ffprobe path below.
                    result.pop("video_id", None)
                    result.pop("description", None)
                    # Cover art: WAV/RIFF has no standard embedded-art mechanism.
                    # Deliberately NOT included in result → NOT_SUPPORTED.
                    return result
            except ImportError:
                pass  # mutagen.wave not available — fall through to ffprobe
            except Exception:
                pass  # can't open — fall through

            # ffprobe fallback (primary when mutagen can't read RIFF INFO)
            ffprobe_bin = _ffprobe_bin()
            if ffprobe_bin:
                try:
                    import json as _json
                    cmd = [ffprobe_bin, "-v", "quiet", "-print_format", "json", "-show_format", filepath]
                    # stdin=DEVNULL: ffprobe must never inherit the NDJSON
                    # command pipe (see _embed_ffmpeg note).
                    r = subprocess.run(cmd, capture_output=True, timeout=10,
                                       stdin=subprocess.DEVNULL)
                    if r.returncode == 0:
                        j = _json.loads(r.stdout.decode(errors="replace"))
                        tags = j.get("format", {}).get("tags", {}) or {}
                        lower_tags = {str(k).lower(): str(v) for k, v in tags.items()}
                        for key in ("title", "artist", "album", "date", "genre", "language"):
                            if key in result:
                                result[key] = _norm_for_compare(lower_tags.get(key, "")) == _norm_for_compare(expected[key])
                        result["comment"] = bool(lower_tags.get("comment"))
                        # WAV/RIFF INFO has no standard chunks for video_id or description.
                        # Remove them from result so they're reported as NOT_SUPPORTED.
                        result.pop("video_id", None)
                        result.pop("description", None)
                        # Cover art not supported for WAV — omit from result.
                        return result
                except Exception:
                    pass

            # No verification possible — mark known fields as unverified (False).
            return result

        # ── MKV / WebM: ffprobe JSON ─────────────────────────────────────────
        if ext in (".mkv", ".webm"):
            ffprobe_bin = _ffprobe_bin()
            if ffprobe_bin:
                try:
                    import json as _json
                    cmd = [ffprobe_bin, "-v", "quiet", "-print_format", "json", "-show_format", filepath]
                    # stdin=DEVNULL: ffprobe must never inherit the NDJSON
                    # command pipe (see _embed_ffmpeg note).
                    r = subprocess.run(cmd, capture_output=True, timeout=10,
                                       stdin=subprocess.DEVNULL)
                    if r.returncode == 0:
                        j = _json.loads(r.stdout.decode(errors="replace"))
                        tags = j.get("format", {}).get("tags", {}) or {}
                        lower_tags = {str(k).lower(): str(v) for k, v in tags.items()}
                        # Matroska tags are free-form — _embed_ffmpeg writes
                        # video_id/description as generic -metadata keys and
                        # ffprobe reads them back, so verify them too.
                        for key in ("title", "artist", "album", "date", "genre", "language",
                                    "video_id", "description"):
                            if key in result:
                                result[key] = _norm_for_compare(lower_tags.get(key, "")) == _norm_for_compare(expected[key])
                        result["comment"] = bool(lower_tags.get("comment") or lower_tags.get("description"))
                        # Cover art not supported via ffmpeg path — omit from result.
                        return result
                except Exception:
                    pass
            return result

    except Exception as exc:
        applog.warn(f"Metadata verification failed: {exc}")

    return result


# ══════════════════════════════════════════════════════════════════════════════
#  Format verification  — reads back the file with mutagen
# ══════════════════════════════════════════════════════════════════════════════

def verify_format(filepath: str, expected_fmt: str) -> tuple[bool, str, int]:
    """
    Read the output file with mutagen and confirm it's the expected codec.
    Returns (format_ok, actual_type_name, bitrate_kbps).
    """
    if not _MUTAGEN_OK or not os.path.exists(filepath):
        return False, "unknown", 0
    try:
        f = MutagenFile(filepath)
        if f is None:
            # Fallback for containers mutagen doesn't parse (mkv/webm) — verify via extension + ffprobe.
            ext = os.path.splitext(filepath)[1].lower().lstrip(".")
            if ext in ("mkv", "webm", "mp4", "m4a", "wav", "opus", "mp3"):
                # File exists and extension matches requested format → trust, check via ffprobe if available.
                ffprobe_bin = _ffprobe_bin()
                if ffprobe_bin and ext in ("mkv", "webm"):
                    try:
                        import json as _j
                        r = subprocess.run([ffprobe_bin, "-v", "quiet", "-print_format", "json", "-show_format", filepath],
                                           capture_output=True, timeout=10,
                                           stdin=subprocess.DEVNULL)
                        if r.returncode == 0:
                            j = _j.loads(r.stdout.decode(errors="replace"))
                            fmt_name = j.get("format", {}).get("format_name", "")
                            # ffprobe reports matroska for mkv/webm, mov for mp4/m4a
                            # F-12: "ok = bool(fmt_name)" passed ANY parseable
                            # container — a mislabeled .mkv passed. Require the
                            # container to actually be Matroska.
                            ok = "matroska" in fmt_name
                            return ok, fmt_name or "unknown", 0
                    except Exception:
                        pass
                # Extension match is sufficient for local single-user app; log and trust.
                if ext == expected_fmt or (expected_fmt == "aac" and ext == "m4a"):
                    applog.info(f"Format verification (fallback by extension): {filepath} -> {ext} matches {expected_fmt}")
                    return True, ext, 0
            applog.warn(f"mutagen returned None for {filepath}")
            return False, "unknown", 0

        actual_type = type(f).__name__
        expected_type = _MUTAGEN_TYPE_CHECK.get(expected_fmt, "")
        ok = (actual_type == expected_type)

        bitrate = 0
        if hasattr(f, "info") and hasattr(f.info, "bitrate"):
            bitrate = int(f.info.bitrate // 1000)

        applog.log_format_verify(filepath, expected_fmt, actual_type, ok)
        return ok, actual_type, bitrate
    except Exception as exc:
        applog.warn(f"Format verification error: {exc}")
        return False, "unknown", 0


# ── Per-instance yt-dlp logger (thread-safe stderr capture) ──────────────────

class _YdlLogCollector:
    """Per-instance yt-dlp `logger`.

    Replaces the old process-global `contextlib.redirect_stderr` capture,
    which bled captured output across threads when 5 download + 2 probe
    threads ran yt-dlp concurrently — restore-order inversion could even
    leave sys.stderr pointing at a dead StringIO. yt-dlp routes all of its
    own output through this object instead; stderr from ffmpeg child
    processes still reaches the process stderr and is surfaced by the Node
    layer as engine_log.
    """

    def __init__(self) -> None:
        self.lines: list[str] = []

    def debug(self, msg: str) -> None:
        # Round-4 audit fix (N-02): with a logger installed, yt-dlp routes ALL
        # to_screen output — including "[download] X has already been
        # downloaded" — through debug(). Dropping debug wholesale made the
        # F-07 skip detection read a buffer that could never contain the
        # marker. Capture ONLY the skip line; everything else stays skipped.
        if msg and "has already been downloaded" in msg:
            self.lines.append(msg)

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        if msg:
            self.lines.append(msg)

    def error(self, msg: str) -> None:
        if msg:
            self.lines.append(msg)


# ══════════════════════════════════════════════════════════════════════════════
#  Main download engine
# ══════════════════════════════════════════════════════════════════════════════

ProgressCB = Callable[[str, int, int, float, str], None]


class AudioDownloadEngine:
    """
    Standalone yt-dlp wrapper.

    Key design points
    ─────────────────
    • Cooperative cancellation via threading.Event.
    • Exponential back-off retry (from audio_downloader).
    • Multiple player clients for YouTube restriction bypass.
    • Automatic format verification via mutagen after download.
    • Maximum-quality cover art downloaded and embedded.
    """

    def __init__(
        self,
        output_dir:     str   = "downloads",
        audio_format:   str   = "opus",
        quality:        str   = "high",
        mode:           str   = "audio",
        embed_metadata: bool  = True,
        cover_art:      bool  = True,
        trim_start:     Optional[float] = None,
        trim_end:       Optional[float] = None,
        progress_cb:    Optional[ProgressCB] = None,
        cancel_event:   Optional[threading.Event] = None,
    ) -> None:
        self.output_dir     = output_dir
        self.audio_format   = audio_format
        self.quality        = quality
        self.mode           = mode
        # P2-9: fail fast on an unknown audio format. The old code silently
        # coerced the postprocessor to opus while the progress hook and file
        # resolution still looked for the requested extension — an unsupported
        # value produced a confusing verify failure instead of a clear error.
        if self.mode == "audio" and self.audio_format not in AUDIO_FORMATS:
            raise ValueError(
                f"Unsupported audio_format '{self.audio_format}' "
                f"(supported: {', '.join(sorted(AUDIO_FORMATS))})"
            )
        self.embed_metadata = embed_metadata
        self.cover_art      = cover_art
        self.trim_start     = trim_start
        self.trim_end       = trim_end
        self._progress_cb   = progress_cb
        self._cancel_event  = cancel_event or threading.Event()
        self._tracker       = _SpeedTracker()
        self._hook_filepath: str | None = None
        self._hook_source_filepath: str | None = None
        self._ydl_pre_path:  str | None = None
        self._last_stderr:   str = ""
        self._ffmpeg_dir:   str | None = None
        self._ffmpeg_bin:   str | None = None
        self._ffprobe_bin:  str | None = None
        ff_result = self._find_ffmpeg()
        if ff_result:
            self._ffmpeg_dir, self._ffmpeg_bin, self._ffprobe_bin = ff_result
            # F-17: yt-dlp already receives ffmpeg_location per-instance; the
            # PATH prepend only mattered for SUBPROCESS ffmpeg/ffprobe calls,
            # which use absolute paths anyway. Stop mutating process-global
            # os.environ (5 concurrent constructors used to race on it); keep
            # a guarded setdefault so an absolute ffmpeg is still discoverable.
            if self._ffmpeg_dir and self._ffmpeg_bin and os.path.isabs(self._ffmpeg_bin):
                os.environ.setdefault("FFMPEG_PATH", self._ffmpeg_dir)
        self._deno_bin: str | None = None
        deno_result = self._find_deno()
        if deno_result:
            self._deno_bin = deno_result
    # ── FFmpeg detection (cached) ──────────────────────────────────────────────

    _FFMPEG_CACHE: tuple[str, str, str] | None = None

    @staticmethod
    def _find_ffmpeg() -> tuple[str, str, str] | None:
        """Locate ffmpeg + ffprobe.  Returns (directory, ffmpeg_exe, ffprobe_exe).

        Results are cached after the first call.  Search order:
          1. FFMPEG_PATH  env var
          2. FFMPEG_HOME  env var
          3. shutil.which("ffmpeg")
          4. Beside frozen executable (PyInstaller)
          5. Known hard-coded paths
          6. Drive-letter scan
        """
        cache = AudioDownloadEngine._FFMPEG_CACHE
        if cache is not None:
            return cache if cache[0] else None

        is_win = os.name == "nt"
        def _check(path: str) -> tuple[str, str, str] | None:
            if not path:
                return None
            ffmpeg  = os.path.join(path, "ffmpeg.exe"  if is_win else "ffmpeg")
            ffprobe = os.path.join(path, "ffprobe.exe" if is_win else "ffprobe")
            if os.path.isfile(ffmpeg) and os.path.isfile(ffprobe):
                return (path, ffmpeg, ffprobe)
            return None

        # 1. FFMPEG_PATH
        env_path = os.environ.get("FFMPEG_PATH")
        if env_path:
            result = _check(env_path)
            if result:
                AudioDownloadEngine._FFMPEG_CACHE = result
                return result

        # 2. FFMPEG_HOME
        env_path = os.environ.get("FFMPEG_HOME")
        if env_path:
            result = _check(env_path)
            if result:
                AudioDownloadEngine._FFMPEG_CACHE = result
                return result

        # 3. shutil.which
        candidate = shutil.which("ffmpeg")
        if candidate:
            result = _check(os.path.dirname(candidate))
            if result:
                AudioDownloadEngine._FFMPEG_CACHE = result
                return result

        # 4. Beside frozen executable
        if getattr(sys, "frozen", False):
            result = _check(os.path.dirname(sys.executable))
            if result:
                AudioDownloadEngine._FFMPEG_CACHE = result
                return result

        # 5. Known installation paths
        for path in [
            r"E:\program_files\ffmpeg\bin",
            r"C:\ffmpeg\bin",
            r"C:\Program Files\ffmpeg\bin",
            r"E:\ffmpeg\bin",
            os.path.expanduser(r"~\ffmpeg\bin"),
            "/usr/bin",
            "/usr/local/bin",
        ]:
            result = _check(path)
            if result:
                AudioDownloadEngine._FFMPEG_CACHE = result
                return result

        # 6. Drive-letter scan of known fixed subpaths
        for drive_letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
            for sub in [r"\ffmpeg\bin", r"\program_files\ffmpeg\bin"]:
                result = _check(f"{drive_letter}:{sub}")
                if result:
                    AudioDownloadEngine._FFMPEG_CACHE = result
                    return result

        applog.warn("FFmpeg not found — audio extraction and video merging will fail")
        AudioDownloadEngine._FFMPEG_CACHE = ("", "", "")
        return None

    # ── Deno detection (JS runtime for yt-dlp) ─────────────────────────────────

    _DENO_CACHE: str | None = None

    @staticmethod
    def _find_deno() -> str | None:
        """Locate deno executable.  Returns path to deno binary or None.

        Results are cached after the first call.  Search order:
          1. DENO_PATH  env var
          2. shutil.which("deno")
          3. Beside frozen executable (PyInstaller)
          4. Beside the script (python-engine/binaries/)
          5. Known installation paths
        """
        cache = AudioDownloadEngine._DENO_CACHE
        if cache is not None:
            return cache if cache else None

        is_win = os.name == "nt"
        exe = "deno.exe" if is_win else "deno"

        # 1. DENO_PATH
        env_path = os.environ.get("DENO_PATH")
        if env_path:
            candidate = os.path.join(env_path, exe) if os.path.isdir(env_path) else env_path
            if os.path.isfile(candidate):
                AudioDownloadEngine._DENO_CACHE = candidate
                return candidate

        # 2. shutil.which
        candidate = shutil.which("deno")
        if candidate:
            AudioDownloadEngine._DENO_CACHE = candidate
            return candidate

        # 3. Beside frozen executable
        if getattr(sys, "frozen", False):
            frozen_path = os.path.join(os.path.dirname(sys.executable), exe)
            if os.path.isfile(frozen_path):
                AudioDownloadEngine._DENO_CACHE = frozen_path
                return frozen_path

        # 4. Beside the script (python-engine/binaries/ or ./binaries/)
        for base in [
            os.path.dirname(os.path.abspath(__file__)),
            os.getcwd(),
        ]:
            candidate = os.path.join(base, "binaries", exe)
            if os.path.isfile(candidate):
                AudioDownloadEngine._DENO_CACHE = candidate
                return candidate

        # 5. Known installation paths
        for path in [
            r"C:\Program Files\deno\deno.exe",
            r"C:\deno\deno.exe",
            os.path.expanduser(r"~\deno\deno.exe"),
            os.path.expanduser(r"~\.deno\bin\deno.exe"),
            "/usr/bin/deno",
            "/usr/local/bin/deno",
        ]:
            if os.path.isfile(path):
                AudioDownloadEngine._DENO_CACHE = path
                return path

        applog.warn("Deno not found — yt-dlp will run without JS runtime (degraded extraction)")
        AudioDownloadEngine._DENO_CACHE = ""
        return None

    # ── YouTube cookie auth (bot-check bypass) ────────────────────────────────
    # YouTube flags anonymous datacenter/VPN/burst traffic with "Sign in to
    # confirm you're not a bot". Authenticated cookies from a signed-in
    # browser session prove a real account is behind the request and clear
    # the check in most cases.

    _COOKIES_CACHE: dict | None = None
    _COOKIES_LOCK = threading.Lock()

    # Browsers yt-dlp can read cookies from (yt_dlp.cookies.SUPPORTED_BROWSERS
    # on 2026.08.19: brave/chrome/chromium/edge/firefox/opera/safari/vivaldi/
    # whale). Anything else fails deep inside yt-dlp with an opaque error —
    # reject it here with the valid list instead of a confusing crash.
    _SUPPORTED_COOKIE_BROWSERS = frozenset({
        "brave", "chrome", "chromium", "edge", "firefox",
        "opera", "safari", "vivaldi", "whale",
    })

    @staticmethod
    def _find_cookies() -> dict:
        """Resolve cookie opts for yt-dlp. Cached after the first call.

        Sources (in order):
          1. YTDL_COOKIES_FILE  — path to a Netscape cookies.txt export
             (headless-safe; recommended for servers).
          2. YTDL_COOKIES_BROWSER — browser name for --cookies-from-browser
             style auth (e.g. "chrome", "firefox", "edge", "brave").

        Returns a dict of yt-dlp opts (possibly empty). Cookie CONTENTS are
        never logged — only whether a source was configured.

        Thread-safe: the engine runs 2 probe + 5 download threads
        concurrently, and the first burst would otherwise race on the
        check-then-set (duplicate warn lines, torn-dict edge). The lock also
        guards _reset_cookies_cache (tests) against a concurrent reader.
        Cache key includes the env values so a mid-process env change (tests,
        operator export + engine restart) can't serve a stale path.
        """
        env_file = (os.environ.get("YTDL_COOKIES_FILE") or "").strip().strip("\"'")
        env_browser = (os.environ.get("YTDL_COOKIES_BROWSER") or "").strip().lower()
        with AudioDownloadEngine._COOKIES_LOCK:
            cache = AudioDownloadEngine._COOKIES_CACHE
            if (
                cache is not None
                and cache.get("_env_file") == env_file
                and cache.get("_env_browser") == env_browser
            ):
                return {k: v for k, v in cache.items() if not k.startswith("_env_")}

            opts: dict = {}
            if env_file:
                if os.path.isfile(env_file):
                    opts["cookiefile"] = env_file
                else:
                    applog.warn(
                        f"YTDL_COOKIES_FILE points at a missing file: {env_file} — "
                        "continuing without cookies (bot-checks may fail)"
                    )
            elif env_browser:
                if env_browser in AudioDownloadEngine._SUPPORTED_COOKIE_BROWSERS:
                    opts["cookiesfrombrowser"] = (env_browser,)
                else:
                    applog.warn(
                        f"YTDL_COOKIES_BROWSER={env_browser!r} is not supported by "
                        f"yt-dlp (valid: {', '.join(sorted(AudioDownloadEngine._SUPPORTED_COOKIE_BROWSERS))}) — "
                        "continuing without cookies (bot-checks may fail)"
                    )

            AudioDownloadEngine._COOKIES_CACHE = {
                **opts,
                "_env_file": env_file,
                "_env_browser": env_browser,
            }
            return dict(opts)

    @staticmethod
    def _reset_cookies_cache() -> None:
        """Test-only: clear the cookie cache under the lock."""
        with AudioDownloadEngine._COOKIES_LOCK:
            AudioDownloadEngine._COOKIES_CACHE = None

    @staticmethod
    def cookie_status() -> dict:
        """Safe-for-status cookie report: source configured, never contents.

        Returns {"configured": bool, "source": "file"|"browser"|"none"} so
        /api/status can tell the operator whether bot-check auth is armed
        without ever exposing cookie values or file contents.
        """
        opts = AudioDownloadEngine._find_cookies()
        if "cookiefile" in opts:
            return {"configured": True, "source": "file"}
        if "cookiesfrombrowser" in opts:
            return {"configured": True, "source": "browser"}
        return {"configured": False, "source": "none"}

    def _cookie_opts(self) -> dict:
        return self._find_cookies()

    # ── Public API ─────────────────────────────────────────────────────────────

    def probe(self, url: str, deadline: float | None = None) -> tuple[dict | None, str]:
        """
        Fetch video metadata without downloading.
        Tries multiple player clients for maximum compatibility.
        Returns (info_dict, "") on success, (None, error_msg) on failure.

        `deadline` is an absolute `time.monotonic()` value owned by the IPC
        layer (60 s from command acceptance, including executor queue wait).
        The loop never starts or continues work past it, and caps its
        back-off sleep to the remaining budget.
        """
        opts = {
            "quiet":         True,
            "no_warnings":   True,
            "noplaylist":    True,
            "skip_download": True,
            # F-11: a probe is interactive — the old inner machinery (20 s
            # socket, retries 5, extractor 3) times THREE outer attempts meant
            # minutes of silence before the error surfaced. 15/3/2 keeps the
            # same resilience shape with a practical ceiling.
            "socket_timeout": 15,
            "retries":        3,
            "extractor_retries": 2,
            "geo_bypass": True,
            # BOT-FIX: same pacing/cookies as downloads (see _build_opts).
            # Probes are what tripped the bot throttle after ~20 rapid
            # lookups — cookies authenticate them, sleep_interval_requests
            # spaces bursts (extraction-phase only; no pre-download sleep).
            "sleep_interval_requests": 2,
            **self._cookie_opts(),
        }
        if self._deno_bin:
            opts["js_runtimes"] = {"deno": {"path": self._deno_bin}}
        last_err = ""
        # Per-instance logger: keeps yt-dlp output off the process stderr
        # (which carries the NDJSON protocol on stdout... and logs on stderr)
        # without any process-global redirection.
        opts["logger"] = _YdlLogCollector()
        probe_started = time.monotonic()
        if deadline is None:
            deadline = probe_started + 60.0
        timed_out = False
        for attempt in range(3):
            # Absolute deadline: never start an attempt the caller has already
            # given up on (including a worker that waited in the executor queue).
            if time.monotonic() >= deadline:
                timed_out = True
                break
            try:
                with YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                if info:
                    # A success that lands past the deadline is stale by
                    # contract — report timeout instead of a late success.
                    if time.monotonic() >= deadline:
                        timed_out = True
                        break
                    applog.log_probe(
                        url,
                        info.get("title", "?"),
                        float(info.get("duration") or 0),
                        info.get("uploader", "?"),
                    )
                    return info, ""
            except Exception as exc:
                last_err = str(exc)
                applog.warn(f"Probe attempt {attempt + 1} failed: {last_err[:120]}")
                # BOT-FIX: same fail-fast as downloads — retrying into an
                # active bot-check only hardens the block.
                if is_bot_detection_error(last_err):
                    break
                # F-11: deadline — once the budget is spent, report now instead
                # of looping through the remaining attempts.
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                if attempt < 2:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        timed_out = True
                        break
                    time.sleep(min(1.5 * (attempt + 1), remaining))

        if timed_out:
            timeout_msg = "Probe timed out after 60s."
            applog.log_probe_error(url, "ProbeTimeout", timeout_msg)
            return None, timeout_msg

        applog.log_probe_error(url, classify_error_type(last_err), last_err)
        # BOT-FIX: surface the actionable cookie/pacing hint to the UI
        # instead of the raw yt-dlp auth paragraph alone.
        if is_bot_detection_error(last_err):
            last_err = f"{last_err}\n\n{bot_fix_hint()}"
        return None, last_err

    def download(self, url: str, info: dict | None = None,
                 retry_cb=None) -> DownloadResult:
        """Download and apply the same cancellation signal to FFmpeg children."""
        with _ffmpeg_cancellation_scope(self._cancel_event):
            return self._download_with_retry(url, info, retry_cb)

    def _download_with_retry(self, url: str, info: dict | None = None,
                             retry_cb=None) -> DownloadResult:
        """Download with automatic retry (exponential back-off).

        `retry_cb(attempt, delay_seconds, error_msg)` is invoked before each
        automatic retry so the caller can surface in-progress retries to the
        user — the UI otherwise looks frozen while yt-dlp waits out back-off.
        The callback is best-effort: a raise inside it is logged and ignored.
        """
        retry = RetryStrategy(max_retries=3, initial_delay=2.0)
        last_exc: Exception = RuntimeError("unknown")

        while True:
            try:
                return self._download_once(url, info)
            except Exception as exc:
                last_exc = exc
                if isinstance(exc, DownloadCancelledError):
                    for output_path, description in (
                        (exc.output_path, "incomplete FFmpeg output"),
                        (self._hook_filepath, "incomplete FFmpeg output"),
                        (self._hook_source_filepath, "cancelled download intermediate"),
                    ):
                        if output_path:
                            self._remove_cancelled_download_file(output_path, description)
                # BOT-FIX: hammering the same URL while the bot-check is active
                # makes the IP look MORE automated, not less. Fail fast with
                # the actionable hint instead of burning all retries.
                if is_bot_detection_error(str(exc)):
                    break
                if not retry.should_retry(exc):
                    break
                delay = retry.next_delay()
                applog.warn(f"Download attempt failed, retrying in {delay:.1f}s: "
                            f"{str(exc)[:120]}")
                if retry_cb is not None:
                    try:
                        retry_cb(retry._attempt, delay, str(exc)[:300])
                    except Exception:
                        applog.warn("retry callback failed")
                # Cancellable back-off: event.wait returns True if the cancel
                # was requested during the sleep — honor it immediately instead
                # of forcing the user to wait out the full 2/4/8s.
                if self._cancel_event.wait(delay):
                    error_msg = "Download cancelled by user."
                    applog.log_download_error(url, "Cancelled", error_msg)
                    return DownloadResult(
                        success=False, url=url,
                        error=error_msg, error_type="Cancelled",
                    )

        error_msg  = str(last_exc)
        error_type = classify_error_type(error_msg)
        if error_type == "BotDetectionError":
            error_msg = f"{error_msg}\n\n{bot_fix_hint()}"
        applog.log_download_error(url, error_type, error_msg)
        return DownloadResult(
            success=False, url=url,
            error=error_msg, error_type=error_type,
        )

    def _remove_cancelled_download_file(self, output_path: str, description: str) -> None:
        output_root = os.path.normcase(os.path.realpath(self.output_dir))
        candidate = os.path.normcase(os.path.realpath(output_path))
        try:
            if os.path.commonpath((output_root, candidate)) != output_root:
                return
        except ValueError:
            return
        try:
            if os.path.getmtime(candidate) < self._download_started:
                return
            os.remove(candidate)
            applog.info(f"Removed {description} after cancellation: {os.path.basename(candidate)}")
        except FileNotFoundError:
            pass
        except OSError as exc:
            applog.error(f"Could not remove incomplete FFmpeg output after cancellation: {exc}")

    # ── yt-dlp options ─────────────────────────────────────────────────────────

    def _build_opts(self) -> dict:
        opts: dict = {
            "outtmpl":   os.path.join(self.output_dir, "%(title)s.%(ext)s"),
            # ── Stability ──────────────────────────────────────────────────────
            # F-07: an explicit overwrite policy beats yt-dlp's implicit default.
            # Skipping keeps the first file untouched (no partial overwrite), and
            # the skip DETECTION below turns "silently reused an old file" into
            # an honest warning instead of a fake re-download success.
            "overwrites": False,
            "quiet":              True,
            "no_warnings":        True,
            "noplaylist":         True,
            "geo_bypass":         True,
            "socket_timeout":     30,
            "retries":            10,
            "fragment_retries":   10,
            "extractor_retries":  5,
            "file_access_retries": 5,
            # BOT-FIX: pace requests so rapid successive probes/downloads stop
            # tripping YouTube's "Sign in to confirm you're not a bot" throttle.
            # sleep_interval_requests paces EXTRACTION requests (the phase that
            # got throttled after ~20 lookups) with no first-request penalty.
            # sleep_interval/max_sleep_interval pace the DOWNLOAD phase (per
            # yt-dlp docs they sleep before each download) — kept small so a
            # single interactive download stays fast while bursts spread out.
            # NOTE: the subtitle key is sleep_interval_subtitles (not
            # sleep_subtitles) — verified against yt-dlp 2026.08.19 source.
            "sleep_interval_requests": 2,
            "sleep_interval":        1,
            "max_sleep_interval":    5,
            "sleep_interval_subtitles": 1,
            # BOT-FIX: authenticated cookies bypass the anonymous-IP bot check.
            # Resolved once per engine instance (see _find_cookies) from
            # YTDL_COOKIES_FILE (Netscape cookies.txt) or YTDL_COOKIES_BROWSER
            # (e.g. "chrome"). Never logged — cookie contents are secrets.
            **self._cookie_opts(),
            # ── Hooks ──────────────────────────────────────────────────────────
            "progress_hooks": [self._hook],
        }
        if self._deno_bin:
            opts["js_runtimes"] = {"deno": {"path": self._deno_bin}}

        # No manual `player_client` override here. Forcing a client list (even
        # with mobile clients) strips the multi-client format merge that the
        # default config performs, which is what exposes audio-only formats
        # (opus/m4a 249/250/251 etc.). With the override, `bestaudio/best`
        # could only resolve a muxed video+audio track (e.g. format 18) —
        # which the old engine then downloaded a second time via its vcodec
        # retry. yt-dlp's default clients are also battle-tested against 403s.

        if self.mode == "video":
            if self._ffmpeg_bin:
                opts["ffmpeg_location"] = self._ffmpeg_dir
                if self.audio_format not in _VALID_VIDEO_CONTAINERS:
                    raise RuntimeError(
                        f"Unsupported video container '{self.audio_format}'. "
                        f"Valid formats: {', '.join(sorted(_VALID_VIDEO_CONTAINERS))}."
                    )
                q = VIDEO_QUALITY_PRESETS.get(self.quality, VIDEO_QUALITY_PRESETS["high"])
                opts["format"] = q["format"]
                opts["merge_output_format"] = self.audio_format
            else:
                h = _HEIGHT_MAP.get(self.quality, 1080)
                opts["format"] = f"best[height<={h}]/best"
        else:
            if not self._ffmpeg_bin:
                raise RuntimeError(
                    "FFmpeg not found — required for audio extraction. "
                    "Install FFmpeg and ensure it's on PATH or set FFMPEG_PATH."
                )
            opts["ffmpeg_location"] = self._ffmpeg_dir
            q = QUALITY_PRESETS.get(self.quality, QUALITY_PRESETS["high"])
            ext = AUDIO_FORMATS.get(self.audio_format, "opus")
            opts["format"] = q["format"]
            opts["postprocessors"] = [{
                "key":              "FFmpegExtractAudio",
                "preferredcodec":   ext,
                "preferredquality": q["preferredquality"],
            }]

        return opts

    def _hook(self, d: dict) -> None:
        """yt-dlp progress hook — cooperative cancellation check-point."""
        if self._cancel_event.is_set():
            raise DownloadCancelledError("Download cancelled by user.")

        status = d.get("status")
        if status == "downloading":
            total      = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            speed      = float(d.get("speed") or 0.0)
            # NaN/Inf would serialize as a bare `NaN` token in the NDJSON
            # channel and break the Node side's strict JSON.parse — clamp.
            if not math.isfinite(speed):
                speed = 0.0
            filename   = os.path.basename(d.get("filename", ""))
            self._tracker.record(speed)
            if self._progress_cb:
                self._progress_cb("downloading", downloaded, total, speed, filename)

        elif status == "finished":
            raw = d.get("filename", "")
            if raw:
                self._hook_source_filepath = raw
                if self.mode == "audio":
                    ext = AUDIO_FORMATS.get(self.audio_format, self.audio_format)
                    self._hook_filepath = os.path.splitext(raw)[0] + f".{ext}"
                else:
                    self._hook_filepath = raw
            if self._progress_cb:
                self._progress_cb("finished", 0, 0, 0.0, "")

    def _download_once(self, url: str, info: dict | None) -> DownloadResult:
        # F-13: video without FFmpeg silently degrades to progressive <=720p
        # even when 1080p/4K was requested — surface the cap in the log.
        self._no_ffmpeg_video = self.mode == "video" and not self._ffmpeg_bin
        if self._no_ffmpeg_video:
            applog.warn(
                "FFmpeg not found — downloading progressive stream only; "
                "resolution is capped by YouTube (~720p max) regardless of the "
                f"requested {self.quality} preset."
            )
        os.makedirs(self.output_dir, exist_ok=True)
        self._hook_filepath = None
        self._ydl_pre_path  = None
        self._tracker       = _SpeedTracker()
        # Record when this download started so the filepath fallback can prefer
        # files created during this download rather than an unrelated file.
        # MUST be wall-clock epoch time: it is compared against
        # os.path.getmtime() (epoch seconds). time.monotonic() is boot-relative
        # and always ≪ any file mtime, which made the "newer than start" filter
        # a mathematical no-op.
        self._download_started = time.time()
        self._hook_source_filepath = None

        applog.log_download_start(url, self.audio_format, self.quality)

        opts = self._build_opts()

        expected_height = _HEIGHT_MAP.get(self.quality, 0) if self.mode == "video" else 0
        has_retried = False
        # N-03: duplicate-title collision handling — see the resolve step in
        # the loop below. One retry, never deletes or overwrites user files.
        collision_retried = False
        # Info from the first extraction attempt — kept so that fields absent
        # from a retry client's info dict (mobile clients omit uploader /
        # webpage_url) can be restored before metadata embedding.
        first_info: dict | None = None

        while True:
            self._hook_filepath = None
            self._hook_source_filepath = None
            self._ydl_pre_path = None
            self._tracker = _SpeedTracker()
            # Per-instance logger (NOT global stderr redirection): 5 download
            # threads run yt-dlp concurrently — a process-global redirect bled
            # captured output across threads and could leave sys.stderr
            # pointing at a dead StringIO after restore-order inversion.
            collector = _YdlLogCollector()
            opts["logger"] = collector
            try:
                with YoutubeDL(opts) as ydl:
                    dl_info = ydl.extract_info(url, download=True)
                    if info is None:
                        info = dl_info
                    if first_info is None and dl_info:
                        first_info = dl_info
                    try:
                        self._ydl_pre_path = ydl.prepare_filename(info)
                    except Exception:
                        self._ydl_pre_path = None
            except Exception:
                captured = "\n".join(collector.lines)
                if captured.strip():
                    applog.error(f"yt-dlp errors during extract_info: {captured[-2000:]}")
                raise
            finally:
                self._last_stderr = "\n".join(collector.lines)

            if info is None:
                raise RuntimeError("yt-dlp returned no info dict")

            fmt_id = info.get("format_id", "?")
            vcodec = info.get("vcodec")
            height = info.get("height")
            width = info.get("width")
            req_fmts = info.get("requested_formats")
            if req_fmts:
                for rf in req_fmts:
                    if rf.get("vcodec") != "none":
                        height = rf.get("height") or height
                        width = rf.get("width") or width
                        vcodec = rf.get("vcodec") or vcodec
                        break
            elif self.mode == "video" and self._ffmpeg_bin:
                applog.warn(
                    f"Video download fell back to progressive stream — "
                    f"format_id={fmt_id} res={width}x{height}. "
                    "No DASH format merge occurred."
                )

            # One-time retry for android_vr flakiness (yt-dlp#16150)
            if (
                not has_retried
                and self.mode == "video"
                and expected_height > 0
                and (height or 0) < expected_height
            ):
                applog.warn(
                    f"Video quality below target ({width}x{height} < {expected_height}p) — "
                    f"retrying once (yt-dlp#16150 workaround)"
                )
                has_retried = True
                info = None
                continue

            # (No audio-mode video-track retry here.) Mobile player clients are
            # forced from the start in _build_opts and the audio format
            # selector is `bestaudio` (audio-only, no muxed `/best` fallback),
            # so a video-bearing resolution can no longer happen. The old retry
            # re-downloaded the same muxed stream a second time with identical
            # options — a pure waste that doubled every affected download.

            # N-03: resolve INSIDE the loop. A second video whose sanitized
            # title collides with an existing file must not silently bind (or,
            # via the postprocessor, overwrite) that file. Detect it by mtime —
            # the resolved path predates this download's start — and retry once
            # with an id-suffixed template so each video owns its own file.
            _merge_missing_info(info, first_info)

            filepath = self._resolve_filepath(info)
            if not filepath:
                msg = (
                    "Output file not found after download.\n"
                    "Is FFmpeg installed?  sudo apt install ffmpeg\n"
                    "Or: winget install Gyan.FFmpeg"
                )
                if self._last_stderr and self._last_stderr.strip():
                    msg += f"\n\nCaptured stderr:\n{self._last_stderr[-2000:]}"
                raise RuntimeError(msg)

            try:
                reused_preexisting = os.path.getmtime(filepath) < self._download_started
            except OSError:
                reused_preexisting = False
            if reused_preexisting and not collision_retried:
                applog.warn(
                    f"Resolved output '{os.path.basename(filepath)}' predates this "
                    "download — a same-title collision. Retrying once with an "
                    "id-suffixed template to keep both videos' files distinct."
                )
                collision_retried = True
                opts["outtmpl"] = os.path.join(self.output_dir, "%(title)s [%(id)s].%(ext)s")
                info = None
                continue
            if reused_preexisting:
                # Id-suffixed path ALSO pre-exists: the same video was already
                # downloaded before — keep the existing file (idempotent) and
                # say so honestly instead of implying a fresh fetch.
                applog.warn(f"Keeping existing file (not re-downloaded): {filepath}")

            break

        file_size = os.path.getsize(filepath)

        # Trim if requested
        if self.trim_start is not None and self.trim_end is not None:
            self._trim(filepath)
            file_size = os.path.getsize(filepath)

        # Embed metadata + cover art
        metadata_fields: dict[str, str] = {}
        metadata_verify: dict[str, bool] = {}
        metadata_engine = ""
        metadata_container = ""
        metadata_cover_art = False
        thumb_ok = False
        meta_ok = True  # M-1: defined when embedding is off so the warnings
        # block below can distinguish "not attempted" from "attempted+failed".
        if self.embed_metadata:
            meta = Metadata.from_info(info)
            meta_ok, thumb_ok = embed_metadata(
                filepath, meta, self.cover_art, self._ffmpeg_bin or "ffmpeg"
            )
            if meta_ok:
                metadata_verify = verify_metadata(filepath, meta)
                metadata_fields = {
                    k: str(v) if not isinstance(v, str) else v
                    for k, v in asdict(meta).items() if v
                }

            ext = os.path.splitext(filepath)[1].lower()
            metadata_container = _CONTAINER_NAMES.get(ext, ext.lstrip(".").upper())
            # WAV/MKV/WebM embedding and verification go through FFmpeg/ffprobe,
            # not mutagen — report the engine that actually did the work.
            metadata_engine = "FFmpeg" if ext in (".mkv", ".webm", ".wav") else "Mutagen"
            metadata_cover_art = bool(thumb_ok and self.cover_art and meta.thumbnail_url)

            # Re-measure size after metadata embedding
            try:
                file_size = os.path.getsize(filepath)
            except OSError:
                pass

        # Verify the actual format
        fmt_ok, actual_type, bitrate = verify_format(filepath, self.audio_format)

        applog.log_download_success(
            title      = info.get("title", "?"),
            filepath   = filepath,
            file_size  = file_size,
            duration   = float(info.get("duration") or 0),
            avg_speed  = self._tracker.avg_speed,
            elapsed    = self._tracker.elapsed,
        )

        # F-07: yt-dlp skips the transfer when the target already exists
        # ("has already been downloaded"); report that instead of implying a
        # fresh fetch. F-13: no-FFmpeg video downloads ride a warning too.
        warnings: list[str] = []
        if "has already been downloaded" in (self._last_stderr or ""):
            warnings.append("file already existed — not re-downloaded")
        if getattr(self, "_no_ffmpeg_video", False):
            warnings.append(
                "downloaded without FFmpeg — progressive stream "
                "(resolution may be below the requested preset)"
            )
        # M-1: tag embedding failed — the file is fine but the checklist
        # would otherwise render all-N/A with no note, indistinguishable
        # from "nothing requested" (ADR-007 honesty).
        if self.embed_metadata and not meta_ok:
            warnings.append(
                "metadata tags not embedded — file is playable, tags missing"
            )

        return DownloadResult(
            success            = True,
            url                = url,
            title              = info.get("title", "Unknown"),
            uploader           = info.get("uploader", "") or info.get("channel", ""),
            filepath           = filepath,
            filename           = os.path.basename(filepath),
            fmt                = self.audio_format,
            file_size          = file_size,
            duration           = float(info.get("duration") or 0),
            video_id           = info.get("id", ""),
            avg_speed          = self._tracker.avg_speed,
            peak_speed         = self._tracker.peak_speed,
            warnings           = " — ".join(warnings),
            elapsed            = self._tracker.elapsed,
            bitrate            = bitrate,
            thumbnail_ok       = thumb_ok,
            format_ok          = fmt_ok,
            metadata_fields    = metadata_fields,
            metadata_verify    = metadata_verify,
            metadata_engine    = metadata_engine,
            metadata_container = metadata_container,
            metadata_cover_art = metadata_cover_art,
        )

    def _resolve_filepath(self, info: dict) -> str:
        """Multiple strategies to locate the output file."""
        ext = AUDIO_FORMATS.get(self.audio_format, self.audio_format)
        title = info.get("title", "audio")

        # 0. yt-dlp's prepare_filename (exact path before postprocessing)
        pre = self._ydl_pre_path
        if pre:
            # 0a. Try the path as-is first. This works for progressive video
            #     streams (e.g. format 18) where no DASH merge occurs and the
            #     file keeps its original extension (.mp4).
            if os.path.exists(pre):
                return pre

            # 0b. Try with postprocessor-adjusted extension
            base, _ = os.path.splitext(pre)
            # For audio: postprocessor changes extension to preferredcodec
            # For video: merge_output_format sets the container extension
            target_ext = ext if self.mode == "audio" else self.audio_format
            final = f"{base}.{target_ext}"
            if os.path.exists(final):
                return final

        # 1. Path captured in progress hook
        if self._hook_filepath:
            if os.path.exists(self._hook_filepath):
                return self._hook_filepath
        else:
            pass

        # 2. Computed from sanitised title
        safe_title = sanitize_filename(title)
        computed   = os.path.join(self.output_dir, f"{safe_title}.{ext}")
        if os.path.exists(computed):
            return computed

        # 3. yt-dlp records the postprocessed path per requested download.
        # Prefer this deterministic source before scanning a shared directory.
        requested = info.get("requested_downloads")
        if isinstance(requested, list) and requested:
            filepath = requested[-1].get("filepath") if isinstance(requested[-1], dict) else None
            if isinstance(filepath, str) and os.path.exists(filepath):
                return filepath

        # 4. Scan downloads dir for a matching-extension file created during
        #    this download. Prefer files newer than the download start time so
        #    concurrent same-format downloads don't resolve to the wrong file.
        try:
            files = os.listdir(self.output_dir)
            start_mtime = self._download_started
            matches = [
                os.path.join(self.output_dir, f)
                for f in files
                # P2-11: exclude in-flight temp artifacts of concurrent
                # downloads — ".meta." (metadata-embed tmp), ".trim." (trim
                # tmp) and generic ".tmp" partials all end with the target
                # extension but must never be bound as the final output.
                if f.lower().endswith(f".{ext}")
                and ".meta." not in f.lower()
                and ".trim." not in f.lower()
                and not f.lower().endswith(".tmp")
            ]
            if matches:
                # Prefer files created after this download started.
                recent = [m for m in matches if os.path.getmtime(m) >= start_mtime]
                pool = recent or matches
                return max(pool, key=os.path.getmtime)
        except OSError:
            pass

        return ""

    def _trim(self, filepath: str) -> None:
        ffmpeg = self._ffmpeg_bin or "ffmpeg"
        # Keep the original extension on the temp file: ffmpeg infers the
        # output muxer from the extension, and ".tmp" is unknown → it failed
        # with "Unable to find a suitable output format" EVERY time.
        base, ext = os.path.splitext(filepath)
        tmp = f"{base}.trim.tmp{ext}"
        cmd = [
            ffmpeg, "-nostdin", "-y", "-i", filepath,
            "-ss", str(self.trim_start),
            "-to", str(self.trim_end),
            "-c", "copy", tmp,
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=120,
                               stdin=subprocess.DEVNULL)
            if r.returncode == 0 and os.path.exists(tmp):
                os.replace(tmp, filepath)
                applog.info(f"Trim applied: {self.trim_start}s – {self.trim_end}s")
            else:
                applog.warn(
                    f"FFmpeg trim failed (rc={r.returncode}): "
                    f"{r.stderr.decode(errors='replace')[:200]}"
                )
        except Exception as exc:
            applog.error(f"Trim exception: {exc}")
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass


def parse_timestamp(text: str) -> float:
    """Convert HH:MM:SS / MM:SS / seconds string → float seconds."""
    text = text.strip()
    if not text:
        raise ValueError("Timestamp is empty.")
    parts = text.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        elif len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        pass
    raise ValueError(f"Invalid timestamp: {text!r}")
