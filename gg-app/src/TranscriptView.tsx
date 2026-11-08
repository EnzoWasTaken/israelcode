import type { ComponentProps, ReactElement, RefObject } from "react";
import { retryWindowSession, type AgentState, type ModelOption, type WorkspaceMode } from "./agent";
import { KenPowerBanner } from "./KenPowerBanner";
import { LiveTextContext, type LiveTextStore } from "./live-text";
import { PromptSendProvider } from "./Markdown";
import { ModelSelect } from "./ModelSelect";
import { TranscriptSkeleton } from "./Skeleton";
import { theme } from "./theme";
import { toast } from "./toast";
import type { Item } from "./transcript-item";
import type { createEntranceLifetime } from "./transcript-motion";
import { emptyTranscriptStatus } from "./transcript-status";
import { TranscriptJumpControls } from "./TranscriptJumpControls";
import { TranscriptRow } from "./TranscriptRow";
import { UltracodePhases } from "./UltracodePhases";
import type { UltracodePhase } from "./ultracode-phases";
import type { useTranscriptScroll } from "./useTranscriptScroll";
import { WakeScreen } from "./WakeScreen";

type RowProps = ComponentProps<typeof TranscriptRow>;

/**
 * The conversation: its non-scrolling frame, the scrolling transcript of rows
 * (or the skeleton, connect error and wake screen while it is empty) and the
 * jump controls. Presentational; App.tsx owns the state. Row entrances are
 * consumed here through App's entrance lifetime (transcript-motion.ts).
 */
