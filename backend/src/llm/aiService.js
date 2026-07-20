import { config } from '../config.js';
import { getEffectiveSettings } from './settingsService.js';
import { getAdapter } from './adapterFactory.js';
import { acquireSlot, release } from './concurrencyGate.js';
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
//
// `onBeforeEnd` (FEATURE_REQUEST.md entry 2, "fix the aiRoutes.test.js
// audit-row race at its root"): an optional async callback run after
// `adapter.generate()` resolves but before `res.end()`. Each of the three
// call sites passes a closure that awaits `appendAuditEvent(...)` here
// instead of after this function returns — previously every one of them did
// the audit write *after* this function had already called `res.end()`,
// meaning a client's response could complete before that action's audit row
// was guaranteed to exist. If the callback itself throws (a transient DB
// hiccup), it's logged and swallowed rather than propagated: some response
// body bytes may already be on the wire via `onChunk` by this point (a
// partially-streamed response can't be retroactively failed), so this fails
// open the same way a mid-stream adapter failure already does below —
// matching `enqueueEmbeddingJob`'s established "rare, narrow, best-effort"
// precedent elsewhere in this codebase, rather than hanging the connection
// or crashing the process over an audit-write failure.
export async function runStreamingCompletion({ db, res, promptBuilder, promptVersionField, messages, signal, onBeforeEnd }) {
  const settings = await getEffectiveSettings(db);

  if (settings.provider === 'disabled') {
    throw new ServiceUnavailableError('AI features are disabled on this deployment');
  }

  // Prompt construction is pure, local truncation/formatting — it needs no
  // provider call and so needs no concurrency slot. Computing it up front
  // (a deliberate reordering vs. this entry's own design text, which had
  // this run after acquiring) means every response header, including the
  // queue-position one set below, can go out in a single flush whether or
  // not this request ends up waiting — setHeader() after headers have
  // already been flushed throws, so the two header-setting paths (queued vs.
  // not) can't be allowed to race each other.
  const { prompt, truncatedInputLength, wasTruncated } = promptBuilder({
    messages,
    maxInputChars: settings.maxInputChars,
    promptVersion: settings[promptVersionField],
  });

  function setCompletionHeaders() {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Ai-Provider', settings.provider);
    res.setHeader('X-Ai-Prompt-Version', settings[promptVersionField]);
    res.setHeader('X-Ai-Truncated-Input-Length', String(truncatedInputLength));
    res.setHeader('X-Ai-Was-Truncated', String(wasTruncated));
  }

  let headersFlushed = false;
  try {
    await acquireSlot(settings.maxConcurrentRequests, {
      onQueued: (position) => {
        // Client-visible "queued, position N" signal (FEATURE_REQUEST.md
        // entry 2) rather than a request that silently hangs until its turn.
        setCompletionHeaders();
        res.setHeader('X-Ai-Queue-Position', String(position));
        res.flushHeaders();
        headersFlushed = true;
      },
    });
  } catch {
    // This entry narrows *when* the capacity rejection fires (only once the
    // bounded wait queue itself is full), it doesn't remove it — same
    // message callers/tests already expect.
    throw new ServiceUnavailableError('AI service is at capacity, please try again shortly');
  }

  try {
    if (!headersFlushed) {
      setCompletionHeaders();
    }

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

    const result = {
      text,
      provider: settings.provider,
      promptVersion: settings[promptVersionField],
      truncatedInputLength,
      wasTruncated,
    };

    if (onBeforeEnd) {
      try {
        await onBeforeEnd(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Audit write before completing AI response failed:', err);
      }
    }

    if (!wroteViaChunk) {
      res.write(text);
    }
    res.end();

    return result;
  } finally {
    release();
  }
}
