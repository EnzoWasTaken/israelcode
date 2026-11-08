import type { RouteReasonCode } from "./types.js";

/** Short user-facing strings. No task text, no chain-of-thought, no secrets. */
export const EXPLANATIONS: Record<RouteReasonCode, string> = {
  image_analysis: "Selected for image analysis",
  video_analysis: "Selected for video analysis",
  quick_question: "Fast model for a quick question",
  complex_task: "Strongest model for a complex task",
  debugging: "Selected for debugging",
  planning: "Selected for planning",
  research: "Selected for research",
  coding: "Selected for coding",
  orchestration: "Using orchestration for a multi-step task",
  ultracode: "Using Ultracode for a large multi-file task",
  kept_current: "Kept your current model",
  balanced_default: "Balanced model for this task",
  pinned: "Using your pinned choices",
  pinned_invalid: "Your pinned model can't handle this task",
  disabled: "Auto routing is off — using your current model",
  auto_unavailable: "Auto routing unavailable — using your current model",
  no_capable_model: "No connected model can handle this — using your current model",
  escalated: "Switched to a different model",
};

export function explainReason(code: RouteReasonCode): string {
  return EXPLANATIONS[code];
}

export function explainConstraintViolation(
  unmet: "no_models" | "vision" | "video" | "context",
  currentLacks?: boolean,
): string {
  switch (unmet) {
    case "vision":
      return currentLacks
        ? "No connected model can read images, and your current model can't either — connect one in Settings"
        : "No connected model can read images — connect one in Settings";
    case "video":
      return currentLacks
        ? "No connected model can read video, and your current model can't either — connect one in Settings"
        : "No connected model can read video — connect one in Settings";
    case "context":
      return "No connected model has enough context — using your current model";
    default:
      return EXPLANATIONS.auto_unavailable;
  }
}

export function explainPinWarning(w: {
  imageUnsupported?: boolean;
  videoUnsupported?: boolean;
  modeUnavailable?: string;
}): string | null {
  if (w.imageUnsupported) return "Your pinned model can't read images";
  if (w.videoUnsupported) return "Your pinned model can't read video";
  if (w.modeUnavailable)
    return `${w.modeUnavailable} isn't available here — kept because you pinned it`;
  return null;
}

const FAILURE_TEXT = {
  rate_limited: "was rate limited",
  provider_unavailable: "was unavailable",
  context_overflow: "ran out of context",
  model_error: "hit an error",
} as const;

export function explainEscalation(
  to: string,
  from: string,
  failure: keyof typeof FAILURE_TEXT,
): string {
  return `Switched to ${to} after ${from} ${FAILURE_TEXT[failure]}`;
}
