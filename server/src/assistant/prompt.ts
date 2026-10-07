/**
 * Prompt construction for the support assistant. The system message carries
 * the rules + the sentinel contract; the user message carries the retrieved
 * entries and the customer question. Kept in one file so the eval script can
 * point at "the prompt" (configuration B compares prompt variants if desired).
 */
import type { RetrievedEntry } from '../types.js';
import { estimateTokens } from '../lib/tokenize.js';

export function buildMessages(
  message: string,
  retrieved: RetrievedEntry[],
  intentNames: string[],
): { system: string; user: string } {
  const kb = retrieved
    .map((r, i) => `[${i + 1}] (intent: ${r.entry.intent})\nQ: ${r.entry.question}\nA: ${r.entry.answer}`)
    .join('\n\n');

  const system = [
    'You are the customer support assistant for an online store.',
    'Answer the customer using ONLY the knowledge base entries provided.',
    'Rules:',
    '- Be concise and helpful (2-4 sentences).',
    '- Do not invent policies, numbers, or procedures that are not in the entries.',
    '- If none of the entries are relevant to the question, say you cannot help with this, and set confidence low.',
    'After your answer, output one final line in exactly this format:',
    '<<<META intent=<one intent name from the entries> confidence=<number between 0.00 and 1.00>>>',
  ].join('\n');

  const user = [
    'Knowledge base entries:',
    kb || '(no entries)',
    '',
    `Customer question: ${message}`,
  ].join('\n');

  void intentNames;
  return { system, user };
}

/** Pre-flight token estimate for the quota reservation. */
export function estimatePromptTokens(system: string, user: string): number {
  return estimateTokens(system) + estimateTokens(user);
}
