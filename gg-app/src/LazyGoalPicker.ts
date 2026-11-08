import { lazy } from "react";

// The goal list and its New goal modal load on demand: they are only needed
// once someone opens Goals. One lazy component, shared by every screen that
// shows it, so it suspends only on its first load.
export const GoalPicker = lazy(() =>
  import("./GoalPicker").then((module) => ({ default: module.GoalPicker })),
);
