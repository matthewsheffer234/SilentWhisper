import { jest } from '@jest/globals';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { cosineSimilarity, computeSentimentScore, _resetAnchorCacheForTests } from '../src/search/sentimentService.js';

// FEATURE_REQUEST.md's Admin Analytics Dashboard entry, "aggregate
// semantic/sentiment trend". cosineSimilarity is pure/deterministic and
// unit-testable directly; computeSentimentScore's only external dependency
// is embedText's outbound fetch (mocked here, same convention
// embeddingWorker.test.js already uses), never a real network call.

beforeEach(async () => {
  await resetDb(db);
  _resetAnchorCacheForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

describe('cosineSimilarity', () => {
  test('identical vectors score 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  test('orthogonal vectors score 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test('opposite vectors score -1', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
  });

  test('a zero vector scores 0, not NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

function embeddingResponse(embedding) {
  return { ok: true, status: 200, json: async () => ({ embedding }) };
}

// Deterministic, dimension-correct (config.embedding.dimension) vectors —
// the adapter itself rejects a mismatched dimension, so a toy 2-element
// array would fail before reaching the math this test actually verifies.
function vec(seed, dimension = config.embedding.dimension) {
  return Array.from({ length: dimension }, (_, i) => Math.sin(seed + i));
}

describe('computeSentimentScore', () => {
  test('equals cosineSimilarity(embedding, positiveAnchor) - cosineSimilarity(embedding, negativeAnchor)', async () => {
    const positiveVec = vec(1);
    const negativeVec = vec(2);
    const messageVec = vec(3);

    jest.spyOn(global, 'fetch').mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.prompt === config.sentiment.positiveAnchors) return embeddingResponse(positiveVec);
      if (body.prompt === config.sentiment.negativeAnchors) return embeddingResponse(negativeVec);
      throw new Error(`Unexpected embed prompt: ${body.prompt}`);
    });

    const score = await computeSentimentScore(db, messageVec);
    const expected = cosineSimilarity(messageVec, positiveVec) - cosineSimilarity(messageVec, negativeVec);
    expect(score).toBeCloseTo(expected);
  });

  test('anchor embeddings are computed once and cached — exactly two adapter calls total across many scored messages', async () => {
    let calls = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, opts) => {
      calls += 1;
      const body = JSON.parse(opts.body);
      if (body.prompt === config.sentiment.positiveAnchors) return embeddingResponse(vec(10));
      if (body.prompt === config.sentiment.negativeAnchors) return embeddingResponse(vec(20));
      throw new Error(`Unexpected embed prompt: ${body.prompt}`);
    });

    await computeSentimentScore(db, vec(1));
    await computeSentimentScore(db, vec(2));
    await computeSentimentScore(db, vec(3));

    // computeSentimentScore never re-embeds its `embedding` argument — the
    // only adapter calls it can ever trigger are the two anchor embeddings,
    // and only once each, regardless of how many messages are scored.
    expect(calls).toBe(2);
  });
});
