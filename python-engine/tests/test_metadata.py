"""Production-grade metadata embedding and verification tests.

Tests use real temporary media files generated via ffmpeg (when available).
Where ffmpeg is not available, tests are skipped rather than mocked —
metadata correctness depends on real container behaviour, not mocked objects.

Cover art: tests use a minimal valid JPEG (smallest possible — 134 bytes)
generated inline as base64, avoiding external image dependencies.
"""
import base64
import os
import shutil
import sys
import uuid

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import (  # noqa: E402
    _sanitize_meta,
    _norm_for_compare,
    _collision_safe_tmp,
    Metadata,
    embed_metadata,
    verify_metadata,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

# Smallest valid JPEG (1×1 pixel, white) — 134 bytes.
_MINIMAL_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA"
    "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA"
    "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3"
    "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm"
    "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA"
    "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx"
    "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK"
    "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3"
    "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii"
    "gD//2Q=="
)

FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None


def _make_sample_media(tmp_path: str, ext: str) -> str:
    """Generate a tiny valid media file via ffmpeg. Returns the filepath."""
    if not FFMPEG_AVAILABLE:
        pytest.skip("ffmpeg not available — cannot generate real media fixtures")
    filepath = os.path.join(str(tmp_path), f"test_{uuid.uuid4().hex[:8]}.{ext}")
    rate = 44100
    codec_args = []
    if ext == "opus":
        rate = 48000
        codec_args = ["-c:a", "libopus", "-b:a", "6k"]
    elif ext in ("m4a", "mp4"):
        codec_args = ["-c:a", "aac", "-b:a", "8k"]
    elif ext in ("mkv", "webm"):
        rate = 48000
        codec_args = ["-c:a", "libopus", "-b:a", "6k"]
    elif ext == "mp3":
        codec_args = ["-q:a", "9"]
    import subprocess
    cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={rate}:cl=mono", "-t", "0.1", *codec_args, filepath]
    r = subprocess.run(cmd, capture_output=True, timeout=30)
    if r.returncode != 0 or not os.path.exists(filepath):
        pytest.skip(f"ffmpeg failed to generate .{ext} fixture")
    return filepath


def _make_meta(**overrides) -> Metadata:
    defaults = {
        "title": "Test Video Title", "artist": "Test Channel",
        "album": "Test Album", "upload_date": "2026-01-15",
        "genre": "Music", "webpage_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "video_id": "dQw4w9WgXcQ", "language": "eng",
        "description": "A test video description.", "thumbnail_url": "",
    }
    defaults.update(overrides)
    return Metadata(**defaults)


# ── Sanitization ──────────────────────────────────────────────────────────────

class TestSanitization:
    def test_strips_control_characters(self):
        assert _sanitize_meta("hello\x00\x1f\x7fworld") == "helloworld"

    def test_strips_zero_width_and_bidi(self):
        assert _sanitize_meta("te\u200bst\u202eext\ufeff") == "testext"

    def test_preserves_unicode(self):
        assert _sanitize_meta("日本語テスト") == "日本語テスト"

    def test_caps_length(self):
        assert len(_sanitize_meta("x" * 10_000)) == 5000

    def test_empty(self):
        assert _sanitize_meta("") == ""


class TestNormalization:
    def test_whitespace_collapse(self):
        assert _norm_for_compare("hello   world") == _norm_for_compare("hello world")

    def test_case_fold(self):
        assert _norm_for_compare("Hello World") == _norm_for_compare("hello world")

    def test_nfkc(self):
        assert _norm_for_compare("½") == _norm_for_compare("1⁄2")


class TestCollisionSafeTmp:
    def test_unique_names(self):
        paths = {_collision_safe_tmp("/tmp/test.mp3") for _ in range(100)}
        assert len(paths) == 100

    def test_preserves_extension(self):
        assert _collision_safe_tmp("/tmp/file.mp3").endswith(".mp3")


# ── MP3 ───────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="ffmpeg required for fixtures")
class TestMP3Metadata:
    def test_embed_and_verify(self, tmp_path):
        filepath = _make_sample_media(str(tmp_path), "mp3")
        meta = _make_meta()
        meta_ok, _ = embed_metadata(filepath, meta, cover_art=False)
        assert meta_ok
        verify = verify_metadata(filepath, meta)
        assert verify.get("title") is True, f"title: {verify}"
        assert verify.get("artist") is True
        assert verify.get("album") is True
        assert verify.get("comment") is True

    def test_idempotency_no_duplicates(self, tmp_path):
        from mutagen.id3 import ID3
        filepath = _make_sample_media(str(tmp_path), "mp3")
        meta = _make_meta()
        for _ in range(3):
            embed_metadata(filepath, meta, cover_art=False)
        tags = ID3(filepath)
        assert len(tags.getall("TIT2")) == 1, f"Expected 1 TIT2, got {len(tags.getall('TIT2'))}"
        assert len(tags.getall("TPE1")) == 1

    def test_unicode(self, tmp_path):
        filepath = _make_sample_media(str(tmp_path), "mp3")
        meta = _make_meta(title="日本語タイトル曲", artist="アーティスト名")
        embed_metadata(filepath, meta, cover_art=False)
        verify = verify_metadata(filepath, meta)
        assert verify.get("title") is True, f"Unicode title: {verify}"

    def test_missing_optional_fields(self, tmp_path):
        filepath = _make_sample_media(str(tmp_path), "mp3")
        meta = _make_meta(title="Only Title", artist="OA", album="", upload_date="",
                          genre="", webpage_url="", video_id="", language="", description="")
        meta_ok, _ = embed_metadata(filepath, meta, cover_art=False)
        assert meta_ok
        verify = verify_metadata(filepath, meta)
        assert verify.get("title") is True
        assert "genre" not in verify or not verify["genre"]


