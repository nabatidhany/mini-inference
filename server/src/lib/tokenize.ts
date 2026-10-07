/**
 * Token estimation, used in two places:
 *  1. pre-flight quota reservation (prompt cost is knowable before the call)
 *  2. usage accounting for the extractive backend (no provider to report from)
 * The real model path prefers the provider-reported usage (see groq.ts), so
 * metered numbers are accurate where accuracy is possible, estimated elsewhere.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
