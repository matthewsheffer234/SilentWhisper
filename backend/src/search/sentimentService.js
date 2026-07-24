import { config } from '../config.js';
import { embedText } from './embeddingService.js';

// Admin Analytics Dashboard, sentiment tab (FEATURE_REQUEST.md, "aggregate
// semantic/sentiment trend"). A coarse, cheap proxy — embedding-similarity
// to a fixed anchor phrase — not a calibrated sentiment classifier; good
// for a directional trend line at aggregate scale, never a per-message
// judgment. Reuses the embedding search/embeddingWorker.js already
// computes per message rather than a second LLM call.

// Module-level cache, not per-call: the anchor phrases are static
// deployment config (config.sentiment.*), so their embeddings never change
// without a process restart — the same "a model change already requires a
// restart" reasoning config.embedding.dimension's own doc comment states.
let positiveAnchorEmbedding = null;
let negativeAnchorEmbedding = null;

// Pure, deterministic given fixed vectors — no DB/network access, directly
// unit-testable without mocking an adapter.
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Embedded once each, lazily, on first use — every call after the first
// (across every message the embedding worker ever processes) reuses the
// cached vectors and makes no further adapter call.
async function getAnchorEmbeddings(db) {
  if (!positiveAnchorEmbedding) {
    positiveAnchorEmbedding = await embedText(db, config.sentiment.positiveAnchors);
  }
  if (!negativeAnchorEmbedding) {
    negativeAnchorEmbedding = await embedText(db, config.sentiment.negativeAnchors);
  }
  return { positiveAnchorEmbedding, negativeAnchorEmbedding };
}

// Takes the message's own embedding as already computed by the caller
// (search/embeddingWorker.js) — never re-embeds the message content itself,
// so a message contributes exactly one adapter call total (its own
// embedding), not two, regardless of how many times sentiment is scored.
export async function computeSentimentScore(db, embedding) {
  const { positiveAnchorEmbedding: positive, negativeAnchorEmbedding: negative } = await getAnchorEmbeddings(db);
  return cosineSimilarity(embedding, positive) - cosineSimilarity(embedding, negative);
}

export function _resetAnchorCacheForTests() {
  positiveAnchorEmbedding = null;
  negativeAnchorEmbedding = null;
}
