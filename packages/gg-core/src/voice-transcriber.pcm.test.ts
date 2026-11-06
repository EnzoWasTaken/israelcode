import { beforeEach, describe, expect, it, vi } from "vitest";

const asr = vi.fn(async () => ({ text: "  hello world  " }));
const pipeline = vi.fn(
  async (_task: string, _model: string, opts: { progress_callback?: (i: unknown) => void }) => {
    opts.progress_callback?.({ status: "progress", progress: 50, file: "model.onnx" });
    return asr;
  },
);
vi.mock("@huggingface/transformers", () => ({ pipeline }));

const { transcribePcm, int16Base64ToFloat32, MAX_DICTATION_SECONDS, isWhisperModel } =
  await import("./voice-transcriber.js");

beforeEach(() => {
  asr.mockClear();
});

describe("transcribePcm", () => {
  it("loads the chosen model once, reports progress, and trims the text", async () => {
    const progress = vi.fn();
    const pcm = new Float32Array(16000);
    expect(await transcribePcm(pcm, { model: "base", onProgress: progress })).toBe("hello world");
    expect(await transcribePcm(pcm, { model: "base" })).toBe("hello world");
    const loads = pipeline.mock.calls.filter((c) => c[1] === "Xenova/whisper-base");
    expect(loads).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 50 }));
    expect(asr).toHaveBeenCalledWith(pcm, expect.objectContaining({ chunk_length_s: 30 }));
  });

  it("skips silence and refuses takes over the limit", async () => {
    expect(await transcribePcm(new Float32Array(0))).toBe("");
    await expect(
      transcribePcm(new Float32Array(MAX_DICTATION_SECONDS * 16000 + 1)),
    ).rejects.toThrow("limited to");
    expect(asr).not.toHaveBeenCalled();
  });

  it("retries a model whose download failed", async () => {
    pipeline.mockRejectedValueOnce(new Error("offline"));
    await expect(transcribePcm(new Float32Array(10), { model: "small" })).rejects.toThrow(
      "offline",
    );
    expect(await transcribePcm(new Float32Array(10), { model: "small" })).toBe("hello world");
  });
});

describe("int16Base64ToFloat32", () => {
  it("decodes little-endian Int16 samples to [-1, 1)", () => {
    const bytes = Buffer.alloc(6);
    bytes.writeInt16LE(0, 0);
    bytes.writeInt16LE(16384, 2);
    bytes.writeInt16LE(-32768, 4);
    expect([...int16Base64ToFloat32(bytes.toString("base64"))]).toEqual([0, 0.5, -1]);
  });

  it("knows the offered model names", () => {
    expect(isWhisperModel("base.en")).toBe(true);
    expect(isWhisperModel("large")).toBe(false);
    expect(isWhisperModel("toString")).toBe(false);
  });
});
