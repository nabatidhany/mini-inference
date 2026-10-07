/** Backend contract: every backend (real model or extractive) looks identical to the router. */

export interface DeltaEvent {
  type: 'delta';
  text: string;
}

export interface UsageReport {
  type: 'usage';
  promptTokens: number;
  completionTokens: number;
  source: 'provider' | 'estimated';
}

export type BackendEvent = DeltaEvent | UsageReport;

export interface ChatTask {
  system: string;
  user: string;
  /** Verbatim top-retrieved KB answer — the extractive backend serves this. */
  extractiveAnswer?: string;
}

export interface ChatBackend {
  id: string;
  /** Metered model id (also the price-table key). */
  model: string;
  streamChat(task: ChatTask, signal: AbortSignal): AsyncGenerator<BackendEvent>;
}
