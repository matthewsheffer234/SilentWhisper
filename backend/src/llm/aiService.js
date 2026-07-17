import { config } from '../config.js';
import { getEffectiveSettings } from './settingsService.js';
import { getAdapter } from './adapterFactory.js';
import { tryAcquire, release } from './concurrencyGate.js';
import { ServiceUnavailableError } from '../errors.js';

// Shared by all three AI routes (summarize, extract-tasks, workspace-digest)
// so streaming, the concurrency gate, and prompt truncation/versioning can
// never drift between them (same principle Section 3 requires for
// authorization and message creation, applied here). Writes the completion
// straight to `res` as it streams — response headers carrying prompt
// metadata are set before any body bytes go out, so the caller can always
// inspect them even though the body itself is chunked plain text
// (PROJECT_PLAN.md Section 8, Phase 4: "Render streamed or incremental AI
// text in the frontend when supported by the backend route"). `signal` is
// optional and only passed by the workspace-digest route today (see
// adapterInterface.js) — omitted, summarize/extract-tasks behave exactly as
// before.
export async function runStreamingCompletion({ db, res, promptBuilder, promptVersionField, messages, signal }) {
  const settings = await getEffectiveSettings(db);

  if (settings.provider === 'disabled') {
    throw new ServiceUnavailableError('AI features are disabled on this deployment');
  }
  if (!tryAcquire(settings.maxConcurrentRequests)) {
    throw new ServiceUnavailableError('AI service is at capacity, please try again shortly');
  }

  try {
    const { prompt, truncatedInputLength, wasTruncated } = promptBuilder({
      messages,
      maxInputChars: settings.maxInputChars,
      promptVersion: settings[promptVersionField],
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Ai-Provider', settings.provider);
    res.setHeader('X-Ai-Prompt-Version', settings[promptVersionField]);
    res.setHeader('X-Ai-Truncated-Input-Length', String(truncatedInputLength));
    res.setHeader('X-Ai-Was-Truncated', String(wasTruncated));

    const adapter = getAdapter(settings.provider);
    // Wired up when streaming is on, but an adapter may still fall back to a
    // single non-streaming response even then (e.g. the provider returned no
    // body stream) — so onChunk having actually fired, not the
    // streamingEnabled setting itself, is what decides whether the full text
    // still needs writing below. Otherwise a silent adapter fallback would
    // leave the response body empty even though generate() succeeded.
    let wroteViaChunk = false;
    const onChunk = settings.streamingEnabled
      ? (piece) => {
          wroteViaChunk = true;
          res.write(piece);
        }
      : undefined;
    const { text } = await adapter.generate({
      settings: { ...settings, apiKey: config.llm.apiKey },
      prompt,
      onChunk,
      signal,
    });
    if (!wroteViaChunk) {
      res.write(text);
    }
    res.end();

    return {
      text,
      provider: settings.provider,
      promptVersion: settings[promptVersionField],
      truncatedInputLength,
      wasTruncated,
    };
  } finally {
    release();
  }
}
