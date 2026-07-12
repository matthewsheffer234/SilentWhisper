import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No base-path config needed — Silent Whisper owns its whole subdomain
// (PROJECT_PLAN.md Section 2, Serving Under Silent Lattice).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
});
