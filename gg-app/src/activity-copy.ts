import { isFlavorEnabled } from "./flavor";

// Presentation only: these phrases never decide the outcome or its colour.
// Keep each pool semantically equivalent, short, and stable for one request.
export const OUTCOME_PHRASES: Record<string, readonly string[]> = {
  "Response ready": [
    "Answer ready. GG.",
    "Your answer is ready",
    "Answer’s all yours",
    "Fresh answer, ready",
    "Answer ready to read",
    "Response served up",
  ],
  "Findings ready": [
    "Findings, fresh in",
    "Findings ready. GG.",
    "Notes ready to read",
    "Here’s the rundown",
    "Findings on the table",
    "Your findings are in",
  ],
  "Changes saved": [
    "Edits in. Have a look",
    "Changes saved. GG.",
    "Edits ready to review",
    "Changes on the page",
    "Edits are on the board",
    "Changes ready to read",
  ],
  "Tool work finished": [
    "Tool results are in",
    "Tools wrapped up",
    "Tool output, ready",
    "Results ready to read",
    "Tool run wrapped up",
    "Tool results. Your move",
  ],
  "Background work started": [
    "Background job started",
    "Job sent backstage",
    "Background job launched",
    "Job started offstage",
    "Background launch made",
    "Job launched backstage",
  ],
  "Done · checks passed": [
    "Checks passed. Nice.",
    "Checks came back green",
    "Green checks. Lovely.",
    "Checks passed. GG.",
    "Checks looking good",
    "Checks green this time",
  ],
  "Checks failed": [
    "Checks hit a snag",
    "Checks came back red",
    "Checks need a fix",
    "Red checks. Next: fix",
    "Checks found trouble",
    "Checks failed. Fix next",
  ],
  "Verification incomplete": [
    "Checks still needed",
    "Not verified just yet",
    "Checks not confirmed",
    "Verification still owed",
    "Checks need another look",
    "Still needs a check",
  ],
  "Task failed": [
    "Run hit a snag",
    "Run failed. Regroup",
    "This run hit trouble",
    "Run error. Take a look",
    "Run failed. Retry next",
    "Run couldn’t finish",
  ],
  "Stopped · unfinished": [
    "Stopped. Not finished",
    "Run stopped short",
    "Stopped, work remains",
    "Stopped before the end",
    "Run halted. Not done",
    "Stopped. Pick up later",
  ],
  "Response incomplete": [
    "Answer cut short",
    "Response needs more",
    "Answer still unfinished",
    "Response ended early",
    "Answer needs another go",
    "Response not finished",
  ],
  "Plan incomplete": [
    "Plan still has steps",
    "Plan needs another pass",
    "Plan not finished yet",
    "Plan steps still open",
    "More plan steps to go",
    "Plan has work left",
  ],
  "Agents still running": [
    "Agents still at work",
    "Agents haven’t wrapped",
    "Agents still working",
    "Agents need more time",
    "Agent work still open",
    "Waiting on the agents",
  ],
  "Your decision needed": [
    "Your call from here",
    "Your move. We’ll wait",
    "Need your call next",
    "A decision for you",
    "Waiting on your call",
    "Your choice comes next",
  ],
  "Plan needs your decision": [
    "Plan ready. Your call",
    "Plan needs your nod",
    "Your move on the plan",
    "Plan awaits your call",
    "Plan ready for a nod",
    "Plan choice is yours",
  ],
  "Paused · review limit reached": [
    "Review limit reached",
    "Review cap. Take a look",
    "Review rounds maxed out",
    "Review hit its limit",
    "Review capped. Your move",
    "Review limit. Paused",
  ],
  "Israel’s review failed": [
    "Israel’s review hit a snag",
    "Israel’s review failed",
    "Review error. Try again",
    "Israel couldn’t review",
    "Review failed. Retry",
    "Review hit trouble",
  ],
};
OUTCOME_PHRASES["Changed · verification incomplete"] = OUTCOME_PHRASES["Verification incomplete"]!;

// The same outcomes in Israel Code's voice (Settings → Effects → Humour). Only
// the settled outcomes get jokes; anything that needs the user's action keeps
// the plain pool, so a prompt never reads like a punchline.
export const FUN_OUTCOME_PHRASES: Record<string, readonly string[]> = {
  "Response ready": [
    "Answer ready. Nu, read it",
    "Answer’s in. Enjoy, habibi",
    "Answer served, with pita",
    "Fresh answer. Sababa",
    "Answer ready. Mazel tov",
    "Your answer. No charge",
  ],
  "Findings ready": [
    "Findings in. Oy, findings",
    "Findings ready. Sit down",
    "Rundown ready. Nu, read",
    "Findings, fresh as pita",
    "Findings on the table",
    "Found things. Many things",
  ],
  "Changes saved": [
    "Edits in. Mazel tov",
    "Changes saved. Sababa",
    "Edits in. Have a look, nu",
    "Changes made, no balagan",
    "Edits ready. Your move",
    "Changes saved. Kol tov",
  ],
  "Tool work finished": [
    "Tools done. Yalla, read",
    "Tool results in. Sababa",
    "Tools wrapped. Mazel tov",
    "Tool output, hot and ready",
    "Tool run done. Nu?",
    "Results in. Your move",
  ],
  "Done · checks passed": [
    "Checks passed. Mazel tov",
    "Green checks. Sababa",
    "Checks green. Kol hakavod",
    "All green. No balagan",
    "Checks passed. Nu, ship it",
    "Green checks. Yofi",
  ],
  "Checks failed": [
    "Checks red. Oy vey",
    "Checks failed. Balagan",
    "Red checks. Nu, fix next",
    "Checks failed. Not the end",
    "Checks red. Fix, then nosh",
    "Checks hit a snag. Oy",
  ],
  "Task failed": [
    "Run failed. Oy vey",
    "Run hit a snag. Regroup",
    "Run failed. Try again",
    "Run broke. Balagan",
    "Run error. Take a look",
    "Run failed. Not the end",
  ],
};

export function outcomePhrase(label: string, seed: number): string | undefined {
  const choices = (isFlavorEnabled() && FUN_OUTCOME_PHRASES[label]) || OUTCOME_PHRASES[label];
  if (!choices) return undefined;
  const index = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % choices.length : 0;
  return choices[index];
}
