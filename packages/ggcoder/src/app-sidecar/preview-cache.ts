import { createHash } from "node:crypto";
import { downscaleForPreview } from "../utils/image.js";

/**
 * Daemon-wide cache of the downscaled previews `/history` sends for stored
 * tool images (screenshots, read images). Reopening a long chat used to decode
 * and resize every image again; the stored pixels never change, so the preview
 * is keyed by a hash of the image data and reused across windows and reopens.
 * Bounded by total preview size, least recently used first out.
 */
const MAX_CACHED_CHARS = 32 * 1024 * 1024;
/** How many previews are resized at once when warming a transcript. */
const WARM_CONCURRENCY = 4;

interface Entry {
  readonly preview: Promise<string>;
  chars: number;
}

const entries = new Map<string, Entry>();
let cachedChars = 0;

function keyOf(data: string): string {
  return `${data.length}:${createHash("sha1").update(data).digest("base64")}`;
}

function evict(): void {
  for (const [key, entry] of entries) {
    if (cachedChars <= MAX_CACHED_CHARS) return;
    entries.delete(key);
    cachedChars -= entry.chars;
  }
}

/**
 * Base64 of the preview for a base64 image: exactly what
 * `downscaleForPreview(Buffer.from(data, "base64")).toString("base64")` gives.
 */
export function previewBase64(data: string): Promise<string> {
  const key = keyOf(data);
  const hit = entries.get(key);
  if (hit) {
    entries.delete(key);
    entries.set(key, hit);
    return hit.preview;
  }
  const entry: Entry = {
    preview: downscaleForPreview(Buffer.from(data, "base64")).then((buf) => buf.toString("base64")),
    chars: 0,
  };
  entries.set(key, entry);
  entry.preview.then(
    (preview) => {
      if (entries.get(key) !== entry) return;
      entry.chars = preview.length;
      cachedChars += entry.chars;
      evict();
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return entry.preview;
}

/**
 * Start resizing these images a few at a time, so a transcript's previews are
 * ready (or cached) by the time the in-order history walk asks for them.
 * Never rejects; resolves when every preview has settled.
 */
export async function warmPreviews(datas: readonly string[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < datas.length) {
      await previewBase64(datas[next++]!).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, datas.length) }, worker));
}

/** Test hook: forget every cached preview. */
export function clearPreviewCache(): void {
  entries.clear();
  cachedChars = 0;
}
