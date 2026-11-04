# Stability + Error Handling + Bot Bypass + Rate Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the four areas without breaking the uncommitted in-flight work, in the smallest correct diffs with a failing-then-passing test per change.

**Architecture:** No new tiers, deps, or protocols. Engine keeps fail-fast + breaker + cookie auth; server keeps per-route token buckets + bounded supervision; UI keeps guards + reconcile. Each task adds one missing guard or pins one in-flight behavior with a regression test.

**Tech Stack:** Python (yt-dlp opts, `threading`, pytest), Node ESM (Express 5, `ws`, `node:test`), React+Zustand (Vitest), NDJSON stdio protocol v1.

**Spec:** This plan is the spec (user request 2026-10-11: "improve stability and error handling and bot bypass and rate limit, before modifying the code, you check twice"). Checked twice: Pass 1 full reads of `python-engine/engine.py`, `python-engine/ipc_main.py`, `web/middleware/security.mjs`, `web/services/engineManager.mjs`, `web/routes/download.mjs`; Pass 2 re-reads of `engine.py:150-270/1610-1740`, `engineManager.mjs:324-474`, `web/routes/probe.mjs`, `web/validate.mjs` plus `git diff` review.

## Global Constraints

- Worktree is DIRTY (22 files, incl. `python-engine/engine.py`, `python-engine/ipc_main.py`, `web/services/engineManager.mjs`, `web/routes/status.mjs`, `src/hooks/useEngineEvents.ts`, `src/stores/downloadStore.ts`, `src/App.tsx` + `docs/codebase/*` from the prior analysis session). Never `git stash`, `git checkout --`, or overwrite these; build on top.
- Backend stays plain ESM `.mjs`, no TypeScript, no new runtime deps unless a task says so.
- Frontend TS `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` must stay green (`npx tsc --noEmit`).
- Cookie CONTENTS never logged, never on the wire (source-only `cookies: {configured, source}` and `bot_breaker: {open, consecutive_failures, cooldown_seconds}` shapes are frozen).
- YouTube-only URL allowlist lives in `web/validate.mjs` + `src/components/urlRegex.ts` parity pair — change both + `src/urlRegex.test.ts` fixtures together or not at all.
- Every behavior change ships a failing-first regression test; never weaken a valid test to make code pass.
- Do not commit unless the user explicitly asks (repo AGENTS.md rule).

---

## File map

- Modify: `python-engine/engine.py` (breaker-adjacent classification, cookie cache, probe/download opts) — Tasks 2, 3.
- Modify: `python-engine/tests/test_engine.py` — new pins — Tasks 2, 3.
- Modify: `python-engine/ipc_main.py` + `python-engine/tests/test_ipc.py` — breaker + dispatch guards — Task 4.
- Modify: `web/services/engineManager.mjs` + `web/tests/engineManager.test.mjs` — write-path guards — Task 5.
- Modify: `web/middleware/security.mjs` + `web/tests/cancelRateLimit.test.mjs` (+ new `web/tests/rateLimit.test.mjs`) — limiter pins — Task 6.
- Modify: `web/routes/status.mjs` + `web/tests/status.test.mjs`, `src/App.tsx`, `src/hooks/useEngineEvents.ts` — observability wiring — Task 7 (verify-first, smallest gap only).
- Docs: update `docs/codebase/CONCERNS.md` + `docs/roadmap.md` only when a gap actually closes.

---

### Task 1: Lock the baseline (no code changes)

**Files:**
- Modify: none (read-only)

**Interfaces:**
- Consumes: dirty worktree described above
- Produces: recorded baseline (test counts + `git status --short` snapshot) that later tasks compare against

- [ ] **Step 1: Record worktree snapshot**

Run: `git status --short > C:\Users\Nishanth\AppData\Local\Temp\opencode\baseline-status.txt && git diff --stat | tail -5`
Expected: 22 modified files; engine/ipc/engineManager/status/store/hook/App present. Save the output — if a later task's `git status` shows unexpected files, STOP.

- [ ] **Step 2: Run frontend baseline**

Run: `npm test 2>&1 | tail -4`
Expected: PASS, 11 files / 73 tests (plus any new in-flight tests — record the actual numbers, do not "fix" them to 73).

- [ ] **Step 3: Run backend baseline**

