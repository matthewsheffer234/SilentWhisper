import { ollamaAdapter } from './adapters/ollamaAdapter.js';
import { vllmAdapter } from './adapters/vllmAdapter.js';
import { disabledAdapter } from './adapters/disabledAdapter.js';

// The one place allowed to branch on which provider is active
// (PROJECT_PLAN.md Section 2: "AI proxy code above that line must never
// branch on which provider is active except inside the adapter factory
// that picks one from LLM_PROVIDER"). Everything else calls
// adapter.generate/adapter.checkHealth identically regardless of provider.
const ADAPTERS = {
  ollama: ollamaAdapter,
  vllm: vllmAdapter,
  disabled: disabledAdapter,
};

export function getAdapter(provider) {
  return ADAPTERS[provider] ?? disabledAdapter;
}
