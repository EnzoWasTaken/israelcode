import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  listShellSuggestions,
  searchFiles,
  type AgentState,
  type FileHit,
  type ShellSuggestion,
  type SlashCommand,
  type WorkspaceMode,
} from "./agent";
import type { ShellMenu } from "./Composer";
import { SCHEDULE_COMMAND, ULTRACODE_COMMAND } from "./composer-commands";
import { hasOrchestrateKeyword } from "./orchestration";
import { type DraftEnhancement, followDraftEdit } from "./PromptEnhancement";
import { isScheduleDraft, parseScheduleCommand, withInterval } from "./scheduleCommand";
import { filterShellSuggestions, shellEnterPicks } from "./shell-menu";
import { hasUltracodeKeyword } from "./ultracode";
import { shellCommandFromInput } from "./useShellRuns";

/**
 * What the composer's draft opens: the slash-command menu, the `/schedule`
 * hint, the `@`-file picker, the `!` command picker, the `@Israel` address
 * and the Ultracode/Orchestrate keywords. Extracted from App.tsx.
 */
export function useComposerMenus({
  input,
  setInput,
  setEnhancement,
  setMentionedPaths,
  inputRef,
  workspaceMode,
  state,
  commands,
  shellTrusted,
  revokeShellTrust,
  submitText,
}: {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  setEnhancement: Dispatch<SetStateAction<DraftEnhancement | null>>;
  setMentionedPaths: Dispatch<SetStateAction<string[]>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  workspaceMode: WorkspaceMode;
  state: AgentState | null;
  commands: SlashCommand[];
  shellTrusted: boolean;
  revokeShellTrust: () => Promise<void>;
  submitText: (text: string, label?: string) => boolean;
}) {
  const [shellSuggestions, setShellSuggestions] = useState<ShellSuggestion[]>([]);
  const [shellIndex, setShellIndex] = useState(0);
  // The input the `!` picker was closed for (Esc or a pick); it reopens on edit.
  const [shellMenuDismissedFor, setShellMenuDismissedFor] = useState<string | null>(null);
  // The input the user last moved the picker's highlight for (↑/↓).
  const [shellNavigatedFor, setShellNavigatedFor] = useState<string | null>(null);
  const [ultracodeDismissed, setUltracodeDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  // Caret offset in the composer, tracked so the `/schedule` hint can highlight
  // the slot the user is currently typing in.
  const [caret, setCaret] = useState(0);
  // `@`-mention file picker state. `mention` is the active token being typed
  // (its query + where it starts in the input); `fileMatches` is the live
  // search result; `fileIndex` is the keyboard-highlighted row.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [fileMatches, setFileMatches] = useState<FileHit[]>([]);
  const [fileIndex, setFileIndex] = useState(0);

  // Workflow commands matching the current `/prefix` (only while the input is a
  // single `/token` with no space yet). Empty when not in slash mode.
  const slashQuery =
    input.startsWith("/") && !input.includes(" ") ? input.slice(1).toLowerCase() : null;
  // `/schedule ` (past the command token) swaps the palette for the argument
  // hint. An invalid draft is blocked from being sent to the agent.
  const scheduleDraft = isScheduleDraft(input);
  const scheduleParse = scheduleDraft ? parseScheduleCommand(input) : null;
  // Drives the composer's invalid affordance; submit() enforces the block.
  const scheduleInvalid = scheduleParse !== null && !scheduleParse.ok;
  // Commit lives in the top-right button, not the slash menu.
  const COMMIT_NAMES = ["commit", "setup-commit"];
  // `/schedule` is handled entirely in the webview (it registers a timer rather
  // than prompting the agent), so the sidecar's registry never lists it. Inject
  // it here or it would be undiscoverable — typing `/sch` would show nothing.
  const ultracodeAvailable = workspaceMode === "code" && !state?.goal;
  const menuCommands = [
    SCHEDULE_COMMAND,
    ...(ultracodeAvailable ? [ULTRACODE_COMMAND] : []),
    ...commands,
  ].filter((c) => !COMMIT_NAMES.includes(c.name));
  const slashMatches =
    slashQuery !== null
      ? menuCommands.filter(
          (c) =>
            c.name.toLowerCase().startsWith(slashQuery) ||
            c.aliases.some((a) => a.toLowerCase().startsWith(slashQuery)),
        )
      : [];
  const slashOpen = slashMatches.length > 0;
  // Clamp so a shrinking match list never points past the end.
  const clampedSlashIndex = slashMatches.length > 0 ? slashIndex % slashMatches.length : 0;

  // `@Ken` is the mentor-agent address, not a file mention. When the input leads
  // with it (case-insensitive, word-boundary so `@kennedy.ts` still picks files),
  // Ken is "active": the file picker is suppressed and the input is tinted in
  // Ken's color with a shimmering marker, so it's obvious the message goes to Ken.
  const kenActive = workspaceMode === "code" && /^@(?:israel|ken)\b/i.test(input.trimStart());
  // Split the input for the `@Ken` highlight overlay: any leading whitespace,
  // the literal `@Ken` token (preserving the user's casing), then the rest. Only
  // the token shimmers; lead+rest render in the normal input color.
  const kenInputParts = (() => {
    const m = /^(\s*)(@(?:israel|ken))/i.exec(input);
    if (!m) return null;
    return { lead: m[1], token: m[2], rest: input.slice(m[1].length + m[2].length) };
  })();
  // `@`-mention picker: open whenever a mention token is active and the search
  // returned at least one file. Clamp the highlighted row to the result count.
  // Never open while `@Ken` is active — that token addresses Ken, not a file.
  // `!cmd`: the input runs a command instead of messaging the agent.
  const shellMode = workspaceMode === "code" && shellCommandFromInput(input) !== null;
  const ultracodeKeyword =
    ultracodeAvailable &&
    !shellMode &&
    !input.trimStart().startsWith("/") &&
    hasUltracodeKeyword(input);
  const ultracodeArmed = ultracodeKeyword && !ultracodeDismissed;
  // "orchestrate" typed in the draft: Orchestrate for this prompt only.
  const orchestrateKeyword =
    ultracodeAvailable &&
    !shellMode &&
    !input.trimStart().startsWith("/") &&
    hasOrchestrateKeyword(input);
  // A dismissal lasts while the word stays in the draft; typing it anew re-arms.
  useEffect(() => {
    if (!ultracodeKeyword) setUltracodeDismissed(false);
  }, [ultracodeKeyword]);

  // Entering `!` loads the picker's commands (history counts change per run).
  useEffect(() => {
    if (!shellMode) return;
    let live = true;
    void listShellSuggestions().then((list) => {
      if (live) setShellSuggestions(list);
    });
    return () => {
      live = false;
    };
  }, [shellMode]);
  const shellMatches = useMemo(
    () => (shellMode ? filterShellSuggestions(shellSuggestions, input.slice(1)) : []),
    [shellMode, shellSuggestions, input],
  );
  const shellMenu: ShellMenu | null =
    shellMatches.length > 0 && shellMenuDismissedFor !== input
      ? {
          matches: shellMatches,
          activeIndex: shellIndex % shellMatches.length,
          setActiveIndex: setShellIndex,
          navigate: (delta) => {
            const n = shellMatches.length;
            setShellIndex((i) => (((i + delta) % n) + n) % n);
            setShellNavigatedFor(input);
          },
          enterPicks: shellEnterPicks(input, shellNavigatedFor),
          pick: (s) => {
            const next = `!${s.command}`;
            setInput(next);
            setShellIndex(0);
            // A picked command is complete: close the picker until the user edits it.
            setShellMenuDismissedFor(next);
            requestAnimationFrame(() => {
              const el = inputRef.current;
              if (!el) return;
              el.focus();
              el.setSelectionRange(next.length, next.length);
            });
          },
          dismiss: () => setShellMenuDismissedFor(input),
          trusted: shellTrusted,
          revokeTrust: () => void revokeShellTrust(),
        }
      : null;
  const mentionOpen = mention !== null && fileMatches.length > 0 && !kenActive && !shellMode;
  const clampedFileIndex = fileMatches.length > 0 ? fileIndex % fileMatches.length : 0;

  /** Put text in the composer with the caret at the end, ready to finish and send. */
  function fillComposer(text: string): void {
    setInput(text);
    setCaret(text.length);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }

  /**
   * Fill the interval slot from a preset chip. Replaces an existing interval
   * rather than appending, so clicking `1h` after `15m` swaps it instead of
   * producing a second bar. Keeps focus in the composer so typing continues.
   */
  function fillScheduleInterval(preset: string): void {
    const { text, caret: caretAt } = withInterval(input, preset);
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caretAt, caretAt);
      setCaret(caretAt);
    });
  }

  function pickSlashCommand(cmd: SlashCommand): void {
    if (cmd.name === "add-dir" || cmd.name === "remove-dir") {
      setInput("");
      setSlashIndex(0);
      void pickWorkspaceDirectory(cmd.name);
      return;
    }

    // Fill the input with the command; the user can add args or press Enter.
    const next = `/${cmd.name} `;
    setInput(next);
    setSlashIndex(0);
    // Keep the caret state in sync with the filled text, so an argument hint
    // (e.g. `/schedule`) highlights the right slot instead of a stale offset.
    setCaret(next.length);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function pickWorkspaceDirectory(command: "add-dir" | "remove-dir"): Promise<void> {
    const selected = await open({
      directory: true,
      multiple: false,
      title:
        command === "add-dir"
          ? "Add project folder to workspace"
          : "Remove project folder from workspace",
    });
    if (typeof selected !== "string") return;
    submitText(`/${command} ${selected}`, command === "add-dir" ? "/add-dir" : "/remove-dir");
  }

  // Detect an active `@`-mention token at the caret: a `@` that starts at a word
  // boundary with no whitespace between it and the caret. Returns the query text
  // after `@` and the `@`'s index, or null when not in a mention.
  function detectMention(text: string, caret: number): { query: string; start: number } | null {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    // Must start at the line start or after whitespace.
    const prev = at > 0 ? before[at - 1] : " ";
    if (prev !== undefined && !/\s/.test(prev)) return null;
    const query = before.slice(at + 1);
    // A space ends the token — no mention once the path is followed by a space.
    if (/\s/.test(query)) return null;
    return { query, start: at };
  }

  // Sync the mention picker to the current input + caret on every change.
  function updateMention(text: string, caret: number): void {
    setMention(detectMention(text, caret));
  }

  // Debounced file search whenever the active mention query changes. Skipped when
  // `@Ken` is active so typing `@ken` never spawns a file lookup or picker.
  useEffect(() => {
    if (mention === null || kenActive) {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchFiles(mention.query).then((files) => {
        if (!cancelled) {
          setFileMatches(files);
          setFileIndex(0);
        }
      });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mention, kenActive]);

  // Pick a file: drop the typed `@query` from the input, add the file as a chip
  // (deduped), and restore the caret where the token was. The path lives in chip
  // state, never in the textarea text.
  function pickMentionFile(file: FileHit): void {
    if (mention === null) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const head = input.slice(0, mention.start);
    const tail = input.slice(caret);
    const next = head + tail;
    setInput(next);
    setEnhancement((current) => followDraftEdit(current, input, next));
    setMentionedPaths((prev) => (prev.includes(file.path) ? prev : [...prev, file.path]));
    setMention(null);
    setFileMatches([]);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(head.length, head.length);
    });
  }

  // Drop a referenced-file chip.
  function removeMentionChip(p: string): void {
    setMentionedPaths((prev) => prev.filter((x) => x !== p));
  }

  return {
    caret,
    setCaret,
    setSlashIndex,
    mention,
    setMention,
    fileMatches,
    setFileIndex,
    scheduleDraft,
    scheduleInvalid,
    ultracodeAvailable,
    slashMatches,
    slashOpen,
    clampedSlashIndex,
    kenActive,
    kenInputParts,
    shellMode,
    ultracodeArmed,
    orchestrateKeyword,
    setUltracodeDismissed,
    shellMenu,
    mentionOpen,
    clampedFileIndex,
    fillComposer,
    fillScheduleInterval,
    pickSlashCommand,
    updateMention,
    pickMentionFile,
    removeMentionChip,
  };
}
