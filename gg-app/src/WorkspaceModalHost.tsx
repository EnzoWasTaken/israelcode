import type { ComponentProps, Dispatch, ReactElement, SetStateAction } from "react";
import type { WorkspaceMode } from "./agent";
import { ConfirmModal } from "./ConfirmModal";
import type { DeckPanelId } from "./Deck";
import { InitGitModal } from "./InitGitModal";
import { McpElicitModal } from "./McpElicitModal";
import type { createPlanReviewActions } from "./plan-review-actions";
import { PlanReviewModal } from "./PlanReviewModal";
import { RewindModal } from "./RewindModal";
import { SettingsModal } from "./SettingsModal";
import { Toaster } from "./Toaster";
import { TrophyUnlock } from "./TrophyUnlock";
import type { useTrophies } from "./useTrophies";

/**
 * Everything a workspace shows over itself: Rewind, Initialize Git, the
 * new-session confirmation, MCP input requests, plan review, tray Settings,
 * toasts and trophy unlocks. Presentational; App.tsx owns the state.
 */
export function WorkspaceModalHost({
  workspaceMode,
  rewindAt,
  setRewindAt,
  rewindAvailable,
  onRewound,
  showInitGit,
  setShowInitGit,
  defaultRepoName,
  submitText,
  confirmNewSession,
  setConfirmNewSession,
  newSessionBusy,
  startNewSession,
  planReview,
  planReviewAttempt,
  autopilotReviewing,
  planActions,
  showTraySettings,
  closeTraySettings,
  trophies,
  setDeckPanel,
}: {
  workspaceMode: WorkspaceMode;
  rewindAt: string | null;
  setRewindAt: Dispatch<SetStateAction<string | null>>;
  rewindAvailable: boolean;
  onRewound: ComponentProps<typeof RewindModal>["onRewound"];
  showInitGit: boolean;
  setShowInitGit: Dispatch<SetStateAction<boolean>>;
  defaultRepoName: string;
  submitText: (text: string, label?: string) => boolean;
  confirmNewSession: boolean;
  setConfirmNewSession: Dispatch<SetStateAction<boolean>>;
  newSessionBusy: boolean;
  startNewSession: () => Promise<void>;
  planReview: string | null;
  planReviewAttempt: number;
  autopilotReviewing: boolean;
  planActions: ReturnType<typeof createPlanReviewActions>;
  showTraySettings: boolean;
  closeTraySettings: () => void;
  trophies: ReturnType<typeof useTrophies>;
  setDeckPanel: Dispatch<SetStateAction<DeckPanelId | null>>;
}): ReactElement {
  return (
    <>
      {rewindAt !== null && rewindAvailable && (
        <RewindModal
          initialPrompt={rewindAt || undefined}
          onClose={() => setRewindAt(null)}
          onRewound={onRewound}
        />
      )}

      {workspaceMode === "code" && showInitGit && (
        <InitGitModal
          defaultName={defaultRepoName}
          onClose={() => setShowInitGit(false)}
          onInitialize={(prompt) => {
            setShowInitGit(false);
            submitText(prompt, "Initializing Git\u2026");
          }}
        />
      )}

      {confirmNewSession && (
        <ConfirmModal
          title={workspaceMode === "chat" ? "New Chat" : "New Session"}
          // Nothing is cleared: `newSession()` writes a NEW session file and
          // leaves the old one on disk, still listed and re-openable. Saying
          // "will be cleared" made a safe action read as destructive.
          message="Start fresh? This conversation stays saved."
          confirmLabel={workspaceMode === "chat" ? "New Chat" : "New Session"}
          busy={newSessionBusy}
          onConfirm={() => void startNewSession()}
          onClose={() => setConfirmNewSession(false)}
        />
      )}

      {/* Always mounted: an MCP server can ask for input at any moment, in any
          workspace mode, and its tool call stays blocked until we answer. */}
      <McpElicitModal />

      {workspaceMode === "code" && planReview !== null && (
        <PlanReviewModal
          key={planReviewAttempt}
          content={planReview}
          // Autopilot Ken reviews submitted plans himself; the indicator tells
          // the user, but manual Accept/Reject stays live and always wins.
          kenReviewing={autopilotReviewing}
          onAccept={planActions.acceptPlan}
          onFeedback={planActions.sendPlanFeedback}
          onReject={planActions.rejectPlan}
        />
      )}

      {/* Settings reached from the menu-bar tray. Rendered in every view branch
          (Home, picker, workspace) because the tray targets a WINDOW and can't
          know which of the three it is showing. */}
      {showTraySettings && <SettingsModal onClose={closeTraySettings} />}

      {/* Workspace toasts (saved transcript, Remote on/off, rank-up) need their
          own host: the one in the Home/Settings branch isn't mounted here. */}
      <Toaster />

      {/* One trophy at a time, in the order earned; it files itself into the
          deck's trophies key, so it only plays where the deck is. */}
      {trophies.queue[0] && (
        <TrophyUnlock
          key={trophies.queue[0].id}
          trophy={trophies.queue[0]}
          snapshot={trophies.snapshot}
          onOpenTrophies={() => setDeckPanel("trophies")}
          onDone={trophies.shift}
        />
      )}
    </>
  );
}
