import { createContext } from "react";

/** Click handler for "Send to GG Coder" prompt blocks (see `Markdown.tsx`).
 *  Lives apart from Markdown so the transcript can provide it without pulling
 *  the markdown renderer into the start-up bundle. */
export const PromptSendContext = createContext<((text: string) => Promise<boolean>) | null>(null);

/** Provider for the "Send to GG Coder" click handler. App wraps the transcript
 *  with this so prompt-block buttons push a transcript row + send. */
export const PromptSendProvider = PromptSendContext.Provider;
