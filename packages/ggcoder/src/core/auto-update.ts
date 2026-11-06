// The update engine now lives in @kenkaiiii/gg-core. This module pins it to
// ggcoder's npm package + state file, keeping the "ggcoder"-branded surface and
// the same exported function names so consumers/tests are unchanged.
import path from "node:path";
import os from "node:os";
import { createAutoUpdater, APP_DIR_NAME } from "@kenkaiiii/gg-core";

const updater = createAutoUpdater({
  packageName: "@kenkaiiii/ggcoder",
  stateFilePath: () => path.join(os.homedir(), APP_DIR_NAME, "update-state.json"),
});

// Israel Code isn't published to npm: an update would install upstream GG Coder over it.
function enabled(): boolean {
  return process.env.ISRAELCODE_NPM_AUTO_UPDATE === "1";
}

export const checkAndAutoUpdate = (currentVersion: string): string | null =>
  enabled() ? updater.checkAndAutoUpdate(currentVersion) : null;
export const getPendingUpdate = (currentVersion: string): { latestVersion: string } | null =>
  enabled() ? updater.getPendingUpdate(currentVersion) : null;
export const startPeriodicUpdateCheck = (
  currentVersion: string,
  onUpdate: (message: string) => void,
): void => {
  if (enabled()) updater.startPeriodicUpdateCheck(currentVersion, onUpdate);
};
export const stopPeriodicUpdateCheck = updater.stopPeriodicUpdateCheck;
