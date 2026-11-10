"""Unit tests for the IPC layer in ipc_main.py.

Key focus: regression tests for the P1 path-traversal (SEC-02) fix that
prevents the engine from writing output files outside the project downloads
directory.
"""
import os
import sys

# Make `import ipc_main` resolve the sibling engine module directory.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ipc_main import _resolve_output_dir, _YDL_PROJECT_ROOT  # noqa: E402


_BASE = os.path.realpath(os.path.join(_YDL_PROJECT_ROOT, "..", "downloads"))


def test_allow_project_downloads_dir():
    assert _resolve_output_dir(_BASE) == _BASE


def test_allow_subdirectory_inside_downloads():
    sub = os.path.join(_BASE, "subfolder")
    assert _resolve_output_dir(sub) == sub


def test_reject_etc_cron_d():
    assert _resolve_output_dir("/etc/cron.d") is None


def test_reject_tmp_evil():
    assert _resolve_output_dir(os.path.join(os.path.sep, "tmp", "evil")) is None


def test_reject_windows_system_dir():
    # Must reject arbitrary absolute system paths (cross-platform guard).
    assert _resolve_output_dir("C:\\Windows") is None


def test_default_resolves_to_downloads():
    assert _resolve_output_dir("") == _BASE


def test_configured_download_root_allows_only_paths_beneath_it(tmp_path, monkeypatch):
    root = tmp_path / "chosen-downloads"
    nested = root / "nested"
    outside = tmp_path / "outside"
    nested.mkdir(parents=True)
    outside.mkdir()
    monkeypatch.setenv("YTDL_DOWNLOADS_DIR", str(root))

    assert _resolve_output_dir("") == os.path.realpath(root)
    assert _resolve_output_dir(str(nested)) == os.path.realpath(nested)
    assert _resolve_output_dir(str(outside)) is None


def test_configured_download_root_still_rejects_symlink_escape(tmp_path, monkeypatch):
    root = tmp_path / "chosen-downloads"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = root / "escape"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        import pytest
        pytest.skip("directory symlinks are unavailable")
    monkeypatch.setenv("YTDL_DOWNLOADS_DIR", str(root))

    assert _resolve_output_dir(str(link)) is None


# ── `jobs` command (WS-reconnect reconciliation snapshot) ─────────────────────

def _capture_jobs_reply(command: dict) -> dict:
    """Run a command through _handle_command and return the last NDJSON reply."""
    import io
    import json
    import ipc_main

    buf = io.StringIO()
    original = ipc_main._ORIGINAL_STDOUT
    ipc_main._ORIGINAL_STDOUT = buf
    try:
        ipc_main._handle_command(command)
    finally:
        ipc_main._ORIGINAL_STDOUT = original

    lines = [l for l in buf.getvalue().strip().splitlines() if l.strip()]
    assert lines, "jobs command must produce exactly one NDJSON reply"
    return json.loads(lines[-1])


def test_jobs_command_reports_active_jobs():
    import json
    import threading
    import ipc_main

    # Seed the job map directly (as _start_download would after registration).
    with ipc_main._LOCK:
        ipc_main._DOWNLOAD_JOBS["job-1"] = {
            "cancel_event": threading.Event(), "status": "running"}
        ipc_main._DOWNLOAD_JOBS["job-2"] = {
            "cancel_event": threading.Event(), "status": "queued"}
    try:
        msg = _capture_jobs_reply({"cmd": "jobs", "request_id": "r-42"})
    finally:
        with ipc_main._LOCK:
            ipc_main._DOWNLOAD_JOBS.pop("job-1", None)
            ipc_main._DOWNLOAD_JOBS.pop("job-2", None)

    assert msg["type"] == "jobs_result"
    assert msg["request_id"] == "r-42"
    jobs = {j["id"]: j["status"] for j in msg["jobs"]}
    assert jobs == {"job-1": "running", "job-2": "queued"}


def test_jobs_command_empty_when_no_active_downloads():
    import ipc_main

    assert ipc_main._DOWNLOAD_JOBS == {}, "test assumes an empty job map"
    msg = _capture_jobs_reply({"cmd": "jobs", "request_id": "r-empty"})
    assert msg["type"] == "jobs_result"
    assert msg["request_id"] == "r-empty"
    assert msg["jobs"] == []


# ── Engine readiness and missing-dependency diagnostics (DX-01) ──────────────

def test_ready_message_includes_protocol_version(monkeypatch):
    """IPC versioning: engine_ready must advertise the NDJSON protocol version
    so a stale engine paired with a newer server is detectable, never silent."""
    import io
    import json
    import ipc_main

    buf = io.StringIO()
    monkeypatch.setattr(ipc_main, "_ORIGINAL_STDOUT", buf)
    ipc_main._emit_ready()

    msg = json.loads(buf.getvalue())
    assert msg["type"] == "engine_ready"
    assert msg["protocol_version"] == 1


def test_ready_message_reports_core_python_dependency_flags(monkeypatch):
    """The readiness handshake must expose both required Python libraries."""
    import io
    import json
    import ipc_main

    buf = io.StringIO()
    monkeypatch.setattr(ipc_main, "_ORIGINAL_STDOUT", buf)
    monkeypatch.setattr(ipc_main, "_YDL_OK", False)
    monkeypatch.setattr(ipc_main, "_MUTAGEN_OK", True)
    ipc_main._emit_ready()

    msg = json.loads(buf.getvalue())
    assert msg["type"] == "engine_ready"
    assert msg["yt_dlp"] is False
    assert msg["mutagen"] is True


def test_probe_reports_missing_yt_dlp_from_the_running_interpreter(monkeypatch):
    """Corrected DX-01 behavior: do not misdiagnose a missing dependency as network trouble."""
    import io
    import json
    import ipc_main

    class NoInfoEngine:
        def probe(self, _url):
            return None, ""

    buf = io.StringIO()
    monkeypatch.setattr(ipc_main, "_ORIGINAL_STDOUT", buf)
    monkeypatch.setattr(ipc_main, "_YDL_OK", False)
    monkeypatch.setattr(ipc_main, "AudioDownloadEngine", NoInfoEngine)
    ipc_main._probe("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "probe-1")

    msg = json.loads(buf.getvalue())
    assert msg["type"] == "error"
    assert "yt-dlp is not installed in the Python interpreter running the engine" in msg["error"]
    assert "pip install -r python-engine/requirements.lock" in msg["error"]
