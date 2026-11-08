import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { createChatLayoutMotion } from "./chat-layout-motion";
import { autosizeComposer } from "./composer-autosize";

/**
 * Auto-grow the composer textarea before paint, and again when its width
 * changes or fonts settle. Extracted from App.tsx; the sizing rules live in
 * composer-autosize.ts.
 */
export function useComposerAutosize({
  chatLayout,
  inputRef,
  scrollRef,
  stickToBottomRef,
  input,
  enhanceAnim,
}: {
  chatLayout: ReturnType<typeof createChatLayoutMotion>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: RefObject<boolean>;
  input: string;
  enhanceAnim: unknown;
}) {
  // Auto-grow the chat textarea, keeping the transcript's scroll position
  // intact across the measurement (see composer-autosize.ts for why both
  // halves matter).
  const autosizeInput = useCallback(() => {
    chatLayout.settle();
    autosizeComposer(inputRef.current, scrollRef.current, stickToBottomRef.current);
  }, [chatLayout, stickToBottomRef, inputRef, scrollRef]);

  // useLayoutEffect (not useEffect) so the height is recomputed BEFORE the
  // browser paints. This matters most when the enhance animation tears down and
  // hands its multi-line text back to the textarea: with a post-paint effect the
  // textarea would flash at its default height for one frame, then resize — a
  // visible layout shift. Sizing pre-paint makes the handoff seamless.
  //
  // enhanceAnim is a dependency because the textarea is position:absolute during
  // the animation (stretched to the overlay's height), so a measurement taken
  // then is wrong; re-running once it clears sizes the now-in-flow textarea.
  useLayoutEffect(() => {
    autosizeInput();
  }, [input, enhanceAnim, autosizeInput]);

  // The height is only recomputed when `input` changes, so anything else that
  // re-wraps the draft leaves it stale until the next keystroke — the input
  // sitting at the wrong height and then settling as you type.
  //
  // Width is the recurring one: Cmd +/- zoom, a window resize, a sibling bar
  // appearing. Stale is worse than a jump here — overflow is pinned hidden below
  // the cap, so re-wrapped lines are clipped rather than scrollable. Only width
  // is acted on; reacting to height would feed our own resize back in as a loop.
  // Attached via a callback ref because the composer unmounts whenever a
  // picker/home view takes over the window.
  //
  // The resize runs on the next frame, not inside the callback: autosizing
  // changes this same textarea's height (and width, via is-multiline), and
  // resizing an observed element from its own callback leaves a notification
  // undelivered, which WebKit reports as "ResizeObserver loop completed with
  // undelivered notifications" on every send.
  const inputRoRef = useRef<{ observer: ResizeObserver; cancel: () => void } | null>(null);
  const attachInput = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inputRef.current = el;
      // Turn off macOS inline predictive text in the composer. WebKit lays the
      // grey suggested words out INSIDE the textarea, so a suggestion that runs
      // past the line end adds a wrapped line to scrollHeight; the next
      // keystroke's autosize grows the box to fit it, and the box drops back the
      // moment the suggestion is dismissed. That is the composer "randomly
      // growing a line and going back" while typing. WKWebView shows these by
      // default and the configuration switch is unreliable, so use the HTML
      // attribute (WebKit 18+). Not in React's DOM types, hence setAttribute.
      el?.setAttribute("writingsuggestions", "false");
      inputRoRef.current?.observer.disconnect();
      inputRoRef.current?.cancel();
      inputRoRef.current = null;
      if (!el || typeof ResizeObserver === "undefined") return;
      let lastWidth = el.clientWidth;
      let frame = 0;
      const ro = new ResizeObserver(() => {
        const width = el.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          autosizeInput();
        });
      });
      ro.observe(el);
      inputRoRef.current = { observer: ro, cancel: () => cancelAnimationFrame(frame) };
    },
    [autosizeInput, inputRef],
  );

  // Re-measure once font metrics are settled: an early draft (a restored one,
  // or fast typing right at launch) can be measured before the final face is
  // resolved, wrapping a line further and leaving the box a line too tall.
  // `ready` specifically: WebKit never dispatches `loadingdone`, so a listener
  // there would be dead code.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) autosizeInput();
    });
    return () => {
      cancelled = true;
    };
  }, [autosizeInput]);

  return { autosizeInput, attachInput };
}
