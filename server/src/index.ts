/** Server entrypoint: app assembly, CORS, routes, seed-on-boot. */
import express from 'express';
import { config } from './config.js';
import { adminRouter } from './routes/admin.js';
import { chatRouter } from './routes/chat.js';
import { usageRouter } from './routes/usage.js';
import { seedIfEmpty } from './lib/seed.js';

const app = express();
app.use(express.json({ limit: '64kb' }));

// CORS (SSE responses inherit these headers; writeHead merges with them)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (config.corsOrigin === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin === config.corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-admin-key');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(chatRouter);
app.use(usageRouter);
app.use(adminRouter);

// 404 + error handler (invalid JSON bodies land here too)
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown route' } });
});
app.use((err: unknown, _req: unknown, res: express.Response, _next: unknown) => {
  const message = err instanceof Error ? err.message : 'unexpected error';
  if (res.headersSent) return;
  res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
});

seedIfEmpty();

if (!config.groqApiKey) {
  console.warn('[boot] GROQ_API_KEY not set — the real backend will fail until configured (fallback/extractive still works).');
}

app.listen(config.port, () => {
  console.log(`[boot] inference gateway listening on :${config.port}`);
});