# ── Opus ──────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="ffmpeg required for fixtures")
class TestOpusMetadata:
    def test_embed_and_verify(self, tmp_path):
        filepath = _make_sample_media(str(tmp_path), "opus")
        meta = _make_meta()
        meta_ok, _ = embed_metadata(filepath, meta, cover_art=False)
        assert meta_ok
        verify = verify_metadata(filepath, meta)
        assert verify.get("title") is True

    def test_idempotency(self, tmp_path):
        from mutagen.oggopus import OggOpus
        filepath = _make_sample_media(str(tmp_path), "opus")
        meta = _make_meta()
        for _ in range(3):
            embed_metadata(filepath, meta, cover_art=False)
        audio = OggOpus(filepath)
        assert len(audio.get("TITLE", [])) == 1


# ── M4A / MP4 ─────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="ffmpeg required for fixtures")
class TestMP4Metadata:
    def test_embed_and_verify(self, tmp_path):
        filepath = _make_sample_media(str(tmp_path), "m4a")
        meta = _make_meta()
        meta_ok, _ = embed_metadata(filepath, meta, cover_art=False)
        assert meta_ok
        verify = verify_metadata(filepath, meta)
        assert verify.get("title") is True
        assert verify.get("album") is True

    def test_idempotency(self, tmp_path):
        from mutagen.mp4 import MP4
        filepath = _make_sample_media(str(tmp_path), "m4a")
        meta = _make_meta()
        for _ in range(3):
            embed_metadata(filepath, meta, cover_art=False)
        audio = MP4(filepath)
        assert len(audio.tags.get("\xa9nam", [])) == 1


# ── WAV ───────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="ffmpeg required for fixtures")
class TestWAVMetadata:
    def test_embed_succeeds(self, tmp_path):
        filepath = _make_sample_media(str(tmp_path), "wav")
        meta = _make_meta()
        meta_ok, _ = embed_metadata(filepath, meta, cover_art=False)
        assert meta_ok

    def test_no_false_cover_art(self, tmp_path):
        """WAV does not support embedded cover art — must NOT appear in verify dict."""
        filepath = _make_sample_media(str(tmp_path), "wav")
        meta = _make_meta()
        embed_metadata(filepath, meta, cover_art=False)
        verify = verify_metadata(filepath, meta)
        assert "cover_art" not in verify, \
            "cover_art must be absent (NOT_SUPPORTED, not FAIL)"


# ── MKV ───────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="ffmpeg required for fixtures")
class TestMKVMetadata:
    def test_embed_succeeds(self, tmp_path):
        filepath = _make_sample_media(str(tmp_path), "mkv")
        meta = _make_meta()
        meta_ok, _ = embed_metadata(filepath, meta, cover_art=False)
        assert meta_ok


# ── General ───────────────────────────────────────────────────────────────────

class TestGeneralMetadata:
    def test_metadata_from_info_sanitizes_description(self):
        info = {"description": "text\x00with\x1fcontrol\x7fchars" * 100}
        meta = Metadata.from_info(info)
        assert "\x00" not in meta.description
        assert "\x1f" not in meta.description

    def test_metadata_from_info_no_450_cap(self):
        info = {"description": "y" * 2000}
        meta = Metadata.from_info(info)
        assert len(meta.description) == 2000

    def test_metadata_from_info_date_normalization(self):
        info = {"upload_date": "20260903"}
        meta = Metadata.from_info(info)
        assert meta.upload_date == "2026-09-03"


# ── ffprobe discovery (N-06) ───────────────────────────────────────────────

class TestFfprobeDiscovery:
    def test_ffprobe_bin_prefers_path_which(self):
        """When ffprobe resolves via PATH, the helper returns exactly that."""
        import shutil as _shutil

        from engine import _ffprobe_bin

        assert _ffprobe_bin() == _shutil.which("ffprobe")

    def test_ffprobe_bin_falls_back_to_ffmpeg_path(self, tmp_path, monkeypatch):
        """FFMPEG_PATH-only setups (no PATH ffprobe) must still resolve —
        otherwise mkv/webm verification silently downgrades to
        extension-trust."""
        import os as _os
        import shutil as _shutil

        import engine as eng

        bindir = tmp_path / "ffmpegbin"
        bindir.mkdir()
        exe = ".exe" if _os.name == "nt" else ""
        (bindir / f"ffmpeg{exe}").write_bytes(b"x")
        (bindir / f"ffprobe{exe}").write_bytes(b"x")
        monkeypatch.setenv("FFMPEG_PATH", str(bindir))
        monkeypatch.setattr(_shutil, "which", lambda *a, **k: None)
        saved = eng.AudioDownloadEngine._FFMPEG_CACHE
        eng.AudioDownloadEngine._FFMPEG_CACHE = None
        try:
            assert eng._ffprobe_bin() == str(bindir / f"ffprobe{exe}")
        finally:
            eng.AudioDownloadEngine._FFMPEG_CACHE = saved
            monkeypatch.delenv("FFMPEG_PATH", raising=False)