Run: `cd web && node --test tests/*.test.mjs 2>&1 | tail -8`
Expected: PASS (14 suites). Record actual pass/fail counts.

- [ ] **Step 4: Run engine baseline**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest python-engine/tests -q 2>&1 | tail -3`
Expected: PASS (79 collected + in-flight additions). Record actual numbers. Do not edit code in this task.

---

### Task 2: Pin bot-classifier boundary (age-gate vs bot-check, transient 429 retryable)

**Files:**
- Modify: `python-engine/tests/test_engine.py` (append)
- Test: same file (new tests are the deliverable; `python-engine/engine.py` already carries the narrowed `is_bot_detection_error` in-flight — this task ADDS NO production code unless a test fails)

**Interfaces:**
- Consumes: `is_bot_detection_error(msg: str) -> bool` from `python-engine/engine.py:240`
- Produces: pinned boundary future edits cannot silently shift

- [ ] **Step 1: Write the failing-first tests**

```python
def test_bot_classifier_excludes_age_gate():
    from engine import is_bot_detection_error
    assert is_bot_detection_error("Sign in to confirm your age to watch this video") is False
    assert is_bot_detection_error("Please confirm your age") is False

def test_bot_classifier_keeps_ip_check():
    from engine import is_bot_detection_error
    assert is_bot_detection_error("Sign in to confirm you're not a bot") is True
    assert is_bot_detection_error("HTTP Error 429: Too Many Requests") is True

def test_transient_rate_limit_stays_retryable():
    from engine import RetryStrategy
    r = RetryStrategy(max_retries=3, initial_delay=0.01)
    assert r.should_retry(RuntimeError("temporary rate limited, retry later")) is True
```

- [ ] **Step 2: Run to verify against in-flight code**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest python-engine/tests/test_engine.py -q -k "bot_classifier or transient_rate_limit" 2>&1 | tail -3`
Expected: PASS (in-flight code already implements it — these are pure pins). If any FAILs, the in-flight classifier regressed: fix `is_bot_detection_error`/`should_retry` minimally (one indicator string or one exclusion clause), never by deleting the new test.

- [ ] **Step 3: Run full engine suite**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest python-engine/tests -q 2>&1 | tail -3`
Expected: PASS, no count drop vs Task 1 baseline.

---

### Task 3: Verify cookie-auth wiring end-to-end (probe + download carry cookie opts)

**Files:**
- Modify: `python-engine/tests/test_engine.py` (append)
- Test: same file

**Interfaces:**
- Consumes: `AudioDownloadEngine._find_cookies()`, `_build_opts()`, `probe()` opts at `engine.py:1621-1640`
- Produces: proof cookies reach yt-dlp in both paths (or a precise failure naming the path that drops them)

- [ ] **Step 1: Write the wiring tests**

```python
def test_cookie_opts_reach_download_opts(tmp_path, monkeypatch):
    import engine as eng_mod
    jar = tmp_path / "cookies.txt"
    jar.write_text("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n")
    monkeypatch.setenv("YTDL_COOKIES_FILE", str(jar))
    eng_mod.AudioDownloadEngine._reset_cookies_cache()
    try:
        eng = eng_mod.AudioDownloadEngine(output_dir=str(tmp_path))
        assert eng._build_opts().get("cookiefile") == str(jar)
    finally:
        eng_mod.AudioDownloadEngine._reset_cookies_cache()
        monkeypatch.delenv("YTDL_COOKIES_FILE", raising=False)
```

- [ ] **Step 2: Run**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest python-engine/tests/test_engine.py -q -k "cookie_opts_reach" 2>&1 | tail -3`
Expected: PASS. On FAIL, read the assertion diff: if `_build_opts` drops `**self._cookie_opts()` re-add that single spread (one line); if probe opts drop it, re-add at `engine.py:1639`. No other edits.

- [ ] **Step 3: Confirm no secret leakage**

Run: `grep -rn "cookies" python-engine/engine.py | grep -iv "cookiefile\|cookiesfrombrowser\|configured\|source\|_find_cookies\|_cookie_opts\|cookie_status\|COOKIES" | head -5`
Expected: empty (only source/config names, never values). If a value-logging line appears, redact it in the same task.

---

### Task 4: Pin breaker + dispatch containment (ipc_main)

