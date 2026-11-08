import { lazy } from "react";

// Settings (every page, including About and its changelog) loads on demand:
// Home never shows it. `preloadSettingsScreen` warms the chunk on idle after
// first paint, so the first open doesn't wait on the network or parse.
const load = () => import("./SettingsScreen");
let pending: ReturnType<typeof load> | null = null;

export function preloadSettingsScreen(): ReturnType<typeof load> {
  pending ??= load();
  return pending;
}

export const SettingsScreen = lazy(() =>
  preloadSettingsScreen().then((module) => ({ default: module.SettingsScreen })),
);
