import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No base-path config needed — Silent Whisper owns its whole subdomain
// (PROJECT_PLAN.md Section 2, Serving Under Silent Lattice).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Vite's dev server rejects unrecognized Host headers by default (DNS
    // rebinding protection) — nginx forwards the real Host header when
    // proxying whisper.silentlattice.dev, so it needs to be allow-listed
    // explicitly. This is a dev-server-only concern; a production static
    // build served by nginx directly wouldn't have this at all.
    allowedHosts: ['whisper.silentlattice.dev', 'localhost'],
  },
});
