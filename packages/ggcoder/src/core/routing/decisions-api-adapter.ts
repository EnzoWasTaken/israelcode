import { z } from "zod";
import { EXECUTION_MODES } from "./capabilities.js";
import { DECISION_SERVICE_DEFAULTS, type DecisionService } from "./config.js";
import type { TASK_KINDS } from "./decision-adapter.js";
import {
  DecisionError,
  DIFFICULTY_LEVELS,
  effortForDifficulty,
  type DecisionAdapter,
  type DecisionInput,
  type RawRouteChoice,
} from "./decision-adapter.js";
import type { RouteFallbackReason } from "./types.js";

export interface DecisionsApiOptions {
  service: DecisionService;
  apiKey: string;
  /** Decision model id; defaults per service. */
  model?: string;
  /** Override the endpoint (tests). */
  endpoint?: string;
  fetch?: typeof fetch;
}

const TASK_KIND_HELP: Record<(typeof TASK_KINDS)[number], string> = {
  conversation: "Chat, greeting or a quick question with no code changes",
  coding: "Writing or changing code",
  debugging: "Diagnosing an error, failing test or crash",
  planning: "Planning, designing or architecting",
  research: "Researching or comparing options",
  vision: "Analyzing an image or video",
};

const DIFFICULTY_LEVEL_HELP = [
  "trivial: one-line answer or tiny edit",
  "simple: small, well-scoped change",
  "moderate: several steps or some investigation",
  "hard: large, cross-cutting or ambiguous work",
];

const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().default(0),
});
const scoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number().default(0),
});
const envelope = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional()
    .catch(undefined),
});

function statusToReason(status: number): RouteFallbackReason {
  if (status === 401 || status === 403) return "missing_credentials";
  if (status === 429) return "rate_limited";
  if (status === 400) return "invalid_output";
  return "provider_error";
}

export function createDecisionsApiAdapter(opts: DecisionsApiOptions): DecisionAdapter {
  const defaults = DECISION_SERVICE_DEFAULTS[opts.service];
  const endpoint = opts.endpoint ?? defaults.endpoint;
  const model = opts.model ?? defaults.defaultModel;
  const doFetch = opts.fetch ?? globalThis.fetch;

  return {
    id: `decisions-api:${opts.service}:${model}`,
    label: `${defaults.label} (${model})`,
    async decide(input: DecisionInput, signal: AbortSignal): Promise<RawRouteChoice> {
      if (!opts.apiKey) throw new DecisionError("missing_credentials");
      const askMode = input.allowedModes.length > 1;
      const modelCriteria = Object.fromEntries(input.candidates.map((c) => [c.id, c.description]));
      const questions: Record<string, unknown> = {
        model: {
          type: "choice",
          instructions:
            "Pick the cheapest model that can do this task well. Prefer the current model unless a different one is clearly better.",
          criteria: modelCriteria,
        },
        difficulty: {
          type: "score",
          instructions: "How difficult is this task?",
          criteria: DIFFICULTY_LEVEL_HELP,
        },
        task_kind: {
          type: "choice",
          instructions: "What kind of task is this?",
          criteria: TASK_KIND_HELP,
        },
      };
      if (askMode) {
        questions.mode = {
          type: "choice",
          instructions:
            "Choose how to execute. Use standard unless the work is clearly large, multi-file and decomposable.",
          criteria: Object.fromEntries(
            input.allowedModes.map((m) => [m, EXECUTION_MODES[m].suitability]),
          ),
        };
      }
      const body = {
        model,
        state: {
          task: input.taskText,
          workspace: input.signals.workspace,
          needs_images: input.signals.needsImage,
          needs_video: input.signals.needsVideo,
          context_tokens: input.signals.contextTokensNeeded,
          steps: input.signals.stepCount,
          files_mentioned: input.signals.fileMentions,
          follow_up: input.signals.isFollowUp,
          current_model: input.currentModel,
        },
        questions,
      };

      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        // Deliberately drop the underlying error: it can echo request details.
        throw new DecisionError(signal.aborted ? "timeout" : "provider_error");
      }
      if (!res.ok) throw new DecisionError(statusToReason(res.status));

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new DecisionError("invalid_output");
      }
      const env = envelope.safeParse(json);
      if (!env.success) throw new DecisionError("invalid_output");
      const { answers, usage } = env.data;

      const choice = (id: string) => {
        const a = choiceAnswer.safeParse(answers[id]);
        if (!a.success) throw new DecisionError("invalid_output");
        return a.data;
      };
      const modelAns = choice("model");
      const kindAns = choice("task_kind");
      const modeAns = askMode ? choice("mode") : null;
      const diffParsed = scoreAnswer.safeParse(answers.difficulty);
      if (!diffParsed.success) throw new DecisionError("invalid_output");
      const level = Math.min(
        DIFFICULTY_LEVELS.length - 1,
        Math.max(0, Math.round(diffParsed.data.score)),
      );
      const difficulty = DIFFICULTY_LEVELS[level]!;
      const chosen = input.candidates.find((c) => c.id === modelAns.choice);

      const confidences = [modelAns.confidence, kindAns.confidence, diffParsed.data.confidence];
      if (modeAns) confidences.push(modeAns.confidence);

      return {
        model: modelAns.choice,
        effort: chosen ? effortForDifficulty(difficulty, chosen.thinkingLevels) : null,
        executionMode: modeAns ? modeAns.choice : "standard",
        taskKind: kindAns.choice,
        difficulty,
        confidence: Math.min(...confidences),
        usage: usage
          ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
            }
          : undefined,
      };
    },
  };
}
