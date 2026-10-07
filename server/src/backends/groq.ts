/**
 * Real model backend: Groq (OpenAI-compatible chat completions, streaming,
 * usage reported by the provider -> accurate metering). The exact provider is
 * a config detail; any OpenAI-compatible endpoint works.
 */
import { config } from '../config.js';
import { estimateTokens } from '../lib/tokenize.js';
import type { BackendEvent, ChatBackend, ChatTask } from './types.js';

interface GroqChunk {
  choices?: { delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createGroqBackend(): ChatBackend {
  return {
    id: 'groq',
    model: `groq/${config.groqModel}`,

    async *streamChat(task: ChatTask, signal: AbortSignal): AsyncGenerator<BackendEvent> {
      if (!config.groqApiKey) throw new Error('GROQ_NOT_CONFIGURED');

      const res = await fetch(`${config.groqBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.groqApiKey}`,
        },
        body: JSON.stringify({
          model: config.groqModel,
          messages: [
            { role: 'system', content: task.system },
            { role: 'user', content: task.user },
          ],
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.2,
          max_completion_tokens: config.completionBudget,
          ...(config.groqModel.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GROQ_HTTP_${res.status}:${body.slice(0, 300)}`);
      }
      if (!res.body) throw new Error('GROQ_EMPTY_BODY');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let sawDone = false;
      let promptTokens = 0;
      let completionTokens = 0;
      let usageSource: 'provider' | 'estimated' = 'estimated';
      let fullAnswer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl = buf.indexOf('\n');
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              sawDone = true;
              continue;
            }
            let chunk: GroqChunk;
            try {
              chunk = JSON.parse(payload) as GroqChunk;
            } catch {
              continue; // tolerate stray keep-alive fragments
            }
            const text = chunk.choices?.[0]?.delta?.content;
            if (typeof text === 'string' && text.length > 0) {
              fullAnswer += text;
              yield { type: 'delta', text };
            }
            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens ?? 0;
              completionTokens = chunk.usage.completion_tokens ?? 0;
              usageSource = 'provider';
            }
          }
        }

        if (!sawDone && fullAnswer === '') throw new Error('GROQ_STREAM_ENDED_EMPTY');

        if (usageSource === 'estimated') {
          // provider did not report usage -> documented estimation fallback
          promptTokens = estimateTokens(task.system) + estimateTokens(task.user);
          completionTokens = estimateTokens(fullAnswer);
        }
        yield { type: 'usage', promptTokens, completionTokens, source: usageSource };
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
}
