// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ setVerify: vi.fn(), runVerify: vi.fn() }));
vi.mock("./agent", () => ({
  setVerify: calls.setVerify,
  runVerify: calls.runVerify,
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

import { VerifyControl, formatVerifyCommands, parseVerifyCommands } from "./VerifyControl";
import type { VerifyState } from "./agent";

afterEach(() => {
  cleanup();
  calls.setVerify.mockReset();
  calls.runVerify.mockReset();
});

const state: VerifyState = {
  enabled: false,
  running: false,
  config: { commands: [{ label: "test", command: "npm test" }], maxRounds: 3, source: "file" },
};

describe("parseVerifyCommands", () => {
  it("reads label: command lines and refuses incomplete ones", () => {
    expect(parseVerifyCommands("test: npm test\n\nlint: eslint . --fix\n")).toEqual([
      { label: "test", command: "npm test" },
      { label: "lint", command: "eslint . --fix" },
    ]);
    expect(parseVerifyCommands("npm test")).toBeNull();
    expect(parseVerifyCommands("test:")).toBeNull();
    expect(formatVerifyCommands([{ label: "a", command: "b" }])).toBe("a: b");
  });
});

describe("VerifyControl", () => {
  it("flips the switch through setVerify", async () => {
    calls.setVerify.mockResolvedValue({ ...state, enabled: true });
    const onChange = vi.fn();
    render(<VerifyControl verify={state} running={false} onChange={onChange} />);
    const key = screen.getByRole("switch", { name: "Verify" });
    expect(key.getAttribute("title")).toBe(
      "Run the project's checks after each change and fix failures, up to 3 rounds",
    );
    fireEvent.click(key);
    await waitFor(() => expect(calls.setVerify).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true })),
    );
  });

  it("saves the commands and the cap, and runs the checks now", async () => {
    calls.setVerify.mockResolvedValue(state);
    calls.runVerify.mockResolvedValue({ started: true });
    render(<VerifyControl verify={state} running={false} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify settings" }));
    fireEvent.change(screen.getByLabelText("Checks"), {
      target: { value: "test: npm test\ntypes: tsc --noEmit" },
    });
    fireEvent.change(screen.getByLabelText("Rounds (1–10)"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.setVerify).toHaveBeenCalledWith({
        commands: [
          { label: "test", command: "npm test" },
          { label: "types", command: "tsc --noEmit" },
        ],
        maxRounds: 2,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Run checks now" }));
    await waitFor(() => expect(calls.runVerify).toHaveBeenCalledOnce());
  });
});
