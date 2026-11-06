// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  concatChunks,
  encodePcm16Base64,
  insertDictation,
  levelOf,
  loadDictationModel,
  micErrorMessage,
  resampleTo16k,
  saveDictationModel,
} from "./dictation";

afterEach(() => localStorage.clear());

describe("dictation audio", () => {
  it("joins chunks and resamples 48 kHz to 16 kHz", () => {
    const joined = concatChunks([
      new Float32Array([0, 0.3]),
      new Float32Array([0.6, 0.9, 1.2, 1.5]),
    ]);
    expect(joined.length).toBe(6);
    const out = resampleTo16k(joined, 48_000);
    expect(out.length).toBe(2);
    expect(out[1]).toBeCloseTo(0.9, 5);
    expect(resampleTo16k(joined, 16_000)).toBe(joined);
  });

  it("encodes clipped little-endian Int16 as base64", () => {
    const bytes = Uint8Array.from(atob(encodePcm16Base64(new Float32Array([0, 1, -1, 2]))), (c) =>
      c.charCodeAt(0),
    );
    const view = new DataView(bytes.buffer);
    expect([0, 2, 4, 6].map((o) => view.getInt16(o, true))).toEqual([0, 32767, -32768, 32767]);
  });

  it("reads silence as no level", () => {
    expect(levelOf(new Float32Array(10))).toBe(0);
    expect(levelOf(new Float32Array([0.5, -0.5]))).toBe(1);
  });
});

describe("insertDictation", () => {
  it("spaces the text from its neighbours and moves the caret after it", () => {
    expect(insertDictation("fix the", 7, "login bug")).toEqual({
      value: "fix the login bug",
      caret: 17,
    });
    expect(insertDictation("ab", 1, "X")).toEqual({ value: "a X b", caret: 3 });
    expect(insertDictation("", 0, "hello")).toEqual({ value: "hello", caret: 5 });
  });
});

describe("dictation settings and errors", () => {
  it("remembers a valid model and ignores junk", () => {
    expect(loadDictationModel()).toBe("base.en");
    saveDictationModel("small");
    expect(loadDictationModel()).toBe("small");
    localStorage.setItem("israelcode-dictation-model", "huge");
    expect(loadDictationModel()).toBe("base.en");
  });

  it("explains a blocked or missing microphone", () => {
    expect(micErrorMessage({ name: "NotAllowedError" })).toContain("blocked");
    expect(micErrorMessage({ name: "NotFoundError" })).toContain("No microphone");
  });
});
