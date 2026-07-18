import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { destroyResetDbConnection } from './helpers/resetDb.js';
import {
  LLM_SETTING_KEYS,
  ensureDefaultSettingsSeeded,
  getEffectiveSettings,
  validateSettingsPatch,
  updateSettings,
} from '../src/llm/settingsService.js';

// app_settings isn't cleared by resetDb.js (it holds operational config, not
// per-test user data) — clear just the llm.* keys this suite owns so tests
// stay isolated from each other and from whatever the AI routes tests write.
beforeEach(async () => {
  await db('app_settings').whereIn('key', LLM_SETTING_KEYS).del();
});

afterAll(async () => {
  await db('app_settings').whereIn('key', LLM_SETTING_KEYS).del();
  await db.destroy();
  await destroyResetDbConnection();
});

describe('getEffectiveSettings', () => {
  test('falls back to env defaults when no app_settings rows exist', async () => {
    const settings = await getEffectiveSettings(db);
    expect(settings.provider).toBe(config.llm.provider);
    expect(settings.model).toBe(config.llm.model);
    expect(settings.maxConcurrentRequests).toBe(config.llm.maxConcurrentRequests);
    // Never returns a secret, even though config.llm carries one internally.
    expect(settings.apiKey).toBeUndefined();
  });
});

describe('validateSettingsPatch', () => {
  test('accepts a valid partial patch', () => {
    const patch = validateSettingsPatch({ provider: 'vllm', timeoutMs: 45_000, streamingEnabled: false });
    expect(patch).toEqual({ provider: 'vllm', timeoutMs: 45_000, streamingEnabled: false });
  });

  test('rejects an unrecognized provider', () => {
    expect(() => validateSettingsPatch({ provider: 'gpt-magic' })).toThrow();
  });

  test('rejects an unknown field outright rather than ignoring it', () => {
    expect(() => validateSettingsPatch({ apiKey: 'sneaky' })).toThrow();
  });

  test('rejects an out-of-range value', () => {
    expect(() => validateSettingsPatch({ maxConcurrentRequests: 0 })).toThrow();
    expect(() => validateSettingsPatch({ temperature: 5 })).toThrow();
  });

  test('rejects a malformed base URL', () => {
    expect(() => validateSettingsPatch({ baseUrl: 'not-a-url' })).toThrow();
    expect(() => validateSettingsPatch({ baseUrl: 'ftp://example.com' })).toThrow();
  });

  // Security.md (2026-07-15, MEDIUM: LLM baseUrl SSRF/DoS) — a
  // syntactically valid http(s) URL is no longer sufficient on its own; it
  // must also be an allowlisted origin (config.llm.allowedLlmOrigins).
  test('accepts an allowlisted base URL, normalized to just its origin', () => {
    const patch = validateSettingsPatch({ baseUrl: `${config.llm.baseUrl}/some/path?query=1` });
    expect(patch.baseUrl).toBe(new URL(config.llm.baseUrl).origin);
  });

  test('rejects a well-formed http(s) URL whose origin is not allowlisted, e.g. a loopback SSRF target', () => {
    expect(() => validateSettingsPatch({ baseUrl: 'http://127.0.0.1:9999' })).toThrow(
      /not an approved LLM provider origin/,
    );
    expect(() => validateSettingsPatch({ baseUrl: 'http://some-other-internal-host:1234' })).toThrow(
      /not an approved LLM provider origin/,
    );
  });
});

describe('updateSettings', () => {
  test('persists only the patched keys, leaving the rest at their env default', async () => {
    const patch = validateSettingsPatch({ model: 'llama3', maxOutputTokens: 256 });
    const settings = await updateSettings(db, patch, null);
    expect(settings.model).toBe('llama3');
    expect(settings.maxOutputTokens).toBe(256);
    expect(settings.provider).toBe(config.llm.provider); // untouched

    // A second, unrelated patch doesn't clobber the first.
    const patch2 = validateSettingsPatch({ temperature: 0.9 });
    const settings2 = await updateSettings(db, patch2, null);
    expect(settings2.temperature).toBe(0.9);
    expect(settings2.model).toBe('llama3');
  });
});

describe('ensureDefaultSettingsSeeded', () => {
  test('seeds every llm.* key when none exist', async () => {
    await ensureDefaultSettingsSeeded(db);
    const rows = await db('app_settings').whereIn('key', LLM_SETTING_KEYS).select('key');
    expect(rows.map((r) => r.key).sort()).toEqual([...LLM_SETTING_KEYS].sort());
  });

  test('never overwrites a key an admin has already saved a value for', async () => {
    const patch = validateSettingsPatch({ provider: 'vllm' });
    await updateSettings(db, patch, null);

    await ensureDefaultSettingsSeeded(db);

    const settings = await getEffectiveSettings(db);
    expect(settings.provider).toBe('vllm');
  });
});