export function TranscriptView({
  transcriptFrameRef,
  attachTranscript,
  scroll,
  workspaceMode,
  kenPowerBanner,
  onKenPowerBannerDone,
  hydrated,
  items,
  connectError,
  onRetried,
  status,
  state,
  sendKenRecommendedPrompt,
  liveText,
  ultracodePhaseMap,
  chatView,
  liveFromId,
  entrances,
  talkingKenId,
  currentErrorId,
  models,
  onSelectKenModel,
  onSelectModel,
  modelSwitchDisabled,
  answerAsk,
  typeAskInstead,
  onRewind,
  shellActions,
}: {
  transcriptFrameRef: RefObject<HTMLDivElement | null>;
  attachTranscript: (el: HTMLDivElement | null) => void;
  scroll: ReturnType<typeof useTranscriptScroll>;
  workspaceMode: WorkspaceMode;
  kenPowerBanner: "on" | "off" | null;
  onKenPowerBannerDone: () => void;
  hydrated: boolean;
  items: Item[];
  connectError: string | null;
  onRetried: () => void;
  status: string;
  state: AgentState | null;
  sendKenRecommendedPrompt: (text: string) => Promise<boolean>;
  liveText: LiveTextStore;
  ultracodePhaseMap: Map<number, UltracodePhase[]>;
  chatView: RowProps["view"];
  liveFromId: number;
  entrances: ReturnType<typeof createEntranceLifetime>;
  talkingKenId: number | null;
  currentErrorId: number | null;
  models: ModelOption[];
  onSelectKenModel: (modelId: string | null) => void;
  onSelectModel: (modelId: string, options?: { confirmPaid?: boolean }) => void;
  modelSwitchDisabled: boolean;
  answerAsk: RowProps["onAskAnswer"];
  typeAskInstead: RowProps["onAskType"];
  onRewind: RowProps["onRewind"];
  shellActions: RowProps["shellActions"];
}): ReactElement {
  const {
    onTranscriptScroll,
    onTranscriptWheel,
    visibleItems,
    firstNewId,
    newMarkerRef,
    following,
    askPlace,
    jumpToLatest,
    jumpToNew,
    jumpToAsk,
    maybeScrollToBottom,
  } = scroll;
  return (
    <div ref={transcriptFrameRef} className="transcript-frame">
      {workspaceMode === "code" && kenPowerBanner && (
        <KenPowerBanner mode={kenPowerBanner} onDone={onKenPowerBannerDone} />
      )}
      <div
        className="transcript"
        ref={attachTranscript}
        onScroll={onTranscriptScroll}
        onWheel={onTranscriptWheel}
      >
        {!hydrated && items.length === 0 ? (
          <TranscriptSkeleton />
        ) : (
          <>
            {items.length === 0 &&
              (connectError !== null ? (
                <div className="picker-empty transcript-reveal" role="alert">
                  <span>Couldn't connect to the agent.</span>
                  <span style={{ color: theme.textDim }}>{connectError}</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      // Restart the failed start first so the re-hydrate
                      // waits on a fresh attempt, not the recorded failure.
                      void retryWindowSession()
                        .catch((e: unknown) =>
                          toast(
                            `Couldn't restart the agent: ${e instanceof Error ? e.message : String(e)}`,
                            "error",
                          ),
                        )
                        .finally(onRetried);
                    }}
                  >
                    Try again
                  </button>
                </div>
              ) : status === "ready" ? (
                <WakeScreen
                  chat={workspaceMode === "chat"}
                  motion={workspaceMode === "motion"}
                  goals={Boolean(state?.goal)}
                />
              ) : emptyTranscriptStatus(status) ? (
                <div className="line transcript-reveal" style={{ color: theme.textDim }}>
                  {`\u273b ${emptyTranscriptStatus(status)}`}
                </div>
              ) : null)}
            <PromptSendProvider value={sendKenRecommendedPrompt}>
              <LiveTextContext.Provider value={liveText}>
                {visibleItems.flatMap((it) => {
                  const phases = it.kind === "user" ? ultracodePhaseMap.get(it.id) : undefined;
                  const row = (
                    <TranscriptRow
                      key={it.id}
                      item={it}
                      view={chatView}
                      animateIn={it.id >= liveFromId}
                      consumeEntrance={entrances.consume}
                      kenTalking={it.id === talkingKenId}
                      mainModel={state?.model}
                      errorActive={it.id === currentErrorId}
                      errorModelPicker={
                        it.kind === "error" && it.id === currentErrorId ? (
                          <ModelSelect
                            models={models}
                            currentModel={
                              it.scope === "ken_error" || it.scope === "autopilot_error"
                                ? (state?.kenModel ?? state?.model ?? "")
                                : (state?.model ?? "")
                            }
                            onSelect={
                              it.scope === "ken_error" || it.scope === "autopilot_error"
                                ? onSelectKenModel
                                : onSelectModel
                            }
                            disabled={modelSwitchDisabled}
                            title={
                              it.scope === "ken_error" || it.scope === "autopilot_error"
                                ? "Switch Israel's model"
                                : "Switch model"
                            }
                            label={it.reason === "usage_limit" ? "Switch provider" : "Choose model"}
                            color={theme.primary}
                          />
                        ) : undefined
                      }
                      onContentGrow={maybeScrollToBottom}
                      onAskAnswer={answerAsk}
                      onAskType={typeAskInstead}
                      onRewind={onRewind}
                      shellActions={shellActions}
                    />
                  );
                  // Zero-height landing spot for "You have new chats". A flat
                  // keyed list, so rows never remount when it comes and goes.
                  return it.id === firstNewId
                    ? [
                        <div
                          key="new-marker"
                          ref={newMarkerRef}
                          className="transcript-new-marker"
                          aria-hidden="true"
                        />,
                        row,
                        ...(phases
                          ? [<UltracodePhases key={`uc-${it.id}`} phases={phases} />]
                          : []),
                      ]
                    : phases
                      ? [row, <UltracodePhases key={`uc-${it.id}`} phases={phases} />]
                      : [row];
                })}
              </LiveTextContext.Provider>
            </PromptSendProvider>
          </>
        )}
      </div>
      {items.length > 0 && (
        <TranscriptJumpControls
          away={!following}
          hasNew={firstNewId !== null}
          askAt={askPlace === "above" || askPlace === "below" ? askPlace : null}
          onScrollToBottom={jumpToLatest}
          onJumpToNew={jumpToNew}
          onJumpToAsk={jumpToAsk}
        />
      )}
    </div>
  );
}