**Files:**
- Modify: `python-engine/tests/test_ipc.py` (append; create `test_ipc_guard.py` additions only if that file already exists — it does)
- Test: same files

**Interfaces:**
- Consumes: `_bot_breaker_check/_bot_breaker_failure/_bot_breaker_success/_dispatch_safely` from `python-engine/ipc_main.py`
- Produces: regression pins for cooldown short-circuit + dispatch-never-kills-loop

- [ ] **Step 1: Write breaker pin**

```python
def test_breaker_opens_after_three_bot_failures():
    import ipc_main as ipc
    ipc._BOT_BREAKER_FAILURES = 0
    ipc._BOT_BREAKER_OPEN_UNTIL = 0.0
    ipc._bot_breaker_failure("Sign in to confirm you're not a bot")
    ipc._bot_breaker_failure("Sign in to confirm you're not a bot")
    assert ipc._bot_breaker_check() is None
    ipc._bot_breaker_failure("Sign in to confirm you're not a bot")
    assert ipc._bot_breaker_check() is not None
    ipc._bot_breaker_success()
    assert ipc._bot_breaker_check() is None
```

- [ ] **Step 2: Write dispatch pin**

```python
def test_dispatch_safely_contains_killer_command(monkeypatch):
    import ipc_main as ipc
    def boom(_cmd):
        raise OSError("disk full")
    monkeypatch.setattr(ipc, "_handle_command", boom)
    ipc._dispatch_safely({"cmd": "download", "id": "x"})  # must not raise
```

- [ ] **Step 3: Run**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest python-engine/tests/test_ipc.py python-engine/tests/test_ipc_guard.py -q 2>&1 | tail -3`
Expected: PASS. Production code already implements both; on FAIL fix the single tripped threshold/guard, never the test.

---

### Task 5: Guard the Node write path (EPIPE / half-flush)

**Files:**
- Modify: `web/services/engineManager.mjs` (`_writeCommand`, `flushPending`)
- Test: `web/tests/engineManager.test.mjs` (append)

**Interfaces:**
- Consumes: `EngineManager.sendCommand/_writeCommand/flushPending`
- Produces: write failures requeue + terminal 503-safe behavior instead of thrown mid-flush

- [ ] **Step 1: Write the failing test**

```js
// append to web/tests/engineManager.test.mjs
test("flushPending survives a mid-flush write throw", () => {
  const m = freshManager();
  m.stdin = { destroyed: false, write: () => { throw new Error("EPIPE"); }, once: () => {} };
  m.pendingCommands = [{ cmd: "probe", id: "a", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }];
  assert.doesNotThrow(() => m.flushPending());
  assert.ok(m.pendingCommands.length >= 1, "failed command must be requeued, not dropped");
});
```

(`freshManager()` is the file's existing helper constructing `new EngineManager(fakeBus)` — reuse it verbatim; do not invent a second helper.)

- [ ] **Step 2: Run to confirm it fails**

Run: `node --test tests/engineManager.test.mjs 2>&1 | tail -6` (in `web/`)
Expected: FAIL (current `flushPending` has no try/catch — the throw propagates).

- [ ] **Step 3: Minimal implementation (only this)**

```js
flushPending() {
  if (!this.stdin || this.stdin.destroyed) return;
  const pending = this.pendingCommands;
  this.pendingCommands = [];
  for (const cmd of pending) {
    try {
      this._writeCommand(cmd);
    } catch {
      this.pendingCommands.push(cmd);
      break; // pipe is dead — stop, keep order, wait for respawn
    }
  }
}
```

And wrap the raw `this.stdin.write` in `_writeCommand` the same way (try/catch → push + return). Nothing else in this task.

- [ ] **Step 4: Re-run**

Run: `node --test tests/engineManager.test.mjs 2>&1 | tail -6`
Expected: PASS, zero regressions in the file.

---

### Task 6: Pin rate-limit budgets + Retry-After (no tuning yet)

**Files:**
- Modify: `web/tests/rateLimit.test.mjs` (create, model on `web/tests/cancelRateLimit.test.mjs` lines 1-45)
- Test: same file

**Interfaces:**
- Consumes: `rateLimit()` from `web/middleware/security.mjs`, budgets in `web/server.mjs:99-104`
- Produces: locked budgets — any future tuning must update test + server together

- [ ] **Step 1: Write the budget test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { rateLimit } from "../middleware/security.mjs";

function appWith(limit) {
  const app = express();
  app.use("/r", rateLimit(limit), (_req, res) => res.json({ ok: true }));
  return app;
}

test("budgets: probe 10/10s, download 5/10s, restart 5/10s, cancel 21/10s", async () => {
  const cases = [
    ["/r", { maxRequests: 10, windowMs: 10_000 }, 10],
    ["/r", { maxRequests: 5, windowMs: 10_000 }, 5],
    ["/r", { maxRequests: 21, windowMs: 10_000 }, 21],
  ];
  for (const [, limit, budget] of cases) {
    const app = appWith(limit);
    const srv = app.listen(0);
    await new Promise((r) => srv.on("listening", r));
    const port = srv.address().port;
    let limitedAt = -1;
    for (let i = 0; i < budget + 1; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/r`, { method: "POST" });
      if (res.status === 429) { limitedAt = i; break; }
    }
    srv.close();
    assert.strictEqual(limitedAt, budget, `budget ${budget} must trip exactly after ${budget} passes`);
  }
});
```

- [ ] **Step 2: Run**

Run: `node --test tests/rateLimit.test.mjs 2>&1 | tail -6` (in `web/`)
Expected: PASS (pins current behavior; if FAIL, the limiter — not the test — drifted: inspect `security.mjs:39-53`).

- [ ] **Step 3: Verify Retry-After preserved**

Assert in the same file: first 429 response carries a numeric `retry-after` header. (Header already set at `security.mjs:49` — this is a pin, not a feature.)

---

### Task 7: Close the smallest observability gap only (verify-first)

**Files:**
- Modify: only the single smallest failing gap found below; default is docs-only
- Test: colocated suite for whichever file changes

**Interfaces:**
- Consumes: `GET /api/status` shape (`tools`, `cookies`, `bot_breaker`, `pendingCommands`, `activeJobs`), `useEngineEvents` guards, `App.tsx` banner
- Produces: one closed gap or a written verdict of "no gap"

- [ ] **Step 1: Verify in-flight status shape live**

Run server locally (`npm run server` in one shell, then `curl -s http://127.0.0.1:3000/api/status`), confirm keys `tools`, `cookies`, `bot_breaker`, `pendingCommands`, `activeJobs` all present.
Expected: present (in-flight diff already adds them). If any key is missing, that — and only that — is this task's code change, plus one assertion in `web/tests/status.test.mjs` pinning the key.

