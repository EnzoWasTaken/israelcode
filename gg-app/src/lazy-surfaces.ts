import { lazySurface, preloadAll } from "./lazy-surface";

// Surfaces Home never shows at start-up. Each is its own chunk, warmed on
// idle after first paint (App.tsx) and awaited before it opens.
export const LazyChecklistScreen = lazySurface(
  () => import("./ChecklistScreen"),
  "ChecklistScreen",
);
export const LazyTasksModal = lazySurface(() => import("./TasksModal"), "TasksModal");
export const LazyNotesModal = lazySurface(() => import("./NotesModal"), "NotesModal");
export const LazyMemoryModal = lazySurface(() => import("./MemoryModal"), "MemoryModal");
export const LazyGoalSettingsModal = lazySurface(
  () => import("./GoalSettingsModal"),
  "GoalSettingsModal",
);
export const LazyWorldScreen = lazySurface(() => import("./WorldScreen"), "WorldScreen");
export const LazySettingsModal = lazySurface(() => import("./SettingsModal"), "SettingsModal");
export const LazyRewindModal = lazySurface(() => import("./RewindModal"), "RewindModal");
export const LazyPlanReviewModal = lazySurface(
  () => import("./PlanReviewModal"),
  "PlanReviewModal",
);
export const LazyInitGitModal = lazySurface(() => import("./InitGitModal"), "InitGitModal");
export const LazyNewProjectModal = lazySurface(
  () => import("./NewProjectModal"),
  "NewProjectModal",
);

/** The deck's tool bodies: the deck opens a panel only once these are in. */
export const deckSurfaces = [
  LazyChecklistScreen,
  LazyTasksModal,
  LazyNotesModal,
  LazyMemoryModal,
  LazyGoalSettingsModal,
] as const;

export function deckSurfacesReady(): boolean {
  return deckSurfaces.every((s) => s.ready());
}

export function preloadDeckSurfaces(): Promise<void> {
  return preloadAll(deckSurfaces);
}

/** Everything above, for the idle warm-up after first paint. */
export function preloadLazySurfaces(): Promise<void> {
  return preloadAll([
    ...deckSurfaces,
    LazyWorldScreen,
    LazySettingsModal,
    LazyRewindModal,
    LazyPlanReviewModal,
    LazyInitGitModal,
    LazyNewProjectModal,
  ]);
}
