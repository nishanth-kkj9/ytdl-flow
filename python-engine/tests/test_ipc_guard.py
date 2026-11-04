"""P0-2 regression tests for the IPC dispatch guard.

The engine's main loop must survive ANY exception raised while handling a
command (e.g. os.makedirs hitting EACCES or a disk-full error inside
_start_download): the guard replies with a terminal InternalError for that
command id and keeps the NDJSON channel alive. A regression here kills every
in-flight download and silently bricks the Node layer.
"""
import io
import json
import os
import subprocess
import sys

# Make `import ipc_main` resolve the sibling engine module directory.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402


def _capture_dispatch_replies(command) -> list:
    """Run a command through the guarded dispatch and return all NDJSON replies."""
    import ipc_main

    buf = io.StringIO()
    original = ipc_main._ORIGINAL_STDOUT
    ipc_main._ORIGINAL_STDOUT = buf
    try:
        ipc_main._dispatch_safely(command)
    finally:
        ipc_main._ORIGINAL_STDOUT = original
    return [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]


def test_guard_replies_internalerror_with_matching_id(monkeypatch):
    """A handler exception must produce InternalError for the same id — not exit."""
    import ipc_main

    def boom(_command):
        raise OSError("simulated EACCES from test")

    monkeypatch.setattr(ipc_main, "_handle_command", boom)
    replies = _capture_dispatch_replies(
        {"cmd": "download", "id": "guard-1", "url": "https://example.com/watch?v=x"}
    )

    assert len(replies) == 1, "exactly one terminal reply must be emitted"
    err = replies[0]
    assert err["type"] == "error"
    assert err["id"] == "guard-1", "the reply must carry the failed command's id"
    assert err["error_type"] == "InternalError"
    assert "OSError" in err["error"]


def test_guard_survives_repeated_failures(monkeypatch):
    """The guard is per-command: repeated failures must not poison the loop."""
    import ipc_main

    def boom(_command):
        raise RuntimeError("still broken")

    monkeypatch.setattr(ipc_main, "_handle_command", boom)
    for i in range(3):
        replies = _capture_dispatch_replies({"cmd": "jobs", "request_id": f"r-{i}"})
        assert replies, f"dispatch #{i} produced no reply"
        assert replies[0]["error_type"] == "InternalError"


def test_engine_process_survives_hostile_stdin(tmp_path):
    """End-to-end: garbage on stdin must not kill the engine process, and a
    valid command sent after the garbage still gets its reply (pins P0-2
    together with the P1-5 lenient readline)."""
    engine_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.Popen(
        [sys.executable, os.path.join(engine_dir, "ipc_main.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=engine_dir,
        text=True,
        encoding="utf-8",
    )
    try:
        # 1. Invalid JSON → JSONDecodeError reply.
        # 2. Valid JSON, non-object → InvalidCommand reply.
        # 3. A real `jobs` command → jobs_result proves the loop still reads.
        proc.stdin.write("{not json}\n")
        proc.stdin.write("[1, 2, 3]\n")
        proc.stdin.write(
            json.dumps({"cmd": "jobs", "request_id": "after-garbage"}) + "\n"
        )
        proc.stdin.flush()

        types = []
        # engine_ready comes first; then the three replies in order.
        for _ in range(5):
            line = proc.stdout.readline()
            if not line:
                break
            types.append(json.loads(line).get("type"))
            if types[-1] == "jobs_result":
                break

        assert types and types[-1] == "jobs_result", (
            f"engine died or never answered after hostile input: {types}"
        )
        assert proc.poll() is None, "engine process must still be running"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_breaker_opens_after_three_bot_failures():
    import ipc_main as ipc
    ipc._BOT_BREAKER_FAILURES = 0
    ipc._BOT_BREAKER_OPEN_UNTIL = 0.0
    ipc._BOT_BREAKER_LAST_ERROR = None
    try:
        ipc._bot_breaker_failure("Sign in to confirm you're not a bot")
        ipc._bot_breaker_failure("Sign in to confirm you're not a bot")
        assert ipc._bot_breaker_check() is None
        ipc._bot_breaker_failure("Sign in to confirm you're not a bot")
        assert ipc._bot_breaker_check() is not None
        ipc._bot_breaker_success()
        assert ipc._bot_breaker_check() is None
    finally:
        ipc._bot_breaker_success()


def test_dispatch_safely_contains_killer_command(monkeypatch):
    import ipc_main as ipc
    def boom(_cmd):
        raise OSError("disk full")
    monkeypatch.setattr(ipc, "_handle_command", boom)
    ipc._dispatch_safely({"cmd": "download", "id": "x"})  # must not raise