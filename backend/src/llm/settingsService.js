import { config } from '../config.js';
import {
  assertEnum,
  assertBoundedInt,
  assertBoundedNumber,
  assertBoolean,
  assertHttpUrl,
  assertShortString,
} from '../validation.js';
import { ValidationError } from '../errors.js';

// PROJECT_PLAN.md Section 4, Runtime Configuration: non-secret LLM settings
// live in app_settings so they can change after deployment without code
// edits or frontend rebuilds. LLM_API_KEY (Section 3, Secrets &
// Configuration: "no secret ever lives in app_settings") is deliberately
// absent from every list below — it is env-var-only, always, with no
// database-backed override.
export const LLM_PROVIDERS = ['ollama', 'vllm', 'disabled'];

// db key -> camelCase field name used everywhere in application code.
const KEY_TO_FIELD = {
  'llm.provider': 'provider',
  'llm.base_url': 'baseUrl',
  'llm.model': 'model',
  'llm.timeout_ms': 'timeoutMs',
  'llm.max_input_chars': 'maxInputChars',
  'llm.max_output_tokens': 'maxOutputTokens',
  'llm.max_concurrent_requests': 'maxConcurrentRequests',
  'llm.temperature': 'temperature',
  'llm.streaming_enabled': 'streamingEnabled',
  'llm.summary_prompt_version': 'summaryPromptVersion',
  'llm.task_prompt_version': 'taskPromptVersion',
};
const FIELD_TO_KEY = Object.fromEntries(Object.entries(KEY_TO_FIELD).map(([k, v]) => [v, k]));
export const LLM_SETTING_KEYS = Object.keys(KEY_TO_FIELD);
export const LLM_SETTING_FIELDS = Object.values(KEY_TO_FIELD);

function envDefaults() {
  return {
    provider: config.llm.provider,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    timeoutMs: config.llm.timeoutMs,
    maxInputChars: config.llm.maxInputChars,
    maxOutputTokens: config.llm.maxOutputTokens,
    maxConcurrentRequests: config.llm.maxConcurrentRequests,
    temperature: config.llm.temperature,
    streamingEnabled: config.llm.streamingEnabled,
    summaryPromptVersion: config.llm.summaryPromptVersion,
    taskPromptVersion: config.llm.taskPromptVersion,
  };
}

// Called once at backend startup (index.js). Inserts the env-derived
// defaults for any llm.* key not already present, so app_settings always has
// a full, queryable row set from the first boot onward — never mutates a key
// an admin has already saved a value for.
export async function ensureDefaultSettingsSeeded(db) {
  const defaults = envDefaults();
  const rows = LLM_SETTING_KEYS.map((key) => ({
    key,
    value: JSON.stringify(defaults[KEY_TO_FIELD[key]]),
  }));
  await db('app_settings').insert(rows).onConflict('key').ignore();
}

// The effective value of every llm.* setting: env defaults overlaid by
// whatever is currently in app_settings. Read fresh on every call (settings
// change rarely and this table is tiny — not worth a cache invalidation
// story for a Phase-4-scale feature).
export async function getEffectiveSettings(db) {
  const rows = await db('app_settings').whereIn('key', LLM_SETTING_KEYS).select('key', 'value');
  const overrides = {};
  for (const row of rows) {
    overrides[KEY_TO_FIELD[row.key]] = row.value;
  }
  return { ...envDefaults(), ...overrides };
}

// Validates and normalizes a partial update from the admin settings API.
// Unknown fields are rejected outright rather than silently ignored, so a
// typo'd field name fails loudly instead of appearing to save.
export function validateSettingsPatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Settings patch must be an object');
  }
  const patch = {};
  for (const field of Object.keys(body)) {
    if (!FIELD_TO_KEY[field]) {
      throw new ValidationError(`Unknown setting: ${field}`);
    }
  }
  if ('provider' in body) patch.provider = assertEnum(body.provider, LLM_PROVIDERS, 'provider');
  if ('baseUrl' in body) patch.baseUrl = assertHttpUrl(body.baseUrl, 'baseUrl');
  if ('model' in body) patch.model = assertShortString(body.model, { maxLength: 200 }, 'model');
  if ('timeoutMs' in body) patch.timeoutMs = assertBoundedInt(body.timeoutMs, { min: 1000, max: 120_000 }, 'timeoutMs');
  if ('maxInputChars' in body) {
    patch.maxInputChars = assertBoundedInt(body.maxInputChars, { min: 100, max: 200_000 }, 'maxInputChars');
  }
  if ('maxOutputTokens' in body) {
    patch.maxOutputTokens = assertBoundedInt(body.maxOutputTokens, { min: 16, max: 8192 }, 'maxOutputTokens');
  }
  if ('maxConcurrentRequests' in body) {
    patch.maxConcurrentRequests = assertBoundedInt(body.maxConcurrentRequests, { min: 1, max: 32 }, 'maxConcurrentRequests');
  }
  if ('temperature' in body) patch.temperature = assertBoundedNumber(body.temperature, { min: 0, max: 2 }, 'temperature');
  if ('streamingEnabled' in body) patch.streamingEnabled = assertBoolean(body.streamingEnabled, 'streamingEnabled');
  if ('summaryPromptVersion' in body) {
    patch.summaryPromptVersion = assertShortString(body.summaryPromptVersion, { maxLength: 20 }, 'summaryPromptVersion');
  }
  if ('taskPromptVersion' in body) {
    patch.taskPromptVersion = assertShortString(body.taskPromptVersion, { maxLength: 20 }, 'taskPromptVersion');
  }
  return patch;
}

// Persists a validated patch (use validateSettingsPatch first — this
// function trusts its input). Each key is an independent row upsert, not a
// single JSON blob, so a partial update can never clobber unrelated keys.
export async function updateSettings(db, patch, updatedByUserId) {
  const now = new Date();
  await db.transaction(async (trx) => {
    for (const field of Object.keys(patch)) {
      const key = FIELD_TO_KEY[field];
      await trx('app_settings')
        .insert({ key, value: JSON.stringify(patch[field]), updated_by: updatedByUserId, updated_at: now })
        .onConflict('key')
        .merge(['value', 'updated_by', 'updated_at']);
    }
  });
  return getEffectiveSettings(db);
}
