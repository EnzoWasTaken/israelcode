// Native orchestration in the composer: the per-prompt keyword (as the sidecar checks it).

/** A typed prompt asking to orchestrate just that prompt. */
export function hasOrchestrateKeyword(text: string): boolean {
  return /(^|[^\w-])orchestrate($|[^\w-])/i.test(text);
}
