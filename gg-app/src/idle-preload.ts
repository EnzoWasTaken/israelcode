/**
 * Run `task` once the window is idle after first paint (a lazy chunk preload),
 * so start-up never pays for it but a first open rarely waits. Returns a
 * cancel function for effect cleanup.
 */
export function whenIdle(task: () => void, timeout = 2000): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(task, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(task, 200);
  return () => window.clearTimeout(id);
}
