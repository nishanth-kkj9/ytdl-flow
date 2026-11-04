"""Round-3 pin tests: F-02 jobs-snapshot enrichment, F-10 trim wiring through
the IPC layer, F-12 verify_format honesty for mkv/webm, F-13 no-FFmpeg video
warning, F-17 environ-mutation guard.

Each mirrors a defect from the round-3 audit that had no test.
"""
import io
import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import ipc_main  # noqa: E402
from engine import AudioDownloadEngine, verify_format  # noqa: E402


def _dispatch(command: dict) -> list:
    """Run a command through the IPC layer and return all NDJSON replies."""
    buf = io.StringIO()
    original = ipc_main._ORIGINAL_STDOUT
    ipc_main._ORIGINAL_STDOUT = buf
    try:
        ipc_main._handle_command(command)
    finally:
        ipc_main._ORIGINAL_STDOUT = original
    return [json.loads(l) for l in buf.getvalue().splitlines() if l.strip()]


def test_jobs_snapshot_carries_upstream_fields_after_registration():
    """F-02: the jobs reply must carry url/fmt/quality/mode so a refreshed
    browser can rebuild a row from /api/status."""
    import ipc_main as m

    with m._LOCK:
        m._DOWNLOAD_JOBS["job-1"] = {
            "cancel_event": threading.Event(),
            "status": "queued",
            "url": "https://youtu.be/aaaa",
            "fmt": "mp3",
            "quality": "high",
            "mode": "audio",
        }
    try:
        msg = _dispatch({"cmd": "jobs", "request_id": "r-f02"})
    finally:
        with m._LOCK:
            m._DOWNLOAD_JOBS.pop("job-1", None)
    assert msg[0]["type"] == "jobs_result"
    assert msg[0]["request_id"] == "r-f02"
    entry = msg[0]["jobs"][0]
    assert entry["id"] == "job-1"
    assert entry["url"] == "https://youtu.be/aaaa"
    assert entry["fmt"] == "mp3"
    assert entry["quality"] == "high"
    assert entry["mode"] == "audio"


def _dispatch(command: dict) -> list:
    """Run a command through the IPC layer and return all NDJSON replies."""
    buf = io.StringIO()
    original = ipc_main._ORIGINAL_STDOUT
    ipc_main._ORIGINAL_STDOUT = buf
    try:
        ipc_main._handle_command(command)
    finally:
        ipc_main._ORIGINAL_STDOUT = original
    return [json.loads(l) for l in buf.getvalue().splitlines() if l.strip()]