- [ ] **Step 2: Verify UI cooldown path**

With no cookies configured, trigger 3 rapid bad probes if safe, or inspect `src/App.tsx` diff: the bot-cooldown banner must read `bot_breaker` from status, never cookie values.
Expected: banner shows countdown + cookie hint, no secret text. If banner is absent, add ONLY the banner (reuse existing `stat-card`/`tag-*` classes, `lucide-react` icon), with one `App.test.tsx`-style assertion. No redesign.

- [ ] **Step 3: Full verification**

Run: `npm test 2>&1 | tail -3` (root) then `node --test tests/*.test.mjs 2>&1 | tail -5` (in `web/`) then engine pytest `-q | tail -2`, plus `npm run lint` and `npx tsc --noEmit`.
Expected: all green; any red must be bisected to its task (`git diff --stat` per task) before proceeding.

---

## Self-review (run before handoff)

1. Spec coverage: stability (Tasks 1, 5), error handling (Tasks 4, 5, 7), bot bypass (Tasks 2, 3, 4, 7), rate limit (Task 6). No spec line left without a task.
2. Placeholder scan: every step carries exact file paths, runnable commands with expected output, and real code — no TBD/TODO/"appropriate handling".
3. Type consistency: `bot_breaker: {open, consecutive_failures, cooldown_seconds} | null`, `cookies: {configured, source} | null` used identically in Tasks 4/7; `requestJobs() → jobs[]` vs `requestJobsFull() → {jobs, bot_breaker}` kept distinct per the in-flight diff.

## Validation gate (per AGENTS.md + repo policy)

`npm run build`, `npm run lint`, `npx tsc --noEmit`, root `npm test`, `web` `node --test`, engine `pytest`; `git status` shows only intended files; no secrets; no unrelated refactors. Pre-existing failures get reported, not silently absorbed.
