import { useSyncExternalStore } from "react";
import type { CommandSection } from "./command-registry";

/**
 * Which keyboard surface is open in this window: the palette (optionally
 * narrowed to some sections), the shortcuts sheet, or neither. A tiny store
 * so any control (the composer hint, a menu) can open them.
 */
export type CommandSurface =
  { kind: "palette"; sections?: readonly CommandSection[] } | { kind: "shortcuts" } | null;

let surface: CommandSurface = null;
const listeners = new Set<() => void>();

function set(next: CommandSurface): void {
  surface = next;
  for (const listener of listeners) listener();
}

export function openPalette(sections?: readonly CommandSection[]): void {
  set({ kind: "palette", sections });
}
export function openShortcuts(): void {
  set({ kind: "shortcuts" });
}
export function closeCommandSurface(): void {
  set(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommandSurface(): CommandSurface {
  return useSyncExternalStore(subscribe, () => surface);
}
