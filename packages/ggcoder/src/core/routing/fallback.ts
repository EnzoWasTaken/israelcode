import type { ThinkingLevel } from "@kenkaiiii/gg-ai";
import { capEffort, qualityScore, type ModelCapability } from "./capabilities.js";
import type { AutoRouteConfig } from "./config.js";
import { effortForDifficulty } from "./decision-adapter.js";
import type { RouteSignals } from "./signals.js";
import type { Difficulty, ExecutionMode, RouteRequest, TaskKind } from "./types.js";

export interface DeterministicChoice {
  capability: ModelCapability;
  effort: ThinkingLevel | null;
  executionMode: ExecutionMode;
  taskKind: TaskKind;
  difficulty: Difficulty;
  keptCurrent: boolean;
}

const byCheap = (a: ModelCapability, b: ModelCapability) =>
  a.relativeCost - b.relativeCost ||
  a.relativeLatency - b.relativeLatency ||
  qualityScore(b) - qualityScore(a);

/** Pure rules-based routing over already-constraint-filtered candidates (non-empty). */
export function deterministicRoute(
  req: RouteRequest,
  signals: RouteSignals,
  candidates: readonly ModelCapability[],
  allowedModes: readonly ExecutionMode[],
  config: AutoRouteConfig,
): DeterministicChoice {
  const { difficulty, taskKind } = signals;
  const current = candidates.find(
    (c) => c.provider === req.current.provider && c.model === req.current.model,
  );
  const cheapest = [...candidates].sort(byCheap)[0]!;
  let pick: ModelCapability;
  let keptCurrent = false;

  if (difficulty === "hard") {
    pick = [...candidates].sort((a, b) => qualityScore(b) - qualityScore(a) || byCheap(a, b))[0]!;
    // Equivalent quality to the current model: stay put (cache affinity).
    if (current && qualityScore(current) >= qualityScore(pick)) {
      pick = current;
      keptCurrent = true;
    }
  } else if (difficulty === "trivial" || difficulty === "simple") {
    if (current && current.relativeCost <= cheapest.relativeCost * 2) {
      pick = current;
      keptCurrent = true;
    } else {
      pick = cheapest;
    }
  } else {
    const capable = candidates.filter(
      (c) => c.strengths.includes("coding") || c.strengths.includes("reasoning"),
    );
    if (current && capable.includes(current)) {
      pick = current;
      keptCurrent = true;
    } else {
      pick = [...(capable.length ? capable : candidates)].sort(byCheap)[0]!;
    }
  }

  let executionMode: ExecutionMode = "standard";
  if (
    difficulty === "hard" &&
    allowedModes.includes("ultracode") &&
    (signals.stepCount >= 3 || signals.broadScope >= 2)
  ) {
    executionMode = "ultracode";
  }

  return {
    capability: pick,
    effort: capEffort(effortForDifficulty(difficulty, pick.thinkingLevels), config.maxEffort),
    executionMode,
    taskKind,
    difficulty,
    keptCurrent: keptCurrent && pick === current,
  };
}
