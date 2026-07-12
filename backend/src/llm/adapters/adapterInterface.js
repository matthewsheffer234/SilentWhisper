// PROJECT_PLAN.md Section 2, Configurable LLM Provider Settings: "Define one
// provider-adapter interface (send prompt, receive completion, report
// health) that both the vLLM adapter and the Ollama adapter implement
// identically. AI proxy code above that line must never branch on which
// provider is active except inside the adapter factory that picks one from
// LLM_PROVIDER." This file documents that interface; adapters are plain
// objects shaped like it, not classes — nothing here is imported at runtime.
//
// generate({ settings, prompt, onChunk }) -> Promise<{ text: string }>
//   settings: the effective LLM settings object (llm/settingsService.js) —
//     baseUrl, model, timeoutMs, maxOutputTokens, temperature,
//     streamingEnabled, plus apiKey merged in by the caller (settingsService
//     never returns apiKey itself, per Section 3).
//   prompt: the fully-built, already-delimited/truncated prompt string.
//   onChunk: optional (text: string) => void, called with each incremental
//     piece of the completion as it streams in. Adapters that support
//     streaming call it when settings.streamingEnabled is true; adapters
//     that don't (or when streaming is off) simply never call it, and the
//     caller falls back to the returned `text` in one piece. Either way the
//     resolved `text` is always the full, final completion.
//   Throws UpstreamError (errors.js) on network failure, timeout, or a
//     response the adapter can't parse.
//
// checkHealth({ settings }) -> Promise<{ healthy: boolean, message: string }>
//   Never throws — failures are reported in the return value so the health
//   sweep (llm/healthCheck.js) can run unconditionally on a timer.
