import { useLayoutEffect, type RefObject } from "react";
import type { createChatLayoutMotion } from "./chat-layout-motion";
import { isHiddenScroller } from "./transcript-pin";

/**
 * Commit side of the send/tool layout transaction (chat-layout-motion.ts):
 * runs after every render, once history anchoring and composer autosizing
 * have landed. Extracted from App.tsx.
 */
export function useChatLayoutCommit({
  chatLayout,
  needsProject,
  scrollRef,
  stickToBottomRef,
  lastScrollTopRef,
  scrollToBottom,
  hydrateNonce,
}: {
  chatLayout: ReturnType<typeof createChatLayoutMotion>;
  needsProject: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: RefObject<boolean>;
  lastScrollTopRef: RefObject<number>;
  scrollToBottom: () => void;
  hydrateNonce: number;
}): void {
  // History anchoring and autosizing have landed. Commit the final scroll
  // position before paint; only the displayed positions move, never scrollTop.
  useLayoutEffect(() => {
    // Nothing to commit while the transcript is hidden behind another view
    // (a goal's Workers): it has no size, so any offset taken now is wrong.
    if (needsProject || (scrollRef.current !== null && isHiddenScroller(scrollRef.current))) {
      chatLayout.cancel();
      return;
    }
    if (chatLayout.commit(stickToBottomRef.current, scrollToBottom) && scrollRef.current) {
      lastScrollTopRef.current = scrollRef.current.scrollTop;
    }
  });
  useLayoutEffect(() => () => chatLayout.cancel(), [chatLayout, hydrateNonce]);
}
