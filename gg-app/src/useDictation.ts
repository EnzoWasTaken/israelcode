import { useCallback, useEffect, useRef, useState } from "react";
import { subscribe, transcribe } from "./agent";
import {
  concatChunks,
  DICTATION_RATE,
  encodePcm16Base64,
  levelOf,
  loadDictationModel,
  MAX_DICTATION_SECONDS,
  micErrorMessage,
  MIN_DICTATION_SECONDS,
  resampleTo16k,
} from "./dictation";

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

interface Recording {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  limit: ReturnType<typeof setTimeout>;
}

/**
 * Mic → local Whisper → text. `toggle` starts and stops a take; the result is
 * handed to `onText`. `progress` is the first-use model download, 0–100.
 */
export function useDictation({
  onText,
  onError,
}: {
  onText: (text: string) => void;
  onError: (message: string) => void;
}): {
  state: DictationState;
  level: number;
  progress: number | null;
  toggle: () => void;
} {
  const [state, setState] = useState<DictationState>("idle");
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const recording = useRef<Recording | null>(null);
  const stateRef = useRef<DictationState>("idle");
  const callbacks = useRef({ onText, onError });
  useEffect(() => {
    callbacks.current = { onText, onError };
  });

  const set = useCallback((next: DictationState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(
    () =>
      subscribe((e) => {
        if (e.type !== "transcribe_progress") return;
        const d = e.data as { progress?: number; done?: boolean };
        setProgress(d.done ? null : typeof d.progress === "number" ? d.progress : null);
      }),
    [],
  );

  const release = useCallback((rec: Recording) => {
    clearTimeout(rec.limit);
    rec.processor.onaudioprocess = null;
    rec.source.disconnect();
    rec.processor.disconnect();
    for (const track of rec.stream.getTracks()) track.stop();
    void rec.context.close().catch(() => {});
  }, []);

  const stop = useCallback(async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    release(rec);
    setLevel(0);
    const pcm = resampleTo16k(concatChunks(rec.chunks), rec.context.sampleRate);
    if (pcm.length < MIN_DICTATION_SECONDS * DICTATION_RATE) {
      set("idle");
      return;
    }
    set("transcribing");
    try {
      const text = await transcribe(encodePcm16Base64(pcm), loadDictationModel());
      if (text) callbacks.current.onText(text);
    } catch (e) {
      callbacks.current.onError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      set("idle");
    }
  }, [release, set]);

  const start = useCallback(async () => {
    set("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      // ScriptProcessor needs no separate worklet file and runs in every webview we ship.
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (ev) => {
        const samples = new Float32Array(ev.inputBuffer.getChannelData(0));
        chunks.push(samples);
        setLevel(levelOf(samples));
      };
      source.connect(processor);
      processor.connect(context.destination);
      const limit = setTimeout(() => void stop(), MAX_DICTATION_SECONDS * 1000);
      recording.current = { stream, context, source, processor, chunks, limit };
      set("recording");
    } catch (e) {
      set("idle");
      callbacks.current.onError(micErrorMessage(e));
    }
  }, [set, stop]);

  const toggle = useCallback(() => {
    if (stateRef.current === "idle") void start();
    else if (stateRef.current === "recording") void stop();
  }, [start, stop]);

  useEffect(
    () => () => {
      if (recording.current) release(recording.current);
      recording.current = null;
    },
    [release],
  );

  return { state, level, progress, toggle };
}
