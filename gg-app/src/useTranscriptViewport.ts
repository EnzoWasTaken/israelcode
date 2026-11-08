import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { createChatLayoutMotion } from "./chat-layout-motion";
import { nextDockHeight } from "./dock-height";
import type { LiveToolEntry } from "./LiveToolPanel";
import type { Item } from "./transcript-item";
import { dissolveInVisible } from "./transcript-motion";

/**
 * Keeps a pinned transcript at the bottom while the chrome around it changes:
 * the pre-paint re-pin, the viewport and dock resize observers (--dock-h), and
 * the settle after a session hydrates. Scroll intent itself stays with
 * transcript-pin.ts / useTranscriptScroll. Extracted from App.tsx.
 */
export function useTranscriptViewport({
  items,
  windowStart,
  liveToolFeed,
  running,
  doneStatus,
  queuedCount,
  hydrated,
  hydrateNonce,
  scrollRef,
  chatLayout,
  lastScrollTopRef,
  noteTranscriptViewport,
  maybeScrollToBottom,
}: {
  items: Item[];
  windowStart: number;
  liveToolFeed: LiveToolEntry[];
  running: boolean;
  doneStatus: string | null;
  queuedCount: number;
  hydrated: boolean;
  hydrateNonce: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  chatLayout: ReturnType<typeof createChatLayoutMotion>;
  lastScrollTopRef: RefObject<number>;
  noteTranscriptViewport: (el: HTMLDivElement) => void;
  maybeScrollToBottom: () => void;
}) {
  // Re-pin to the bottom before every paint — but only while pinned. The live
  // tool panel + activity bar (.liveregion) grow/shrink below the transcript as
  // tools run and finish; since the transcript is a flexible sibling, that
  // growth steals height from it and would leave the newest content (often the
  // just-sent user prompt) scrolled under the fold. Keying this layout effect on
  // the live-region's height inputs (tool feed, run state, done status) AND
  // `items` re-pins synchronously after layout but before paint, so the prompt
  // is never hidden. useLayoutEffect runs before paint, so this pass never
  // flashes; animated chrome growth is caught by the ResizeObserver below. The
  // stick-to-bottom gate keeps it from yanking the view away while the user is
  // scrolled up reading mid-stream.
  useLayoutEffect(() => {
    maybeScrollToBottom();
  }, [items, windowStart, liveToolFeed, running, doneStatus, queuedCount, maybeScrollToBottom]);

  // …and keep re-pinning while the chrome below the transcript ANIMATES its
  // height. The queued-message strip (`.queued-bar`) slides open over 260ms, the
  // attachment / referenced-file bars and the live tool panel do the same; every
  // frame of that animation steals a few more pixels from the transcript AFTER
  // the layout effect above has already run, which is why a just-queued user
  // bubble ends up sliding under the composer while a normal send (no strip, no
  // height animation) looks fine. A ResizeObserver on the transcript viewport
  // fires on each of those frames, so the newest row stays visible for the whole
  // transition. It complements the layout effect rather than replacing it: an RO
  // only fires when the VIEWPORT resizes, so content growth (streaming tokens,
  // images) still needs the effect above. Shrinking the viewport never fires a
  // scroll event (scrollTop stays valid), so the stick-to-bottom pin survives and
  // a user scrolled up reading is still left alone.
  //
  // Attached through a callback ref, not an effect on `scrollRef.current`: the
  // transcript unmounts whenever a picker/home view takes over the window, and a
  // mount-time effect would observe a stale (or null) node after it comes back.
  const transcriptRoRef = useRef<ResizeObserver | null>(null);
  const attachTranscript = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      if (el) {
        lastScrollTopRef.current = el.scrollTop;
        noteTranscriptViewport(el);
      }
      transcriptRoRef.current?.disconnect();
      transcriptRoRef.current = null;
      if (!el || typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(() => {
        // Record the new size here too: a resize with no scroll event would
        // otherwise make the reader's next scroll read as layout.
        noteTranscriptViewport(el);
        if (chatLayout.resized()) maybeScrollToBottom();
      });
      ro.observe(el);
      transcriptRoRef.current = ro;
    },
    [maybeScrollToBottom, chatLayout, lastScrollTopRef, noteTranscriptViewport, scrollRef],
  );

  // The dock floats over the conversation's bottom edge, so the transcript
  // doesn't shrink when it grows (a wrapping draft, a panel opening). Its
  // height goes to the frame as --dock-h, which the transcript reserves as
  // bottom padding; a pinned chat then follows the bottom in the same frame,
  // so the newest message is never left behind the dock.
  //
  // A callback ref, like the transcript's: the dock unmounts whenever a picker
  // takes over the window, and must be observed afresh when it comes back.
  const transcriptFrameRef = useRef<HTMLDivElement>(null);
  const dockElRef = useRef<HTMLDivElement | null>(null);
  const dockRoRef = useRef<ResizeObserver | null>(null);
  const dockRef = useCallback(
    (dock: HTMLDivElement | null) => {
      dockRoRef.current?.disconnect();
      dockRoRef.current = null;
      dockElRef.current = dock;
      if (!dock) return;
      const apply = (): void => {
        const frame = transcriptFrameRef.current;
        if (!frame) return;
        const height = nextDockHeight(dock, frame.style.getPropertyValue("--dock-h"));
        if (height === null) return;
        frame.style.setProperty("--dock-h", height);
        maybeScrollToBottom();
      };
      apply();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(apply);
      observer.observe(dock);
      dockRoRef.current = observer;
    },
    [maybeScrollToBottom],
  );

  // Settle the scroll position after a session hydrates. The single layout-effect
  // scroll above runs the instant `items` is set, but the transcript keeps
  // growing afterward — web fonts swap in (FOUT reflows text taller), code blocks
  // and markdown finish laying out — which leaves the view pinned a little above
  // the true bottom. Re-pin across the next two frames and once fonts are ready,
  // gated on stick-to-bottom so it never yanks the view if the user scrolled up.
  useEffect(() => {
    if (!hydrated) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      maybeScrollToBottom();
      // After the first pin, so the rows that dissolve are the ones in view.
      if (scrollRef.current) dissolveInVisible(scrollRef.current);
      raf2 = requestAnimationFrame(maybeScrollToBottom);
    });
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) maybeScrollToBottom();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [hydrated, hydrateNonce, maybeScrollToBottom, scrollRef]);

  return { attachTranscript, transcriptFrameRef, dockElRef, dockRef };
}
