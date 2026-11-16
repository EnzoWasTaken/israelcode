// Moved to @kenkaiiii/gg-core. This shim re-exports it so existing relative
// imports (`./thinking-level.js`) keep resolving unchanged.
export {
  getSupportedThinkingLevels,
  getLowestThinkingLevel,
  isThinkingLevelSupported,
  getNextThinkingLevel,
  clampThinkingForPlanMode,
  clampThinkingLevel,
} from "@kenkaiiii/gg-core";