def test_download_command_forwards_trim_fields_to_engine(monkeypatch):
    """F-10: a download command carrying trim_start/trim_end must thread them
    into the AudioDownloadEngine constructor (the engine already implements
    _trim but ipc_main never passed the args — the feature was unreachable)."""
    import ipc_main as m

    captured = {}

    def fake_engine(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(m, "AudioDownloadEngine", fake_engine)
    with m._LOCK:
        m._DOWNLOAD_JOBS.clear()
    _dispatch({
        "cmd": "download",
        "id": "dl-trim",
        "url": "https://youtu.be/cccc",
        "format": "mp3",
        "quality": "high",
        "mode": "audio",
        # Empty output_dir resolves to the allowed project downloads dir.
        "output_dir": "",
        "trim_start": 30,
        "trim_end": 90,
    })
    assert captured.get("trim_start") == 30
    assert captured.get("trim_end") == 90


def test_verify_format_requires_matroska_for_mkv(monkeypatch, tmp_path):
    """F-12: a mislabeled .mkv that is actually MP4 must NOT pass verification —
    the old 'ok = bool(fmt_name)' passed any parseable container."""
    import engine as eng
    from unittest.mock import patch

    # The file must exist (verify_format early-returns on missing files).
    target = tmp_path / "fake.mkv"
    target.write_bytes(b"\x00\x01\x02")  # garbage — mutagen returns None, ffprobe path

    # Force the ffprobe branch: mutagen returns None for .mkv AND shutil.which
    # must find an ffprobe (on this machine it may not be installed).
    monkeypatch.setattr(eng.shutil, "which", lambda name: "/fake/ffprobe" if name == "ffprobe" else None)
    fake_json = json.dumps({"format": {"format_name": "mov,mp4"}})

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = fake_json.encode()
            stderr = b""
        return R()

    with patch("engine.subprocess.run", side_effect=fake_run):
        ok, name, _ = verify_format(str(target), "mkv")
    assert ok is False, "a non-Matroska file must not pass mkv verification"
    assert name == "mov,mp4"


def test_verify_format_accepts_matroska_webm(monkeypatch, tmp_path):
    import engine as eng
    from unittest.mock import patch

    target = tmp_path / "fake.webm"
    target.write_bytes(b"\x00\x01\x02")

    monkeypatch.setattr(eng.shutil, "which", lambda name: "/fake/ffprobe" if name == "ffprobe" else None)
    fake_json = json.dumps({"format": {"format_name": "matroska,webm"}})

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = fake_json.encode()
            stderr = b""
        return R()

    with patch("engine.subprocess.run", side_effect=fake_run):
        ok, name, _ = verify_format(str(target), "webm")
    assert ok is True
    assert "matroska" in name


def test_no_ffmpeg_video_warns_and_sets_flag(monkeypatch):
    """F-13: video mode without FFmpeg must warn AND set the result warning —
    silently degrading to progressive <=720p was confusing."""
    import engine as eng
    from unittest.mock import patch, MagicMock

    warnings = []
    monkeypatch.setattr(eng.applog, "warn", lambda msg: warnings.append(msg))

    eng_inst = AudioDownloadEngine(
        output_dir=os.path.join(os.path.sep, "tmp"),
        mode="video",
        audio_format="mp4",
        quality="1080p",
    )

    captured_opts = {}
    mock_ydl = MagicMock()
    mock_ydl.extract_info.side_effect = RuntimeError("boom")
    mock_ydl.__enter__ = MagicMock(return_value=mock_ydl)
    mock_ydl.__exit__ = MagicMock(return_value=False)

    def capture_opts(opts, *a, **kw):
        captured_opts.update(opts)
        return mock_ydl

    with patch("engine.YoutubeDL", side_effect=capture_opts):
        with pytest.raises(RuntimeError):
            eng_inst._download_once("https://youtu.be/aaaa", None)

    # The flag is only meaningful when ffmpeg is absent; when it is present,
    # the warning must NOT have fired (we don't falsely warn).
    if eng_inst._ffmpeg_bin is None:
        assert getattr(eng_inst, "_no_ffmpeg_video", False) is True
        assert any("FFmpeg not found" in w for w in warnings), warnings
    else:
        assert not any("FFmpeg not found" in w for w in warnings)


def test_write_result_carries_warnings_on_the_wire(monkeypatch):
    """Round-4 N-01: the dataclass had `warnings` but _write_result omitted it
    from the NDJSON payload — the browser note and server-side honesty were
    dead code. The wire contract must carry the field."""
    from engine import DownloadResult

    result = DownloadResult(success=True, url="u", title="T", warnings="file already existed — not re-downloaded")
    buf = io.StringIO()
    monkeypatch.setattr(ipc_main, "_ORIGINAL_STDOUT", buf)
    ipc_main._write_result("wire-1", result)

    lines = [l for l in buf.getvalue().splitlines() if l.strip()]
    assert lines, "one NDJSON reply must be emitted"
    msg = json.loads(lines[0])
    assert msg["type"] == "result"
    assert msg["warnings"] == "file already existed — not re-downloaded"


def test_log_collector_captures_already_downloaded_marker():
    """Round-4 N-02: yt-dlp routes "[download] X has already been downloaded"
    through logger.debug (verified against yt-dlp's to_screen source), which
    the collector skipped — F-07 skip detection read a buffer that could never
    contain the marker. The collector must capture exactly that line."""
    from engine import _YdlLogCollector

    c = _YdlLogCollector()
    c.debug("[download] OM – SIYA ENTRY.mp3 has already been downloaded")
    c.debug("[download] Destination: OM – SIYA ENTRY.mp3")  # verbose noise
    c.info("[download] 100% of 3.00MiB")  # info stays skipped
    c.warning("some warning")  # warnings still captured

    joined = "\n".join(c.lines)
    assert any("has already been downloaded" in l for l in c.lines)
    assert not any("Destination:" in l for l in c.lines), "debug noise must stay skipped"
    assert not any("100%" in l for l in c.lines), "info lines must stay skipped"
    assert "some warning" in joined


def test_environ_not_prepended_when_ffmpeg_on_path(monkeypatch):
    """F-17: constructing an engine must not mutate process-global PATH — the
    PATH/FFMPEG_PATH prepend was racy across 5 concurrent constructors."""
    import os as _os

    before_path = _os.environ.get("PATH", "")
    before_ffmpeg = _os.environ.get("FFMPEG_PATH", None)
    try:
        AudioDownloadEngine(
            output_dir=os.path.join(os.path.sep, "tmp"),
            mode="audio", audio_format="mp3", quality="high",
        )
    except Exception:
        pass  # environment may lack ffmpeg; the assertion below is the point
    assert _os.environ.get("PATH", "") == before_path, (
        "PATH must not be mutated by engine construction"
    )
    if before_ffmpeg is None:
        # setdefault: if an absolute ffmpeg was found it MAY set FFMPEG_PATH,
        # but it must never have already existed and been overwritten.
        assert _os.environ.get("FFMPEG_PATH") is None or _os.path.isabs(
            _os.environ["FFMPEG_PATH"]
        )


def test_duplicate_title_collision_retries_with_id_suffixed_template(monkeypatch, tmp_path):
    """Round-4 N-03 (F-07 core): a second video whose sanitized title collides
    with an existing file must trigger exactly ONE retry with a "[%(id)s]"
    template — not silently bind (or overwrite) the other video's file."""
    import time as _time
    from unittest.mock import patch, MagicMock

    import engine as eng

    engine = AudioDownloadEngine(
        output_dir=str(tmp_path), mode="audio", audio_format="mp3", quality="high"
    )
    # CI runners have no FFmpeg: _build_opts() raises for audio mode without
    # it. Fake a resolved ffmpeg so the test exercises the collision flow
    # (extract is mocked; embed/verify are patched out — ffmpeg is never run).
    monkeypatch.setattr(engine, "_ffmpeg_bin", "/fake/ffmpeg")
    monkeypatch.setattr(engine, "_ffmpeg_dir", "/fake")

    pre_existing = tmp_path / "Same Title.mp3"
    pre_existing.write_bytes(b"old content")
    os.utime(pre_existing, (1, 1))  # ancient mtime — predates any download

    calls = {"resolve": 0}
    opts_seen = []

    def fake_resolve(info):
        calls["resolve"] += 1
        if calls["resolve"] == 1:
            return str(pre_existing)  # collision: pre-existing, older file
        fresh = tmp_path / "Same Title [abc].mp3"
        fresh.write_bytes(b"fresh content")
        future = _time.time() + 10
        os.utime(fresh, (future, future))  # created AFTER download start
        return str(fresh)

    monkeypatch.setattr(engine, "_resolve_filepath", fake_resolve)
    monkeypatch.setattr(eng, "embed_metadata", lambda *a, **k: (True, False))
    monkeypatch.setattr(eng, "verify_metadata", lambda *a, **k: {})
    monkeypatch.setattr(eng, "verify_format", lambda *a, **k: (True, "mp3", 320))

    info = {"title": "Same Title", "id": "abc", "ext": "mp3", "duration": 1, "uploader": "u"}
    mock_ydl = MagicMock()
    mock_ydl.extract_info.return_value = dict(info)
    mock_ydl.__enter__ = MagicMock(return_value=mock_ydl)
    mock_ydl.__exit__ = MagicMock(return_value=False)

    def capture_opts(opts, *a, **kw):
        opts_seen.append(dict(opts))
        return mock_ydl

    with patch("engine.YoutubeDL", side_effect=capture_opts):
        result = engine.download("https://youtu.be/abc")

    assert result.success is True
    assert calls["resolve"] == 2, "exactly one collision retry expected"
    assert len(opts_seen) == 2
    assert opts_seen[0]["outtmpl"].endswith("%(title)s.%(ext)s")
    assert "[%(id)s]" in opts_seen[1]["outtmpl"]
    assert result.filepath == str(tmp_path / "Same Title [abc].mp3")


def test_embed_failure_warns_instead_of_silent_na(monkeypatch, tmp_path):
    """M-1: when tag embedding fails, the result must carry a warning — an
    all-N/A checklist with no note is indistinguishable from
    'nothing requested' and violates honest reporting (ADR-007)."""
    import time as _time
    from unittest.mock import patch, MagicMock

    import engine as eng

    engine = AudioDownloadEngine(
        output_dir=str(tmp_path), mode="audio", audio_format="mp3", quality="high"
    )
    monkeypatch.setattr(engine, "_ffmpeg_bin", "/fake/ffmpeg")
    monkeypatch.setattr(engine, "_ffmpeg_dir", "/fake")

    fresh = tmp_path / "Tagged Song.mp3"
    fresh.write_bytes(b"fresh content")
    future = _time.time() + 10
    os.utime(fresh, (future, future))
    monkeypatch.setattr(engine, "_resolve_filepath", lambda info: str(fresh))
    # Embed FAILS (e.g. mutagen write error); file itself is fine.
    monkeypatch.setattr(eng, "embed_metadata", lambda *a, **k: (False, False))
    monkeypatch.setattr(eng, "verify_metadata", lambda *a, **k: {})
    monkeypatch.setattr(eng, "verify_format", lambda *a, **k: (True, "mp3", 320))

    info = {"title": "Tagged Song", "id": "xyz", "ext": "mp3", "duration": 1, "uploader": "u"}
    mock_ydl = MagicMock()
    mock_ydl.extract_info.return_value = dict(info)
    mock_ydl.__enter__ = MagicMock(return_value=mock_ydl)
    mock_ydl.__exit__ = MagicMock(return_value=False)

    with patch("engine.YoutubeDL", return_value=mock_ydl):
        result = engine.download("https://youtu.be/xyz")

    assert result.success is True, "file is fine — only tagging failed"
    assert "tags not embedded" in (result.warnings or ""), (
        "embed failure must surface a warning, not a silent all-N/A checklist"
    )