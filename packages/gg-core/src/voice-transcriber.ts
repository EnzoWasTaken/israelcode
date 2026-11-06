/**
 * Voice note transcription using local Whisper model.
 * Uses @huggingface/transformers (pure JS/WASM) — no native deps, no API keys.
 * Model (~75MB) is downloaded on first use and cached locally.
 */

import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const TARGET_SAMPLE_RATE = 16000;
const MODEL_ID = "Xenova/whisper-tiny.en";

/** Whisper sizes offered for dictation. The `.en` ones are English-only; `base` and `small` detect the language. */
export const WHISPER_MODELS = {
  "tiny.en": "Xenova/whisper-tiny.en",
  "base.en": "Xenova/whisper-base.en",
  "small.en": "Xenova/whisper-small.en",
  base: "Xenova/whisper-base",
  small: "Xenova/whisper-small",
} as const;
export type WhisperModel = keyof typeof WHISPER_MODELS;
export const DEFAULT_DICTATION_MODEL: WhisperModel = "base.en";
/** Longest dictation accepted in one go, in seconds of 16 kHz audio. */
export const MAX_DICTATION_SECONDS = 180;

export function isWhisperModel(value: unknown): value is WhisperModel {
  return typeof value === "string" && Object.hasOwn(WHISPER_MODELS, value);
}

const pipelines = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();
let transcriber: AutomaticSpeechRecognitionPipeline | null = null;

/** Optional callback for model download progress. */
export type ProgressCallback = (info: { status: string; progress?: number; file?: string }) => void;

let onProgress: ProgressCallback | null = null;

/** Set a callback to receive model download progress updates. */
export function setProgressCallback(cb: ProgressCallback | null): void {
  onProgress = cb;
}

/**
 * Resample audio from one sample rate to another using linear interpolation.
 */
export function resample(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return audio;
  const ratio = fromRate / toRate;
  const newLength = Math.round(audio.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, audio.length - 1);
    const frac = srcIndex - low;
    result[i] = audio[low]! * (1 - frac) + audio[high]! * frac;
  }
  return result;
}

/**
 * Downmix multi-channel audio to mono by averaging all channels.
 */
export function downmixToMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) return new Float32Array();
  if (channelData.length === 1) return channelData[0]!;

  const samples = channelData[0]!.length;
  const out = new Float32Array(samples);
  const scale = 1 / channelData.length;
  for (let i = 0; i < samples; i++) {
    let mixed = 0;
    for (const channel of channelData) mixed += channel[i] ?? 0;
    out[i] = mixed * scale;
  }
  return out;
}

/**
 * Decode OGG Opus audio buffer to 16kHz mono PCM Float32Array.
 */
export async function decodeOggOpus(buffer: Uint8Array): Promise<Float32Array> {
  const { OggOpusDecoder } = await import("ogg-opus-decoder");
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const decoded = await decoder.decodeFile(buffer);

    if (!decoded.channelData?.length || !decoded.channelData[0]?.length) {
      throw new Error("Decoded audio is empty");
    }

    const mono = downmixToMono(decoded.channelData);
    return resample(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  } finally {
    decoder.free();
  }
}

/**
 * Get or initialize the Whisper transcription pipeline.
 * Model is downloaded on first use and cached by transformers.js.
 */
async function getTranscriber(
  modelId: string = MODEL_ID,
  progress: ProgressCallback | null = onProgress,
): Promise<AutomaticSpeechRecognitionPipeline> {
  let loading = pipelines.get(modelId);
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const instance = await pipeline("automatic-speech-recognition", modelId, {
        dtype: "fp32",
        progress_callback: progress ?? undefined,
      });
      if (modelId === MODEL_ID) transcriber = instance;
      return instance;
    })();
    // A failed load (offline first use) must not stick: the next try downloads again.
    loading.catch(() => pipelines.delete(modelId));
    pipelines.set(modelId, loading);
  }
  return loading;
}

/**
 * Transcribe 16 kHz mono PCM recorded in the app (dictation). The model is
 * downloaded on first use, reporting progress, then runs fully offline.
 */
export async function transcribePcm(
  pcm: Float32Array,
  options: { model?: WhisperModel; onProgress?: ProgressCallback } = {},
): Promise<string> {
  if (pcm.length === 0) return "";
  if (pcm.length > MAX_DICTATION_SECONDS * TARGET_SAMPLE_RATE) {
    throw new Error(`Recordings are limited to ${MAX_DICTATION_SECONDS / 60} minutes.`);
  }
  const model = options.model ?? DEFAULT_DICTATION_MODEL;
  const asr = await getTranscriber(WHISPER_MODELS[model], options.onProgress ?? null);
  // Long takes go through in 30 s windows, Whisper's own input length.
  const result = await asr(pcm, { chunk_length_s: 30, stride_length_s: 5 });
  const text = Array.isArray(result) ? result[0]?.text : (result as { text: string }).text;
  return (text ?? "").trim();
}

/** Decode the app's base64 little-endian Int16 PCM into Float32 samples. */
export function int16Base64ToFloat32(data: string): Float32Array {
  const bytes = Buffer.from(data, "base64");
  const samples = Math.floor(bytes.length / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = bytes.readInt16LE(i * 2) / 0x8000;
  return out;
}

/** Whether the model has been loaded already. */
export function isModelLoaded(): boolean {
  return transcriber !== null;
}

/**
 * Transcribe a voice message from its Telegram file URL.
 * Downloads the OGG Opus file, decodes to PCM, and runs Whisper locally.
 */
export async function transcribeVoice(fileUrl: string): Promise<string> {
  // Download the audio file. Bounded so a stalled download can't hang the
  // transcription (and the chat waiting on it) forever.
  const response = await fetch(fileUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Failed to download voice file: ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());

  // Decode OGG Opus → 16kHz mono PCM
  const pcm = await decodeOggOpus(buffer);

  // Transcribe with Whisper
  const asr = await getTranscriber();
  const result = await asr(pcm);

  const text = Array.isArray(result) ? result[0]?.text : (result as { text: string }).text;
  return (text ?? "").trim();
}
