import type { Dispatch, SetStateAction } from "react";
import {
  isSwitchModelError,
  respondApproval,
  setCritterModel,
  setOrchestrate,
  setPermissionMode,
  setUltracode,
  setWorkerModel,
  switchKenModel,
  switchModel,
  type AgentState,
  type CompactionState,
  type VerifyState,
  type WorktreeWorkersState,
} from "./agent";
import { currentPill, nextPill } from "./permission-mode";
import { playSound } from "./sounds";
import { toast } from "./toast";

/**
 * The session's settings, changed from the deck, the composer or a chat error:
 * the models (main, Israel, Critters, Workers), the permission mode, pending
 * approvals, Ultracode, Orchestrate, Verify, worktree workers and compaction.
 * Recreated each render, like the functions it replaced in App.tsx.
 */
export function createSessionActions({
  state,
  setState,
  running,
}: {
  state: AgentState | null;
  setState: Dispatch<SetStateAction<AgentState | null>>;
  running: boolean;
}) {
  // Pin Ken to a model (or null → clear the pin, follow GG Coder). The
  // sidecar's ken_model_change broadcast updates state; the .then is just a
  // faster local echo of the same payload.
  function onSelectKenModel(modelId: string | null): void {
    if (state && modelId !== null && state.kenModelOverride && modelId === state.kenModel) return;
    if (state && modelId === null && !state.kenModelOverride) return;
    void switchKenModel(modelId).then((res) => {
      if (!res) {
        // Without this the picker just snaps back and the click looks ignored.
        toast("Couldn't switch Israel's model.", "error");
        return;
      }
      setState((s) =>
        s
          ? {
              ...s,
              kenProvider: res.kenProvider,
              kenModel: res.kenModel,
              kenModelOverride: res.kenModelOverride,
            }
          : s,
      );
    });
  }

  // A Goal window's footer: the model GG Goals' workers ("critters") run on.
  function onSelectCritterModel(modelId: string | null): void {
    const current = state?.goal?.critterModel ?? null;
    if (modelId === current) return;
    void setCritterModel(modelId)
      .then((res) => {
        setState((s) =>
          s?.goal ? { ...s, goal: { ...s.goal, critterModel: res.critterModel } } : s,
        );
      })
      .catch((e: unknown) =>
        // Otherwise the picker just snaps back and the click looks ignored.
        toast(e instanceof Error ? e.message : String(e), "error"),
      );
  }

  function onSelectModel(modelId: string, options?: { confirmPaid?: boolean }): void {
    if (state && modelId === state.model) return;
    void switchModel(modelId, options).then((res) => {
      if (isSwitchModelError(res)) {
        // The sidecar refuses with a reason worth reading ("Ollama isn't
        // running at …", "has no tool calling"). Show it — otherwise the
        // picker just snaps back with no explanation.
        toast(res.error, "error");
        return;
      }
      // Sakana Fugu easter egg: blow the fugu horn when a Fugu model is picked.
      if (res.model.startsWith("fugu")) playSound("fugu");
      setState((s) =>
        s
          ? {
              ...s,
              provider: res.provider,
              model: res.model,
              thinkingLevel: res.thinkingLevel,
              supportedThinkingLevels: res.supportedThinkingLevels,
            }
          : s,
      );
    });
  }

  function cyclePermission(): void {
    const from = currentPill(state?.permissionMode, state?.planMode);
    const next = nextPill(from);
    // Plan only switches between runs; skip past it mid-run.
    const target = next === "plan" && running ? nextPill(next) : next;
    setPermissionMode(target)
      .then((r) =>
        setState((s) => (s ? { ...s, permissionMode: r.permissionMode, planMode: r.planMode } : s)),
      )
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
  }

  function answerApproval(id: string, decision: "allow" | "always" | "deny", note?: string): void {
    setState((s) =>
      s ? { ...s, pendingApprovals: (s.pendingApprovals ?? []).filter((a) => a.id !== id) } : s,
    );
    respondApproval(id, decision, note).catch((e: unknown) =>
      toast(`Couldn't answer: ${e instanceof Error ? e.message : String(e)}`, "error"),
    );
  }

  function changeUltracode(next: boolean): void {
    setState((s) => (s ? { ...s, ultracode: next } : s));
    setUltracode(next).catch(() => {
      setState((s) => (s ? { ...s, ultracode: !next } : s));
      toast("Couldn't change Ultracode. Try again.", "error");
    });
  }
  // Orchestrate: optimistic flip, reverted if the sidecar refuses (like Ultracode).
  function changeOrchestrate(next: boolean): void {
    const patch = (on: boolean) => (s: AgentState | null) =>
      s
        ? {
            ...s,
            orchestration: { workerModel: s.orchestration?.workerModel ?? null, orchestrate: on },
          }
        : s;
    setState(patch(next));
    setOrchestrate(next)
      .then((res) => setState((s) => (s ? { ...s, orchestration: res } : s)))
      .catch(() => {
        setState(patch(!next));
        toast("Couldn't change Orchestrate. Try again.", "error");
      });
  }
  // Verify loop: the control saves through the sidecar; this just mirrors the result.
  function changeVerify(next: VerifyState): void {
    setState((s) => (s ? { ...s, verify: next } : s));
  }
  // Worktree workers: the review popover saves the policy; this mirrors the result.
  function changeWorktreeWorkers(next: WorktreeWorkersState): void {
    setState((s) => (s ? { ...s, worktreeWorkers: next } : s));
  }
  // Compaction control: the gauge popover saves through the sidecar; this mirrors the result.
  function changeCompaction(next: CompactionState): void {
    setState((s) => (s ? { ...s, compaction: next } : s));
  }
  // The model Orchestrate's workers run on; null: they follow the main model.
  function onSelectWorkerModel(modelId: string | null): void {
    if (modelId === (state?.orchestration?.workerModel ?? null)) return;
    void setWorkerModel(modelId)
      .then((res) => setState((s) => (s ? { ...s, orchestration: res } : s)))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
  }

  return {
    onSelectKenModel,
    onSelectCritterModel,
    onSelectModel,
    onSelectWorkerModel,
    cyclePermission,
    answerApproval,
    changeUltracode,
    changeOrchestrate,
    changeVerify,
    changeWorktreeWorkers,
    changeCompaction,
  };
}
