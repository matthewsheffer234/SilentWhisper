import { config } from '../config.js';
import { getEffectiveSettings } from '../llm/settingsService.js';
import { getAdapter } from '../llm/adapterFactory.js';
import { acquireSlot, release } from '../llm/concurrencyGate.js';
import { buildEntitySummaryPrompt } from '../llm/promptTemplates.js';
import { ServiceUnavailableError } from '../errors.js';

// FEATURE_REQUEST.md entry 4: AI-generated "What we know" entity summary.
// Deliberately not built on aiService.js's runStreamingCompletion — that
// helper writes chunks straight to a text/plain `res` as they arrive, which
// fits summarize/extract-tasks/digest's "stream the answer" UX but not this
// feature's "generate once, persist the whole thing plus its citation list
// as a JSON row" shape. Reuses the same underlying building blocks
// (getEffectiveSettings, the concurrency gate, the adapter factory) so this
// still obeys the same disabled-provider/at-capacity/timeout behavior every
// other AI surface does, just without streaming.
//
// promptVersion reuses the existing admin-configurable `summaryPromptVersion`
// setting rather than introducing a fourth *PromptVersion field/UI control
// for a summary style that's conceptually the same "delimited-messages ->
// bullet summary" shape as the channel summarizer.
export async function generateEntitySummary(db, { entityName, references, signal }) {
  const settings = await getEffectiveSettings(db);
  if (settings.provider === 'disabled') {
    throw new ServiceUnavailableError('AI features are disabled on this deployment');
  }

  const { prompt, truncatedInputLength, wasTruncated } = buildEntitySummaryPrompt({
    entityName,
    messages: references,
    maxInputChars: settings.maxInputChars,
    promptVersion: settings.summaryPromptVersion,
  });

  try {
    await acquireSlot(settings.maxConcurrentRequests, { signal });
  } catch {
    throw new ServiceUnavailableError('AI service is at capacity, please try again shortly');
  }

  try {
    const adapter = getAdapter(settings.provider);
    const { text } = await adapter.generate({
      settings: { ...settings, apiKey: config.llm.apiKey },
      prompt,
      signal,
    });
    return {
      text,
      provider: settings.provider,
      promptVersion: settings.summaryPromptVersion,
      truncatedInputLength,
      wasTruncated,
    };
  } finally {
    release();
  }
}
