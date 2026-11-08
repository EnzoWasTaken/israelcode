import { useEffect } from "react";

/**
 * The first message typed on Home's quick start, waiting for the session it
 * opened. Home queues it once the window has been pointed at the new session;
 * App takes it when that session's hydrate settles and sends it through the
 * composer's own send path, so it lands as an ordinary user message. Taking it
 * clears it, so it is sent at most once.
 */
let pending: string | null = null;

export function queueFirstPrompt(text: string): void {
  pending = text.trim() || null;
}

export function takeFirstPrompt(): string | null {
  const text = pending;
  pending = null;
  return text;
}

/** One finished hydrate: `ok` when the session is ready to take a message. */
export interface HydrateSettled {
  ok: boolean;
}

/**
 * Send a queued first prompt once `settled` reports a ready session. A failed
 * hydrate (or a send that's refused) puts the text back in the composer, so
 * nothing typed is lost.
 */
export function useFirstPrompt(
  settled: HydrateSettled | null,
  send: (text: string) => boolean,
  restore: (text: string) => void,
): void {
  useEffect(() => {
    if (!settled) return;
    const text = takeFirstPrompt();
    if (!text) return;
    if (!settled.ok || !send(text)) restore(text);
    // Only a new settle (a new object) may consume the prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
}
