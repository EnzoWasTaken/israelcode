import { describe, expect, it, beforeEach } from "vitest";
import sharp from "sharp";
import { downscaleForPreview } from "../utils/image.js";
import { clearPreviewCache, previewBase64, warmPreviews } from "./preview-cache.js";

async function png(width: number): Promise<string> {
  const buf = await sharp({
    create: { width, height: 40, channels: 3, background: { r: 10, g: 200, b: 30 } },
  })
    .png()
    .toBuffer();
  return buf.toString("base64");
}

describe("preview cache", () => {
  beforeEach(() => clearPreviewCache());

  it("returns exactly the uncached preview, and reuses it", async () => {
    const data = await png(1600);
    const expected = (await downscaleForPreview(Buffer.from(data, "base64"))).toString("base64");
    const first = previewBase64(data);
    expect(previewBase64(data)).toBe(first);
    expect(await first).toBe(expected);
  });

  it("warms every image without rejecting", async () => {
    const images = [await png(100), await png(1200), "not an image"];
    await expect(warmPreviews(images)).resolves.toBeUndefined();
    expect(await previewBase64(images[0]!)).toBe(images[0]);
  });
});
