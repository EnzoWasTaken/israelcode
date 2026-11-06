import { useSyncExternalStore } from "react";

/**
 * Israel Code's tongue-in-cheek voice: the jokes in placeholders, status
 * labels, tips and toasts. One switch (Settings → Effects, "Humour") turns
 * them off for a sober app with the exact same features. Every string a joke
 * replaces keeps its plain meaning: the jokes change tone, never what a
 * control does.
 *
 * A small external store like the home-background one, so every reader in
 * every window updates at once.
 */
const STORAGE_KEY = "ic-flavor";

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

let enabled = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY) return;
    enabled = read();
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function isFlavorEnabled(): boolean {
  return enabled;
}

export function setFlavorEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable: keep the in-memory choice only.
  }
  emit();
}

export function useFlavorEnabled(): boolean {
  return useSyncExternalStore(subscribe, isFlavorEnabled);
}

/** The fun wording when humour is on, the plain one otherwise. */
export function fl<T>(plain: T, fun: T): T {
  return enabled ? fun : plain;
}

/**
 * A greeting for the local hour (0-23) and weekday (0 = Sunday), the Israeli
 * way; Friday afternoon and Saturday are Shabbat.
 */
export function hourGreeting(hour: number, day: number, fun: boolean = enabled): string {
  const fl = <T>(plain: T, joke: T): T => (fun ? joke : plain);
  if (day === 6 || (day === 5 && hour >= 16)) {
    return fl("Good day.", "Shabbat shalom. Working anyway? Respect.");
  }
  if (hour < 5) return fl("Good night.", "Laila tov. The bugs are asleep, you should be too.");
  if (hour < 12) return fl("Good morning.", "Boker tov. Coffee first, then chutzpah.");
  if (hour < 17) return fl("Good afternoon.", "Tzohorayim tovim. Nu, what are we building?");
  return fl("Good evening.", "Erev tov. One more feature, then dinner.");
}
