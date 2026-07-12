import { config } from '../config.js';
import { getEffectiveSettings } from '../llm/settingsService.js';
import { getAdapter } from '../llm/adapterFactory.js';
import { tryAcquire, release } from './embeddingConcurrencyGate.js';
import { ServiceUnavailableError } from '../errors.js';

// Shared by the ingestion worker (search/embeddingWorker.js) and the search
// route's query-embedding step (routes/search.js) so both go through one
// concurrency budget and one provider-selection path (FEATURE_REQUEST.md
// entry 1). Reads the *live*, app_settings-overridable provider/baseUrl via
// getEffectiveSettings — the same function llm/aiService.js uses — so
// flipping LLM_PROVIDER via the AI Settings panel governs embeddings too,
// with no separate admin surface needed.
export async function embedText(db, text) {
  const settings = await getEffectiveSettings(db);

  if (settings.provider === 'disabled') {
    throw new ServiceUnavailableError('AI features are disabled on this deployment');
  }
  if (!tryAcquire(config.embedding.maxConcurrentRequests)) {
    throw new ServiceUnavailableError('Embedding service is at capacity, please try again shortly');
  }

  try {
    const adapter = getAdapter(settings.provider);
    const { embedding } = await adapter.embed({
      settings: {
        baseUrl: settings.baseUrl,
        apiKey: config.llm.apiKey,
        model: config.embedding.model,
        dimension: config.embedding.dimension,
        timeoutMs: config.embedding.timeoutMs,
      },
      text,
    });
    return embedding;
  } finally {
    release();
  }
}

// pgvector's wire format for an inserted/bound vector literal is a bracketed,
// comma-separated list of numbers — no native pgvector type is registered
// with the pg/knex driver, so this is passed as a plain string alongside a
// `::vector` cast at the call site (search/embeddingWorker.js,
// routes/search.js).
export function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}
