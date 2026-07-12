import { ServiceUnavailableError } from '../../errors.js';

// LLM_PROVIDER=disabled turns AI features off entirely (Section 2) without
// needing an if-branch anywhere above the adapter factory — every AI route
// still calls generate()/checkHealth() exactly like the real adapters, it
// just always fails in a well-defined, immediate way.

async function generate() {
  throw new ServiceUnavailableError('AI features are disabled on this deployment (LLM_PROVIDER=disabled)');
}

async function checkHealth() {
  return { healthy: false, message: 'disabled' };
}

export const disabledAdapter = { generate, checkHealth };
