/**
 * Visibility-aware polling for the client's data loops.
 *
 * Every poller in this plugin talks to the host over the toolbar's RPC channel.
 * Browsers throttle `setInterval` for background *tabs*, but none of that helps
 * here: the SSH pane lives inside the app's own layout, so switching to another
 * chat or collapsing the sidebar leaves `document.hidden === false` and every
 * loop keeps its full cadence — measured 3.07 requests/second with all panes
 * open, all of it spent refreshing data nobody can see.
 *
 * The guard is two-level:
 *  - `document.visibilityState` covers a backgrounded browser tab or window;
 *  - an optional `isVisible()` covers the in-app case (pane not mounted, tab not
 *    the active one), which the browser cannot know about.
 *
 * A hidden loop skips its work entirely instead of queueing it, and runs once
 * shortly after it becomes visible again so the pane is current on return.
 */
export function isDocumentVisible(doc = globalThis.document) {
  // No document (Node tests, non-DOM host): nothing to hide behind.
  if (doc === undefined || doc === null) return true;
  return doc.visibilityState !== "hidden" && doc.hidden !== true;
}

/**
 * Run `task` on an interval, but only while visible.
 *
 * @param task - async work; overlapping runs are skipped, not queued.
 * @param options.intervalMs - cadence while visible.
 * @param options.isVisible - extra in-app visibility predicate.
 * @param options.refreshOnShow - run once when visibility returns (default true).
 * @param options.immediate - run once right away (default true); pass false when
 *   the caller already performs the first fetch itself.
 * @param options.timers - interval/event target, injectable for tests.
 * @returns a disposer that stops the loop and removes its listeners.
 */
export function startVisiblePoll(task, {
  intervalMs,
  isVisible = () => true,
  refreshOnShow = true,
  immediate = true,
  timers = globalThis,
} = {}) {
  let stopped = false;
  let running = false;
  let wasVisible = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await task();
    } catch {
      // A failed poll must not end the loop; the next tick retries.
    } finally {
      running = false;
    }
  };

  const tick = () => {
    if (stopped) return;
    if (!isDocumentVisible(timers.document) || !isVisible()) {
      wasVisible = false;
      return;
    }
    // Returning from hidden: refresh immediately so the pane is not stale for
    // up to a full interval after the user comes back.
    if (refreshOnShow && !wasVisible) wasVisible = true;
    void run();
  };

  const timer = timers.setInterval(tick, intervalMs);
  // A backgrounded tab gets no interval ticks at all in some browsers, so the
  // transition itself must wake the loop rather than waiting for the next tick.
  const onVisibility = () => {
    if (isDocumentVisible(timers.document) && isVisible()) {
      wasVisible = true;
      void run();
    }
  };
  timers.document?.addEventListener?.("visibilitychange", onVisibility);

  // A pane that just mounted is visible by definition; callers that fetch on
  // mount themselves pass `immediate: false` to avoid a duplicate request.
  if (immediate) void run();

  return () => {
    stopped = true;
    timers.clearInterval(timer);
    timers.document?.removeEventListener?.("visibilitychange", onVisibility);
  };
}