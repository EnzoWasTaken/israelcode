import type { HistoryEntry } from "./agent";
import { readChatError } from "./chat-error";
import { recoverPromptLabel } from "./prompt-labels";
import { parseReferencedFiles } from "./ReferencedFiles";
import { collapseSecurityRows } from "./security-notices";
import { nextId, verifyItemFromResult, type Item } from "./transcript-item";
import { shellItemFromHistory } from "./useShellRuns";

// Info row shown when a video attachment is sent to a model without native
// video analysis. Shared by the live send path and history restore so the
// resumed transcript matches the live one exactly.
export const VIDEO_CAPABILITY_WARNING =
  "This model can't watch video directly. The agent can still extract frames or audio with ffmpeg if needed — switch to a video-capable model (Kimi, MiniMax, MiMo) for native video analysis.";

/**
 * ↑/↓ recall seeded from a resumed session's prompts (chronological). App-
 * button prompts (shimmer labels) weren't typed by the user, so they're skipped.
 */
export function promptHistoryFrom(history: readonly HistoryEntry[]): string[] {
  return history
    .filter((h) => h.role === "user" && !(!h.command && recoverPromptLabel(h.text)))
    .map((h) => {
      const parsed = !h.command ? parseReferencedFiles(h.text) : null;
      return (parsed ? parsed.text : h.text).trim();
    })
    .filter((t, i, a) => t.length > 0 && a[i - 1] !== t);
}

/** A resumed session's transcript rows, rendered identically to their live counterparts. */
export function itemsFromHistory(
  history: readonly HistoryEntry[],
  pendingShellRuns: readonly string[],
): Item[] {
  return collapseSecurityRows(
    history.map((h): Item => {
      // Tool-produced images (screenshots, generate_image) — reconstructed
      // from persisted ImageContent blocks, downsampled by the sidecar.
      if (h.toolImages && h.toolImages.length > 0)
        return {
          kind: "images",
          id: nextId(),
          images: h.toolImages.map((img) => ({ src: img.src, path: img.path })),
        };
      if (h.todos) return { kind: "todos", id: nextId(), todos: h.todos, settled: true };
      // Sub-agent delegation group — reconstructed from persisted tool_call
      // + tool_result pairing. toolUseCount/activities aren't persisted, so
      // the resumed feed shows agent name + status only.
      if (h.subagentGroup && h.subagentGroup.length > 0)
        return {
          kind: "subagent_group",
          id: nextId(),
          agents: h.subagentGroup.map((a, i) => ({
            toolCallId: `history-${i}`,
            agentName: a.agentName,
            status: a.status,
            activities: [],
            toolUseCount: a.toolUseCount,
            tokenUsage: { input: 0, output: 0 },
          })),
        };
      if (h.hook) return { kind: "hook", id: nextId(), hook: h.hook };
      // A resumed compacted session shows the quiet compaction notice in
      // place of the raw summary body (counts aren't persisted).
      if (h.compacted)
        return {
          kind: "compaction",
          id: nextId(),
          status: "done",
          originalCount: h.compactionCounts?.originalCount,
          newCount: h.compactionCounts?.newCount,
        };
      // Persisted display-only markers: plan-mode banner, task header,
      // error rows, and the video-capability info row — all rendered
      // identically to their live counterparts.
      if (h.plan) return { kind: "plan", id: nextId(), reason: h.plan.reason };
      if (h.task) return { kind: "task", id: nextId(), title: h.task.title };
      if (h.error) {
        return {
          kind: "error",
          id: nextId(),
          ...readChatError({ ...h.error }, h.error.scope, true),
        };
      }
      if (h.security)
        return {
          kind: "security",
          id: nextId(),
          rule: h.security.rule,
          target: h.security.target,
        };
      if (h.infoKind === "video_warning")
        return { kind: "info", id: nextId(), text: VIDEO_CAPABILITY_WARNING };
      if (h.shell) return shellItemFromHistory(h.shell, nextId(), pendingShellRuns);
      if (h.checkoutNotice) return { kind: "info", id: nextId(), text: h.checkoutNotice };
      if (h.verify) return verifyItemFromResult(nextId(), h.verify);
      // Ken "Send to GG Coder" prompts: restore the shimmer label, not the
      // full prompt body (matches live).
      if (h.kenSent && h.role === "user")
        return { kind: "user", id: nextId(), text: h.text, kenSent: true };
      // Persisted Ken (mentor) turns: his reply restores as a Ken bubble,
      // the `@Ken` question as a Ken-tinted user bubble (matches live).
      if (h.ken && h.role === "assistant") return { kind: "ken", id: nextId(), text: h.text };
      if (h.ken && h.role === "user")
        return { kind: "user", id: nextId(), text: h.text, ken: true };
      // Persisted autopilot verdict marker: render identically to the
      // live item so a resumed session never shows the raw verdict text
      // (e.g. "ALL_CLEAR") the model actually replied with.
      if (h.autopilot)
        return {
          kind: "autopilot",
          id: nextId(),
          phase: h.autopilot.phase,
          reason: h.autopilot.reason,
          body: h.autopilot.body,
          copySeed: h.autopilot.copySeed,
        };
      if (h.role !== "user") return { kind: h.role, id: nextId(), text: h.text };
      // App-button prompts (e.g. "Initialize Git") were shown live as a
      // friendly shimmer label, not the expanded body. The label is
      // webview-only, so recover it from the restored prompt text. Slash
      // commands are already collapsed to `/name` by the sidecar (h.command).
      const label = !h.command ? recoverPromptLabel(h.text) : null;
      // Recover @-referenced files appended to the prompt so resumed
      // sessions show the same file chips (and clean text) as when sent.
      const parsed = !h.command && label === null ? parseReferencedFiles(h.text) : null;
      return {
        kind: "user",
        id: nextId(),
        text: parsed ? parsed.text : h.text,
        command: h.command || label !== null,
        ...(label !== null ? { label } : {}),
        images: h.images && h.images.length > 0 ? h.images : undefined,
        ...(h.attachments && h.attachments.length > 0 ? { attachments: h.attachments } : {}),
        ...(parsed && parsed.files.length > 0 ? { files: parsed.files } : {}),
        ...(h.enhancements && h.enhancements.length > 0 ? { enhancements: h.enhancements } : {}),
        ...(h.ultracode ? { ultracode: true } : {}),
        ...(h.orchestrate ? { orchestrate: true } : {}),
      };
    }),
  );
}
