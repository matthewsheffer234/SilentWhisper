import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function required(name, value) {
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// CHANGELOG.md / RUNBOOK.md "Enclave Upgrade": SILENTWHISPER_VERSION is the
// same tag docker-compose.enclave.yml uses to select which image is
// running — threaded into the container's environment (docker-compose.yml,
// docker-compose.enclave.yml) so a live instance can self-report exactly
// what an operator installed, via GET /health, without cross-referencing
// anything. Falls back to backend/package.json's own "version" field for
// local/dev runs where nothing sets the env var (a bare `node src/index.js`
// or `npm run dev`, neither of which goes through docker-compose).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendPackageVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;
const appVersion = process.env.SILENTWHISPER_VERSION || backendPackageVersion;

// Hoisted out of the llm block below so allowedLlmOrigins' default can
// reference the same value baseUrl uses, without duplicating the fallback.
const llmBaseUrl = process.env.LLM_BASE_URL || 'http://silent-whisper-ollama:11434';

// FEATURE_REQUEST.md entry 3: the inline-checkbox owner token's *key*
// (`[owner:: @user]` by default) is a configurable alias, not a hardcoded
// "assignee"/"owner" string — a deployment can rename the Markdown syntax
// without a code change. The *parsed*/internal field is always `owner`
// regardless of what this is set to. Hoisted (like llmBaseUrl above) so it
// can be validated once at module load, before config.tasks references it —
// it gets compiled into a RegExp (services/taskParser.js), so a malformed
// value fails loudly at startup rather than producing a broken or
// unexpectedly-permissive pattern silently.
const taskOwnerTokenAlias = process.env.TASK_OWNER_TOKEN_ALIAS || 'owner';
if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(taskOwnerTokenAlias)) {
  throw new Error(
    'TASK_OWNER_TOKEN_ALIAS must start with a letter and contain only letters, numbers, "_", or "-" (max 32 chars)',
  );
}

