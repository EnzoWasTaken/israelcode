import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  sendKenPrompt,
  sendPrompt,
  type AgentState,
  type PromptMeta,
  type WorkspaceMode,
} from "./agent";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentBytes,
  attachmentChips,
  toWire,
  type PendingAttachment,
} from "./attachments";
import type { createChatLayoutMotion } from "./chat-layout-motion";
import { readChatError } from "./chat-error";
import { VIDEO_CAPABILITY_WARNING } from "./history-items";
import { type DraftEnhancement, rebaseSegments } from "./PromptEnhancement";
import { appendReferencedFiles } from "./ReferencedFiles";
import { describeSchedule, isScheduleDraft, parseScheduleCommand } from "./scheduleCommand";
import { showsQueuedBubble } from "./submit-disposition";
import { toast } from "./toast";
import { nextId, type Item } from "./transcript-item";
import { parseUltracodeCommand } from "./ultracode";
import type { useSchedules } from "./useSchedules";
import { shellCommandFromInput } from "./useShellRuns";

/**
 * The composer's send (Enter): an answer typed for an open question, a `!`
 * command, `/schedule`, `/rewind`, `/ultracode`, an `@Israel` question, or a
 * prompt with its attachments and @-files (queued as steering mid-run).
 * Recreated each render, like the functions it replaced in App.tsx.
 */
