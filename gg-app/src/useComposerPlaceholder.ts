import { useCallback, useEffect, useRef, useState } from "react";
import { useFlavorEnabled } from "./flavor";

export const DEFAULT_INPUT_PLACEHOLDER = "Type a message, / commands, @ files, @Israel for help";
const PLAIN_INPUT_PLACEHOLDERS = [
  DEFAULT_INPUT_PLACEHOLDER,
  "Need a second opinion? Ask @Israel",
  "Start with ! to run a command, like !git status",
  "Stuck on what to do next? Ask @Israel",
  DEFAULT_INPUT_PLACEHOLDER,
  "Run tests yourself with !pnpm test, then ask Israel Code to fix them",
  "Want a second set of eyes? Ask @Israel",
  "Unsure how to proceed? Ask @Israel",
  "!ls runs in this project. Israel Code sees the output next message",
  "Need a quick review? Ask @Israel",
] as const;
// Same hints, said the Israeli way: every line still teaches /, @ or !.
const FUN_INPUT_PLACEHOLDERS = [
  "Nu? Type a message, / commands, @ files, @Israel for help",
  "Need a second opinion? Ask @Israel. You'll get three",
  "Start with ! to run a command, like !git status. Yalla",
  "Stuck? Ask @Israel. Asking is free, the advice is unsolicited anyway",
  DEFAULT_INPUT_PLACEHOLDER,
  "Run !pnpm test yourself, then let Israel Code fix the balagan",
  "Want someone to argue with your code? Ask @Israel",
  "Not sure how to proceed? Ask @Israel, it has an opinion",
  "!ls runs in this project. Israel Code sees the output next message",
  "Need a quick review? Ask @Israel. Mazel tov in advance",
] as const;
const PLAIN_RUNNING_INPUT_PLACEHOLDERS = [
  "Agent is working. Add a follow-up if you want",
  "Got another thought? Queue it here",
  "Run a command while you wait, like !git diff",
  "Agent is on it. You can stack the next note",
  "Thinking ahead? Drop the next instruction",
  "Keep going. Your next message will queue up",
  "Check something yourself with !, it won't interrupt Israel Code",
] as const;
const FUN_RUNNING_INPUT_PLACEHOLDERS = [
  "Agent is working. Add a follow-up, it can multitask like a Tel Aviv waiter",
  "Got another thought? Queue it here. Sababa",
  "Run a command while you wait, like !git diff",
  "Agent is on it. Stack the next note, no need to shout",
  "Thinking ahead? Drop the next instruction, it queues up",
  "Keep going. Your next message waits its turn (a rare thing here)",
  "Check something yourself with !, it won't interrupt Israel Code",
] as const;
const INPUT_PLACEHOLDER_INTERVAL_MS = 12_000;
const PLACEHOLDER_SHUFFLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PLACEHOLDER_SHUFFLE_FRAMES = 18;
const PLACEHOLDER_SHUFFLE_FRAME_MS = 24;

function shufflePlaceholderFrame(target: string, frame: number): string {
  const revealCount = Math.ceil((target.length * frame) / PLACEHOLDER_SHUFFLE_FRAMES);
  return Array.from(target, (char, index) => {
    if (index < revealCount || /\s|[.,?/@!]/.test(char)) return char;
    const pick = Math.floor(Math.random() * PLACEHOLDER_SHUFFLE_CHARS.length);
    return PLACEHOLDER_SHUFFLE_CHARS[pick];
  }).join("");
}

/**
 * The composer's rotating hint: cycles through the idle or running pool while
 * the composer is focused, visible and empty, and decodes each new line in
 * with a short character shuffle. Extracted from App.tsx.
 */
export function useComposerPlaceholder(animatePlaceholder: boolean, running: boolean): string {
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [displayPlaceholder, setDisplayPlaceholder] = useState(DEFAULT_INPUT_PLACEHOLDER);
  const displayPlaceholderRef = useRef(DEFAULT_INPUT_PLACEHOLDER);
  const funCopy = useFlavorEnabled();
  const placeholderPool = running
    ? funCopy
      ? FUN_RUNNING_INPUT_PLACEHOLDERS
      : PLAIN_RUNNING_INPUT_PLACEHOLDERS
    : funCopy
      ? FUN_INPUT_PLACEHOLDERS
      : PLAIN_INPUT_PLACEHOLDERS;
  const inputPlaceholder = placeholderPool[placeholderIndex % placeholderPool.length]!;
  const setAnimatedPlaceholder = useCallback((text: string) => {
    displayPlaceholderRef.current = text;
    setDisplayPlaceholder(text);
  }, []);
  useEffect(() => {
    if (!animatePlaceholder) return;
    const id = window.setInterval(() => {
      setPlaceholderIndex((i) => i + 1);
    }, INPUT_PLACEHOLDER_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [animatePlaceholder]);
  useEffect(() => {
    if (!animatePlaceholder) {
      setAnimatedPlaceholder(inputPlaceholder);
      return;
    }
    if (displayPlaceholderRef.current === inputPlaceholder) return;

    let frame = 0;
    const id = window.setInterval(() => {
      frame += 1;
      const text =
        frame >= PLACEHOLDER_SHUFFLE_FRAMES
          ? inputPlaceholder
          : shufflePlaceholderFrame(inputPlaceholder, frame);
      setAnimatedPlaceholder(text);
      if (frame >= PLACEHOLDER_SHUFFLE_FRAMES) window.clearInterval(id);
    }, PLACEHOLDER_SHUFFLE_FRAME_MS);
    return () => window.clearInterval(id);
  }, [animatePlaceholder, inputPlaceholder, setAnimatedPlaceholder]);
  return displayPlaceholder;
}
