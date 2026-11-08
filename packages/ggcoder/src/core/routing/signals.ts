import type { Difficulty, RouteRequest, TaskKind } from "./types.js";

export interface RouteSignals {
  needsImage: boolean;
  needsVideo: boolean;
  contextTokensNeeded: number;
  taskKind: TaskKind;
  difficulty: Difficulty;
  stepCount: number;
  fileMentions: number;
  /** Count of broad-scope phrases ("entire", "across", "migrate"…). */
  broadScope: number;
  isFollowUp: boolean;
  explicitUltracode: boolean;
  explicitOrchestrate: boolean;
  textLength: number;
}

const IMAGE_REF = /!\[|\.(?:png|jpe?g|gif|webp|bmp|heic)\b|\bscreen ?shot|\bmockup\b/i;
const VIDEO_REF = /\.(?:mp4|mov|webm|mkv|avi)\b|\bscreen recording\b/i;
const FILE_MENTION =
  /[\w./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|cs|cpp|css|html|json|ya?ml|toml|md|sql|rb|php|swift)\b/gi;
const BROAD: RegExp[] = [
  /\bacross\b/i,
  /\bmigrat(?:e|ion)\b/i,
  /\bentire\b/i,
  /\bwhole\b/i,
  /\ball (?:the |of the )?(?:tests?|files?|modules?|packages?|endpoints?|components?)\b/i,
  /\bevery (?:file|module|component|endpoint)\b/i,
  /\boverhaul\b|\brewrite\b/i,
  /\bcodebase\b/i,
];
const FOLLOW_UP =
  /^(?:yes|yep|yeah|y|ok(?:ay)?|sure|continue|go ahead|proceed|do it|please do|keep going|go on|sounds good|looks good|next|retry|try again|thanks?)\b[\s.!,]*/i;
const GREETING =
  /^(?:hi|hello|hey|yo|sup|thanks?|thank you|good (?:morning|evening)|gm)\b[\s.!?]*$/i;
const DEBUG =
  /\berror\b|\bexception\b|stack ?trace|failing test|\btests? fail|\bcrash|\bbug\b|traceback|\bat \S+ \(.+:\d+:\d+\)|\bTypeError\b/i;
const PLAN = /\bplan\b|\bdesign\b|\bproposal\b|\broadmap\b|\barchitect/i;
const RESEARCH = /\bresearch\b|\bcompare\b|\bfind out\b|\bpros and cons\b|\bwhich is better\b/i;
const CODEY =
  /```|\b(?:fix|implement|refactor|add|write|function|class|test|typo|rename|regex|variable|import|compile|lint)\b/i;

function countMatches(re: RegExp, s: string): number {
  return s.match(re)?.length ?? 0;
}

function attachmentTokens(a: RouteRequest["attachments"][number]): number {
  switch (a.kind) {
    case "image":
      return 1600;
    case "video":
      return a.bytes ? Math.min(200_000, Math.ceil(a.bytes / 400)) : 20_000;
    case "document":
      return a.bytes ? Math.min(100_000, Math.ceil(a.bytes / 4)) : 5_000;
    case "audio":
      return 5_000;
    default:
      return 1_000;
  }
}

export function extractSignals(req: RouteRequest): RouteSignals {
  const text = req.text;
  const trimmed = text.trim();
  const hasAtt = req.attachments.length > 0;
  const needsImage =
    req.attachments.some((a) => a.kind === "image") ||
    (hasAtt && IMAGE_REF.test(text)) ||
    req.conversation.historyHasImages === true;
  const needsVideo =
    req.attachments.some((a) => a.kind === "video") || (hasAtt && VIDEO_REF.test(text));

  const bulletLines = trimmed
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)).length;
  const connectors = countMatches(/\b(?:then|after that|and then|next|also)\b/gi, trimmed);
  const andVerbs = countMatches(
    /\band (?:also )?(?:update|add|fix|rename|write|remove|migrate|refactor|create|delete|test)\b/gi,
    trimmed,
  );
  const stepCount = bulletLines + connectors + andVerbs;
  const fileMentions = new Set((trimmed.match(FILE_MENTION) ?? []).map((f) => f.toLowerCase()))
    .size;
  const broadScope = BROAD.filter((re) => re.test(trimmed)).length;

  let points = 0;
  if (trimmed.length > 1500) points += 2;
  else if (trimmed.length > 600) points += 1;
  if (stepCount >= 6) points += 2;
  else if (stepCount >= 3) points += 1;
  if (fileMentions >= 3) points += 1;
  points += Math.min(broadScope, 2) * 2;
  if (DEBUG.test(trimmed) && trimmed.length > 200) points += 1;
  if (PLAN.test(trimmed) || RESEARCH.test(trimmed)) points += 1;

  let difficulty: Difficulty;
  if (points >= 3) difficulty = "hard";
  else if (points >= 1) difficulty = "moderate";
  else if (trimmed.length < 100 && stepCount === 0) difficulty = "trivial";
  else difficulty = "simple";

  let taskKind: TaskKind;
  if (needsImage || needsVideo) taskKind = "vision";
  else if (GREETING.test(trimmed)) taskKind = "conversation";
  else if (DEBUG.test(trimmed)) taskKind = "debugging";
  else if (PLAN.test(trimmed)) taskKind = "planning";
  else if (RESEARCH.test(trimmed)) taskKind = "research";
  else if (CODEY.test(trimmed) || fileMentions > 0) taskKind = "coding";
  else if (trimmed.length < 200 || req.workspace !== "code") taskKind = "conversation";
  else taskKind = "coding";

  const isFollowUp =
    req.conversation.turns > 0 &&
    !hasAtt &&
    trimmed.length > 0 &&
    ((trimmed.length <= 40 && FOLLOW_UP.test(trimmed)) ||
      (trimmed.split(/\s+/).length <= 3 && trimmed.length <= 24 && !GREETING.test(trimmed)));

  return {
    needsImage,
    needsVideo,
    contextTokensNeeded:
      req.conversation.estimatedTokens +
      Math.ceil(text.length / 4) +
      req.attachments.reduce((n, a) => n + attachmentTokens(a), 0),
    taskKind,
    difficulty,
    stepCount,
    fileMentions,
    broadScope,
    isFollowUp,
    explicitUltracode: /\bultracode\b/i.test(trimmed),
    explicitOrchestrate: /\borchestrat(?:e|ion)\b/i.test(trimmed),
    textLength: text.length,
  };
}