export function createComposerSubmit({
  input,
  setInput,
  attachments,
  setAttachments,
  clearAttachments,
  attachmentReadsRef,
  mentionedPaths,
  setMentionedPaths,
  setMention,
  setSlashIndex,
  enhancement,
  setEnhancement,
  setSendCount,
  setItems,
  pushItem,
  endStreamingText,
  chatLayout,
  stickToBottomRef,
  readyRef,
  typingAskRef,
  answerAsk,
  hasOpenAsk,
  dismissOpenAsks,
  noteSupersedingSend,
  isWorkflowCommand,
  recordHistory,
  workspaceMode,
  state,
  running,
  submitShell,
  markShellShared,
  addSchedule,
  rewindAvailable,
  setRewindAt,
  ultracodeAvailable,
  ultracodeArmed,
  orchestrateKeyword,
  changeUltracode,
}: {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  attachments: PendingAttachment[];
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  clearAttachments: () => void;
  attachmentReadsRef: RefObject<number>;
  mentionedPaths: string[];
  setMentionedPaths: Dispatch<SetStateAction<string[]>>;
  setMention: Dispatch<SetStateAction<{ query: string; start: number } | null>>;
  setSlashIndex: Dispatch<SetStateAction<number>>;
  enhancement: DraftEnhancement | null;
  setEnhancement: Dispatch<SetStateAction<DraftEnhancement | null>>;
  setSendCount: Dispatch<SetStateAction<number>>;
  setItems: Dispatch<SetStateAction<Item[]>>;
  pushItem: (item: Item) => void;
  endStreamingText: () => void;
  chatLayout: ReturnType<typeof createChatLayoutMotion>;
  stickToBottomRef: RefObject<boolean>;
  readyRef: RefObject<boolean>;
  typingAskRef: RefObject<{ itemId: number; promptId: string; questionId: string } | null>;
  answerAsk: (itemId: number, promptId: string, delta: Record<string, string | string[]>) => void;
  hasOpenAsk: () => boolean;
  dismissOpenAsks: () => void;
  noteSupersedingSend: (text: string) => void;
  isWorkflowCommand: (text: string) => boolean;
  recordHistory: (text: string) => void;
  workspaceMode: WorkspaceMode;
  state: AgentState | null;
  running: boolean;
  submitShell: (command: string, cwd: string) => void;
  markShellShared: () => void;
  addSchedule: ReturnType<typeof useSchedules>["addSchedule"];
  rewindAvailable: boolean;
  setRewindAt: Dispatch<SetStateAction<string | null>>;
  ultracodeAvailable: boolean;
  ultracodeArmed: boolean;
  orchestrateKeyword: boolean;
  changeUltracode: (next: boolean) => void;
}) {
  // A send that never reached the agent must not look delivered: drop its
  // bubble, say what happened, and hand the draft back. Anything the user has
  // typed or staged since is never overwritten.
  function restoreFailedSend(
    failed: {
      bubbleId: number;
      draft: string;
      attachments: PendingAttachment[];
      mentionedPaths: string[];
      scope: "error" | "ken_error";
    },
    error: unknown,
  ): void {
    setItems((prev) => prev.filter((it) => it.id !== failed.bubbleId));
    pushItem({
      kind: "error",
      id: nextId(),
      ...readChatError(
        {
          headline: "Your message wasn't sent",
          message: error instanceof Error ? error.message : String(error),
          guidance: "Your draft is back in the message box. Send it again when the agent is ready.",
          reason: "network",
        },
        failed.scope,
      ),
    });
    setInput((cur) => (cur === "" ? failed.draft : cur));
    if (failed.attachments.length > 0)
      setAttachments((cur) => (cur.length === 0 ? failed.attachments : cur));
    if (failed.mentionedPaths.length > 0)
      setMentionedPaths((cur) => (cur.length === 0 ? failed.mentionedPaths : cur));
  }

  // Submit the current input together with any staged attachments. Images are
  // echoed inline in the user's bubble; all media is sent to the agent.
  function submit(): void {
    if (attachmentReadsRef.current > 0) {
      toast("Attachments are still loading. Please wait.");
      return;
    }
    const trimmed = input.trim();
    // "Type instead" on an open question band parks the answer here: the agent's
    // tool call is blocked on it, so this text is the ANSWER, not a new prompt.
    // Queueing it as steering would leave the tool call hanging until it times
    // out, and the model would never see what the user typed. Only composer
    // sends the user typed count — a command or scheduled prompt firing through
    // submitText() must not consume the answer.
    const typed = typingAskRef.current;
    if (typed && trimmed) {
      chatLayout.capture();
      typingAskRef.current = null;
      setInput("");
      setSlashIndex(0);
      answerAsk(typed.itemId, typed.promptId, { [typed.questionId]: trimmed });
      return;
    }
    if (!readyRef.current) return;
    if (!trimmed && attachments.length === 0 && mentionedPaths.length === 0) return;

    // `!cmd` runs a command for the user, in the project folder, with no agent
    // turn. Attachments and file chips stay in the composer for the next message.
    const shellCommand = workspaceMode === "code" ? shellCommandFromInput(input) : null;
    if (shellCommand !== null) {
      if (!shellCommand) return;
      chatLayout.capture();
      recordHistory(trimmed);
      stickToBottomRef.current = true;
      submitShell(shellCommand, state?.cwd ?? "");
      setInput("");
      setSlashIndex(0);
      setMention(null);
      return;
    }

    // `/schedule` registers a recurring prompt instead of sending anything now.
    // An invalid draft is refused outright — sending it would run the raw command
    // text as a prompt — and the hint above the composer already says why.
    if (isScheduleDraft(input)) {
      const result = parseScheduleCommand(input);
      if (!result.ok) return;
      chatLayout.capture();
      addSchedule(result.value);
      // Confirm in the transcript, otherwise pressing Enter looks like it did
      // nothing: the first run is a whole interval away, so there is no other
      // feedback until then.
      pushItem({
        kind: "user",
        id: nextId(),
        text: trimmed,
        command: true,
        label: `Scheduled · ${describeSchedule(result.value)}`,
      });
      recordHistory(trimmed);
      stickToBottomRef.current = true;
      setInput("");
      setSlashIndex(0);
      return;
    }

    // `/rewind` opens the picker instead of prompting.
    if (rewindAvailable && /^\/rewind\s*$/i.test(trimmed)) {
      if (!running) setRewindAt("");
      else toast("Stop the agent before rewinding.", "error");
      setInput("");
      setSlashIndex(0);
      return;
    }

    // `/ultracode [on|off]` changes the session setting instead of prompting.
    const ultracodeCommand = ultracodeAvailable ? parseUltracodeCommand(trimmed) : null;
    if (ultracodeCommand) {
      const next =
        ultracodeCommand === "toggle" ? !(state?.ultracode ?? false) : ultracodeCommand === "on";
      changeUltracode(next);
      pushItem({
        kind: "user",
        id: nextId(),
        text: trimmed,
        command: true,
        label: next ? "Ultracode on" : "Ultracode off",
      });
      recordHistory(trimmed);
      stickToBottomRef.current = true;
      setInput("");
      setSlashIndex(0);
      return;
    }

    // `@Ken <prompt>` (case-insensitive, optional colon) routes to Ken Kai, the
    // read-only mentor agent — NOT GG Coder. Ken runs concurrently with any
    // build run; his reply streams into a magenta bubble via ken_* events.
    const kenMatch = workspaceMode === "code" ? /^@(?:israel|ken)\b:?\s*/i.exec(trimmed) : null;
    if (kenMatch) {
      if (attachments.length > 0) {
        toast(
          "Israel cannot receive attachments. Remove @Israel to send them to Israel Code.",
          "warning",
        );
        return;
      }
      const question = trimmed.slice(kenMatch[0].length).trim();
      if (!question) return;
      chatLayout.capture();
      setSendCount((n) => n + 1);
      recordHistory(trimmed);
      stickToBottomRef.current = true;
      const kenBubbleId = nextId();
      const kenFailed = {
        bubbleId: kenBubbleId,
        draft: input,
        attachments: [],
        mentionedPaths,
        scope: "ken_error" as const,
      };
      pushItem({ kind: "user", id: kenBubbleId, text: trimmed, ken: true });
      setInput("");
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      setEnhancement(null);
      void sendKenPrompt(question).catch((e: unknown) => restoreFailedSend(kenFailed, e));
      return;
    }

    // Over this the sidecar refuses the whole request, so stop here with the draft intact.
    const totalBytes = attachmentBytes(attachments);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      const mb = (bytes: number): number => Math.ceil(bytes / (1024 * 1024));
      toast(
        `Attachments are too big to send (${mb(totalBytes)} MB). The limit is ${mb(MAX_ATTACHMENT_BYTES)} MB per message.`,
        "error",
      );
      return;
    }

    chatLayout.capture();
    // The strips this send clears (chips, the cold-cache notice) must leave in
    // the bubble's commit, or their fold resizes the transcript mid-move.
    setSendCount((n) => n + 1);
    recordHistory(trimmed);
    markShellShared();
    // Read BEFORE the dismissal clears the band: a prompt that supersedes a
    // question is consumed as soon as it lands, so it must neither flash the
    // queued look on the way in nor open the queued strip below the transcript
    // (see showsQueuedBubble / withoutSupersedingMessage).
    const supersedesQuestion = hasOpenAsk();
    dismissOpenAsks();
    // A user send always re-pins to the bottom — they want to see their message.
    stickToBottomRef.current = true;
    // Referenced files are appended to the prompt as a small block so the agent
    // knows which paths to read; they aren't shown in the user's bubble text.
    const prompt =
      mentionedPaths.length > 0 ? appendReferencedFiles(trimmed, mentionedPaths) : trimmed;
    const bubbleId = nextId();
    const failed = {
      bubbleId,
      draft: input,
      attachments,
      mentionedPaths,
      scope: "error" as const,
    };
    // Carry the enhancer's highlighted segments (re-anchored through any edits)
    // into the sent bubble, aligned to the trimmed text the bubble shows.
    const sentEnhancements =
      enhancement && enhancement.plain === input
        ? (rebaseSegments(enhancement.segments, input, trimmed) ?? undefined)
        : undefined;
    // While a run is in flight, the message is QUEUED as steering (the sidecar
    // injects it mid-loop). Attachments queue too — they're persisted and ride
    // the same native-block path when the queue drains. Queued rows render
    // dimmed until run_end clears the flag.
    if (running) {
      if (supersedesQuestion) noteSupersedingSend(prompt);
      const queuedWire = attachments.map(toWire);
      const queuedImgs = attachments.flatMap((a) => (a.previewUrl ? [a.previewUrl] : []));
      pushItem({
        kind: "user",
        id: bubbleId,
        text: trimmed,
        command: isWorkflowCommand(trimmed),
        images: queuedImgs.length > 0 ? queuedImgs : undefined,
        attachments: attachmentChips(attachments),
        files: mentionedPaths.length > 0 ? mentionedPaths : undefined,
        enhancements: sentEnhancements,
        queued: showsQueuedBubble("queue", supersedesQuestion) ? true : undefined,
      });
      setInput("");
      clearAttachments();
      setSlashIndex(0);
      setMention(null);
      setMentionedPaths([]);
      setEnhancement(null);
      void sendPrompt(
        prompt,
        queuedWire,
        sentEnhancements ? { enhancements: sentEnhancements } : undefined,
      ).catch((e: unknown) => restoreFailedSend(failed, e));
      return;
    }
    const wire = attachments.map(toWire);
    const imgPreviews = attachments.flatMap((a) => (a.previewUrl ? [a.previewUrl] : []));
    pushItem({
      kind: "user",
      id: bubbleId,
      text: trimmed,
      command: isWorkflowCommand(trimmed),
      images: imgPreviews.length > 0 ? imgPreviews : undefined,
      attachments: attachmentChips(attachments),
      files: mentionedPaths.length > 0 ? mentionedPaths : undefined,
      enhancements: sentEnhancements,
      ultracode: ultracodeAvailable && (ultracodeArmed || state?.ultracode) ? true : undefined,
      orchestrate:
        ultracodeAvailable && (orchestrateKeyword || state?.orchestration?.orchestrate)
          ? true
          : undefined,
    });
    // Warn the user when a video attachment is sent to a model without native
    // video analysis — the agent can still use ffmpeg to extract frames/audio,
    // but can't watch the clip directly.
    if (wire.some((a) => a.kind === "video") && !(state?.supportsVideo ?? false)) {
      pushItem({
        kind: "info",
        id: nextId(),
        text: VIDEO_CAPABILITY_WARNING,
      });
    }
    setInput("");
    clearAttachments();
    setSlashIndex(0);
    setMention(null);
    setMentionedPaths([]);
    setEnhancement(null);
    endStreamingText();
    const meta: PromptMeta = {
      ...(sentEnhancements ? { enhancements: sentEnhancements } : {}),
      ...(ultracodeArmed ? { ultracode: true } : {}),
      ...(orchestrateKeyword ? { orchestrate: true } : {}),
    };
    void sendPrompt(prompt, wire, Object.keys(meta).length > 0 ? meta : undefined).catch(
      (e: unknown) => restoreFailedSend(failed, e),
    );
  }

  return { submit };
}
