import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Frontend unit tests (FEATURE_REQUEST.md's Basic Markdown formatting
// entry — the tokenizer is plain JS/React-element logic, cheap to unit
// test in isolation rather than only through the slower Playwright e2e
// suite). Same @vitejs/plugin-react as vite.config.js's real app build —
// without it, JSX compiles to bare `React.createElement(...)` calls with no
// automatic import, throwing "React is not defined" the moment a test
// actually invokes a tokenizer function that returns JSX. Scoped to src/
// explicitly: Vitest's default include glob (**/*.{test,spec}.*) also
// matches e2e/workflows.spec.js, which is a Playwright spec file, not a
// Vitest one, and errors out if Vitest tries to import it (test.describe()
// called outside Playwright's own runner).
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{js,jsx}'],
  },
});
