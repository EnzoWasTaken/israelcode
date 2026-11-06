// Dictation helpers: the recording leaves the webview as 16 kHz mono Int16 PCM
// (base64), the input local Whisper expects. No encoder needed.
import type { DictationModel } from "./agent";

export const DICTATION_RATE = 16_000;
/** Matches gg-core MAX_DICTATION_SECONDS; recording stops itself here. */
export const MAX_DICTATION_SECONDS = 180;
/** Shorter than this is a mis-click, not speech. */
export const MIN_DICTATION_SECONDS = 0.3;

export const DICTATION_MODELS: ReadonlyArray<{ id: DictationModel; label: string }> = [
  { id: "tiny.en", label: "Tiny · English (40 MB, fastest)" },
  { id: "base.en", label: "Base · English (75 MB)" },
  { id: "small.en", label: "Small · English (250 MB, most accurate)" },
  { id: "base", label: "Base · any language (75 MB)" },
  { id: "small", label: "Small · any language (250 MB)" },
];
const MODEL_KEY = "israelcode-dictation-model";
export const DEFAULT_DICTATION_MODEL: DictationModel = "base.en";

export function loadDictationModel(): DictationModel {
  try {
    const saved = localStorage.getItem(MODEL_KEY);
    if (DICTATION_MODELS.some((m) => m.id === saved)) return saved as DictationModel;
  } catch {
    // Storage unavailable: use the default.
  }
  return DEFAULT_DICTATION_MODEL;
}

export function saveDictationModel(model: DictationModel): void {
  try {
    localStorage.setItem(MODEL_KEY, model);
  } catch {
    // Not saved; the choice still applies until the window reloads.
  }
}

/** Join recorded chunks into one buffer. */
export function concatChunks(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Linear resample to 16 kHz (the device usually records at 44.1 or 48 kHz). */
export function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === DICTATION_RATE) return input;
  const ratio = fromRate / DICTATION_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const low = Math.floor(src);
    const high = Math.min(low + 1, input.length - 1);
    const frac = src - low;
    out[i] = (input[low] ?? 0) * (1 - frac) + (input[high] ?? 0) * frac;
  }
  return out;
}

/** Float samples to little-endian Int16, base64 encoded. */
export function encodePcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A 0–1 loudness for the level meter (RMS, scaled so speech fills it). */
export function levelOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/** Put dictated text in the draft at the caret, spaced from its neighbours. */
export function insertDictation(
  draft: string,
  caret: number,
  text: string,
): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  return { value: before + inserted + after, caret: at + lead.length + text.length };
}

/** A friendly line for a microphone failure. */
export function micErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access is blocked. Allow Israel Code to use the microphone in your system settings.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No microphone found. Connect one and try again.";
  if (name === "NotReadableError") return "The microphone is busy in another app.";
  return `Couldn't use the microphone: ${error instanceof Error ? error.message : String(error)}`;
}
