import { createHash } from "node:crypto";

/** Short, non-reversible digest for cache keys and diagnostics. */
export function shortHash(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
