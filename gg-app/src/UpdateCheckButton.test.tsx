// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setFlavorEnabled } from "./flavor";

const checkNow = vi.fn();
const install = vi.fn();
const state = { phase: "idle", version: null as string | null, progress: null, install, checkNow };
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.107.0") }));
vi.mock("./update", () => ({ useAppUpdate: () => state }));

import { UpdateCheckButton } from "./UpdateCheckButton";

describe("UpdateCheckButton", () => {
  beforeEach(() => {
    setFlavorEnabled(false);
    state.phase = "idle";
    state.version = null;
    checkNow.mockReset();
    install.mockReset();
  });

  it("checks on click and says when the app is up to date", async () => {
    checkNow.mockResolvedValue("up-to-date");
    render(<UpdateCheckButton />);
    expect(await screen.findByText(/v0\.107\.0/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));
    });
    expect(checkNow).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("You're up to date.");
  });

  it("says when GitHub could not be reached", async () => {
    checkNow.mockResolvedValue("error");
    render(<UpdateCheckButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));
    });
    expect(screen.getByRole("status").textContent).toContain("Couldn't reach GitHub");
  });

  it("turns into Install once an update is pending", async () => {
    state.phase = "available";
    state.version = "0.108.0";
    render(<UpdateCheckButton />);
    expect(screen.getByRole("status").textContent).toContain("Update to 0.108.0 available.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /install update/i }));
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(checkNow).not.toHaveBeenCalled();
  });
});