export const config = {
  version: appVersion,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8000),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  db: {
    // Least-privilege runtime role (Section 5, Database Access Rights).
    // Migrations run separately using PG*-prefixed admin credentials — see knexfile.js.
    host: required('PGHOST', process.env.PGHOST),
    port: Number(process.env.PGPORT || 5432),
    user: required('APP_DB_USER', process.env.APP_DB_USER),
    password: required('APP_DB_PASSWORD', process.env.APP_DB_PASSWORD),
    database: required('PGDATABASE', process.env.PGDATABASE),
    // Scalability Target (PROJECT_PLAN.md Section 2): default to 20, not
    // sized 1:1 with concurrent users — Node's event loop multiplexes many
    // connections through a small pool.
    poolMin: Number(process.env.PG_POOL_MIN || 2),
    poolMax: Number(process.env.PG_POOL_MAX || 20),
  },

  auth: {
    jwtSecret: required('JWT_SECRET', process.env.JWT_SECRET),
    // Embedded in each access token's header (kid). Bump this alongside
    // rotating JWT_SECRET so verification predictably rejects every token
    // signed under the old secret, rather than requiring a hard cutover
    // that logs everyone out at once with no way to distinguish why
    // (Section 3, Secrets & Configuration).
    jwtKeyId: process.env.JWT_KEY_ID || 'v1',
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTokenTtlMs: Number(process.env.REFRESH_TOKEN_TTL_MS || 30 * 24 * 60 * 60 * 1000), // 30 days
    bcryptSaltRounds: Math.max(12, Number(process.env.BCRYPT_SALT_ROUNDS || 12)),
  },

  llm: {
    // Env-var defaults for Section 4's `app_settings` `llm.*` keys — the
    // effective value at request time is these defaults overlaid by
    // whatever an admin has since saved to app_settings (see
    // llm/settingsService.js), except apiKey, which never has a
    // database-backed override (Section 3, Secrets & Configuration: no
    // secret ever lives in app_settings).
    provider: process.env.LLM_PROVIDER || 'ollama',
    baseUrl: llmBaseUrl,
    model: process.env.LLM_MODEL || 'mistral',
    // Optional — most local gateways (this Ollama container included) have
    // no auth in front of them; only set when a gateway requires it.
    apiKey: process.env.LLM_API_KEY || null,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 30_000),
    maxInputChars: Number(process.env.LLM_MAX_INPUT_CHARS || 12_000),
    maxOutputTokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS || 512),
    // Default low (Section 2/3): a CPU-only single Ollama instance
    // realistically serves close to one generation at a time before
    // requests queue for tens of seconds each. Raise once running against
    // GPU-backed vLLM.
    maxConcurrentRequests: Number(process.env.LLM_MAX_CONCURRENT_REQUESTS || 1),
    // Not an app_settings key — purely operational, like digestMaxWindowHours
    // below. Bounds concurrencyGate.js's FIFO wait queue (FEATURE_REQUEST.md
    // entry 2): a request beyond this depth still gets an immediate 503
    // rather than queuing indefinitely.
    queueMaxDepth: Number(process.env.AI_QUEUE_MAX_DEPTH || 8),
    temperature: Number(process.env.LLM_TEMPERATURE || 0.3),
    streamingEnabled: process.env.LLM_STREAMING_ENABLED !== 'false',
    // "v2" default (FEATURE_REQUEST.md entry 4, 2026-07-19): per-request
    // random nonce in the prompt delimiter markers plus JSON-serialized
    // message content, instead of v1's fixed, guessable marker strings —
    // see promptTemplates.js. Bumped from "v1" so historical audit rows
    // stay attributable to the prompt version that actually generated them.
    summaryPromptVersion: process.env.LLM_SUMMARY_PROMPT_VERSION || 'v2',
    taskPromptVersion: process.env.LLM_TASK_PROMPT_VERSION || 'v2',
    // Cross-channel workspace digest (FEATURE_REQUEST.md entry 6), same
    // versioned-template convention as summary/task prompts above.
    digestPromptVersion: process.env.LLM_DIGEST_PROMPT_VERSION || 'v2',
    // Not an app_settings key — an operational safety cap on how far back a
    // digest request can reach, deliberately env-only like embedding.*
    // below rather than admin-editable through the AI Settings panel.
    digestMaxWindowHours: Number(process.env.AI_DIGEST_MAX_WINDOW_HOURS || 336), // 14 days
    // Not an app_settings key — purely operational, how often the backend
    // pings the provider's health endpoint (Section 8, Phase 4).
    healthCheckIntervalMs: Number(process.env.LLM_HEALTH_CHECK_INTERVAL_MS || 60_000),
    // Not an app_settings key — deployment-controlled allowlist enforced by
    // validation.js's assertAllowedLlmUrl against the admin-editable
    // `baseUrl` setting (Security.md, 2026-07-15, MEDIUM: SSRF/global-AI-DoS
    // via an arbitrary admin-supplied baseUrl). Defaults to exactly
    // llmBaseUrl's own origin, so an out-of-the-box deployment keeps working
    // with zero extra config while nothing else is implicitly trusted; add
    // the target vLLM origin here (comma-separated) when moving to the
    // GPU-backed production network.
    allowedLlmOrigins: (process.env.ALLOWED_LLM_ORIGINS || llmBaseUrl)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => new URL(s).origin),
  },

  embedding: {
    // Semantic search (FEATURE_REQUEST.md entry 1). Deliberately reuses
    // llm.baseUrl/apiKey and the *live* app_settings-overridable provider
    // (read via llm/settingsService.getEffectiveSettings at call time, not
    // from this static config block) rather than duplicating them — flipping
    // LLM_PROVIDER via the AI Settings panel governs embeddings too. Only
    // the embedding-specific knobs below are env-only, with no
    // app_settings override: a deliberately narrower config surface than
    // generation settings (Section 4 doesn't list embedding.* as a required
    // app_settings key).
    model: process.env.EMBEDDING_MODEL || 'all-minilm',
    // Must match message_embeddings.embedding's vector(N) column
    // (database/migrations/0009_pgvector_and_embeddings.js) — changing this
    // to a model with a different output size requires a new migration, not
    // just an env change.
    dimension: Number(process.env.EMBEDDING_DIMENSION || 384),
    timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS || 15_000),
    // Separate from llm.maxConcurrentRequests (Configurable LLM Provider
    // Settings note in FEATURE_REQUEST.md entry 1: "so summarization latency
    // and embedding backlog do not starve each other") — see
    // search/embeddingConcurrencyGate.js.
    maxConcurrentRequests: Number(process.env.EMBEDDING_MAX_CONCURRENT_REQUESTS || 1),
    // How often the ingestion worker (search/embeddingWorker.js) polls
    // embedding_jobs, and how many pending rows it claims per tick.
    workerIntervalMs: Number(process.env.EMBEDDING_WORKER_INTERVAL_MS || 2_000),
    workerBatchSize: Number(process.env.EMBEDDING_WORKER_BATCH_SIZE || 3),
    // A job is dead-lettered (status='failed', left in place for
    // observability rather than deleted) once it has failed this many times.
    maxAttempts: Number(process.env.EMBEDDING_MAX_ATTEMPTS || 5),
  },

  messageSideEffects: {
    // FEATURE_REQUEST.md "hot path splitting" entry: mention-notification
    // writes and [[Entity]] linking moved off the message-send request/
    // socket-message path onto workers/messageSideEffectsWorker.js, which
    // polls message_side_effect_jobs on this interval. No external provider
    // is involved (unlike embedding.*, which throttles calls to an LLM
    // provider) — this is pure DB work plus an in-process WS push, so the
    // interval is tighter than embedding's default 2s: these jobs feed a
    // user-visible "you were mentioned" notification, where added lag is
    // more noticeable than for background search indexing.
    workerIntervalMs: Number(process.env.MESSAGE_SIDE_EFFECTS_WORKER_INTERVAL_MS || 1_000),
    workerBatchSize: Number(process.env.MESSAGE_SIDE_EFFECTS_WORKER_BATCH_SIZE || 10),
    // Same dead-letter convention as embedding.maxAttempts.
    maxAttempts: Number(process.env.MESSAGE_SIDE_EFFECTS_MAX_ATTEMPTS || 5),
  },

  tasks: {
    // See taskOwnerTokenAlias's own doc comment above (validated at module
    // load). Frontend mirrors this via VITE_TASK_OWNER_TOKEN_ALIAS
    // (frontend/.env.example, baked in at build time like VITE_API_URL) —
    // both must agree for the tokenizer to parse identically on both sides;
    // there is no runtime handshake between them.
    ownerTokenAlias: taskOwnerTokenAlias,
    // Bounds the workspace task dashboard's message scan (Section 2,
    // Scalability Target: never an unbounded scan) — a rolling window, not
    // full history. routes/tasks.js lets a caller narrow this per-request
    // via ?windowDays=, up to MAX_TASK_DASHBOARD_WINDOW_DAYS.
    dashboardWindowDays: Number(process.env.TASK_DASHBOARD_WINDOW_DAYS || 30),
  },

  dm: {
    // FEATURE_REQUEST.md entry 2: per-user auto-archive threshold for
    // DIRECT/GROUP_DM channels, applied only when a caller's own
    // users.dm_auto_archive_days is NULL (see routes/directMessages.js).
    // Env-overridable rolling window, same precedent as
    // tasks.dashboardWindowDays above.
    autoArchiveDefaultDays: Number(process.env.DM_AUTO_ARCHIVE_DEFAULT_DAYS || 90),
    // Upper bound assertBoundedInt enforces on a user's own override via
    // PATCH /api/auth/me/dm-settings.
    autoArchiveMaxDays: Number(process.env.DM_AUTO_ARCHIVE_MAX_DAYS || 3650),
  },

  adminAnalytics: {
    // Admin Analytics Dashboard, collaboration tab (FEATURE_REQUEST.md,
    // "collaboration structure and interaction trend"): a pair sharing at
    // or below this many channels is suppressed from the membership-overlap
    // graph entirely (not returned with a low count) — a deliberate
    // anti-inference control, since a single shared channel is common and
    // not a meaningful "bridge" signal. routes/adminAnalytics.js lets a
    // caller raise this per-request via ?minSharedChannels=.
    minSharedChannels: Number(process.env.ADMIN_ANALYTICS_MIN_SHARED_CHANNELS || 2),
  },

  sentiment: {
    // Admin Analytics Dashboard, sentiment tab (FEATURE_REQUEST.md,
    // "aggregate semantic/sentiment trend"): comma-separated anchor phrases
    // embedded once, lazily, on first use and cached in-process
    // (search/sentimentService.js) — a per-message tone score is the
    // difference between its embedding's cosine similarity to the positive
    // anchor text and to the negative one, reusing the embedding
    // search/embeddingWorker.js already computes for semantic search rather
    // than a second LLM call. A known cheap-but-approximate proxy, not a
    // calibrated classifier — surfaced as such in the UI, not just here.
    positiveAnchors: process.env.SENTIMENT_POSITIVE_ANCHORS || 'thanks, great work, appreciate it, sounds good',
    negativeAnchors: process.env.SENTIMENT_NEGATIVE_ANCHORS || 'frustrated, blocked, this is broken, not working',
    // A bucket with fewer than this many scored messages is dropped from a
    // sentiment-trend response entirely rather than returned as a
    // wide-variance average one terse or sarcastic message could dominate.
    minBucketMessages: Number(process.env.SENTIMENT_MIN_BUCKET_MESSAGES || 5),
  },

  ws: {
    // Configurable for reverse-proxy deployment (PROJECT_PLAN.md Section 8,
    // Phase 3: "Make the WebSocket path configurable").
    path: process.env.WS_PATH || '/ws',
    // A connection whose access token has expired and hasn't been renewed
    // via a fresh `authenticate` frame gets disconnected the next time this
    // sweep runs (Section 3, "Long-lived connections outlive the access
    // token"). Checked well inside the 15-minute access-token TTL.
    tokenExpirySweepIntervalMs: Number(process.env.WS_TOKEN_SWEEP_INTERVAL_MS || 30_000),
    // Presence heartbeat: a connection not heard from within this window is
    // downgraded from Online to Away (still connected, just stale) — server-
    // observed, never trusting a client-supplied timestamp (Section 6).
    presenceStaleMs: Number(process.env.WS_PRESENCE_STALE_MS || 45_000),
    presenceSweepIntervalMs: Number(process.env.WS_PRESENCE_SWEEP_INTERVAL_MS || 15_000),
    // Rate Limiting & Abuse Prevention (Section 3): bound both message-send
    // rate and total concurrent connections per user.
    maxMessagesPerWindow: Number(process.env.WS_MAX_MESSAGES_PER_WINDOW || 10),
    messageWindowMs: Number(process.env.WS_MESSAGE_WINDOW_MS || 10_000),
    maxConnectionsPerUser: Number(process.env.WS_MAX_CONNECTIONS_PER_USER || 5),
    // Security & Stability (FEATURE_REQUEST.md entry 1; both architecture
    // reviews' P0 recommendations): caps inbound WebSocket frame size so an
    // oversized frame is rejected before ever being buffered/JSON-parsed.
    // Sized comfortably above the worst-case encoding of a MAX_MESSAGE_LENGTH
    // message (validation.js, 10,000 chars — up to ~3 bytes/char in UTF-8 for
    // non-Latin text, plus JSON framing overhead), so no legitimate message
    // frame is ever at risk of hitting this cap.
    maxPayloadBytes: Number(process.env.WS_MAX_PAYLOAD_BYTES || 131_072), // 128 KiB
  },
};
