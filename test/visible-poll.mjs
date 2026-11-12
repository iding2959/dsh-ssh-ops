import assert from "node:assert/strict";
import { isDocumentVisible, startVisiblePoll } from "../src/client/visible-poll.js";

// ── document visibility is read from both spellings ────────────────────────
{
  assert.equal(isDocumentVisible(undefined), true, "no document (Node/tests) means visible");
  assert.equal(isDocumentVisible({ visibilityState: "visible", hidden: false }), true);
  assert.equal(isDocumentVisible({ visibilityState: "hidden" }), false);
  // Older/lighter hosts expose only `hidden`.
  assert.equal(isDocumentVisible({ hidden: true }), false);
}

// A controllable timer target standing in for the browser global.
function fakeTimers() {
  const listeners = new Set();
  let tick;
  let cleared = false;
  return {
    document: {
      visibilityState: "visible",
      addEventListener: (type, fn) => { if (type === "visibilitychange") listeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === "visibilitychange") listeners.delete(fn); }
    },
    setInterval: (callback, ms) => { tick = callback; assert.equal(ms > 0, true); return 11; },
    clearInterval: (id) => { assert.equal(id, 11); cleared = true; },
    get tick() { return tick; },
    get cleared() { return cleared; },
    get listenerCount() { return listeners.size; },
    fire() { for (const fn of listeners) fn(); }
  };
}

// ── visible loop polls; hidden loop spends nothing ─────────────────────────
{
  const timers = fakeTimers();
  let calls = 0;
  const stop = startVisiblePoll(async () => { calls += 1; }, { intervalMs: 1000, timers, immediate: false });
  await timers.tick();
  assert.equal(calls, 1, "a visible loop polls");

  timers.document.visibilityState = "hidden";
  await timers.tick();
  await timers.tick();
  assert.equal(calls, 1, "a hidden loop issues no requests");

  // Becoming visible again wakes the loop immediately, without waiting a tick.
  timers.document.visibilityState = "visible";
  timers.fire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2, "returning to visibility refreshes right away");

  stop();
  assert.equal(timers.cleared, true, "disposer clears the interval");
  assert.equal(timers.listenerCount, 0, "disposer removes the visibility listener");
}

// ── an in-app predicate hides the loop without any browser event ───────────
{
  const timers = fakeTimers();
  let calls = 0;
  let mounted = false;
  const stop = startVisiblePoll(async () => { calls += 1; }, {
    intervalMs: 1000, timers, immediate: false, isVisible: () => mounted
  });
  await timers.tick();
  assert.equal(calls, 0, "an unmounted pane does not poll even while the document is visible");
  mounted = true;
  await timers.tick();
  assert.equal(calls, 1);
  stop();
}

// ── overlapping runs are skipped, not queued ───────────────────────────────
{
  const timers = fakeTimers();
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stop = startVisiblePoll(async () => { started += 1; await gate; }, { intervalMs: 1000, timers, immediate: false });
  void timers.tick();
  void timers.tick();
  void timers.tick();
  assert.equal(started, 1, "a slow poll is not re-entered");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await timers.tick();
  assert.equal(started, 2, "the loop resumes after the slow poll settles");
  stop();
}

// ── a failing poll keeps the loop alive ────────────────────────────────────
{
  const timers = fakeTimers();
  let attempts = 0;
  const stop = startVisiblePoll(async () => { attempts += 1; throw new Error("host down"); }, {
    intervalMs: 1000, timers, immediate: false
  });
  await timers.tick();
  await timers.tick();
  assert.equal(attempts, 2, "a transient failure does not stop later polls");
  stop();
}

console.log("visible poll: hidden loops spend nothing, in-app gates work, slow polls do not stack");