import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { zinoServiceWorker } from './build/serviceWorkerPlugin';
import { contentSecurityPolicy } from './build/cspPlugin';

// Relative base so the build works from file://-style Capacitor origins and sub-paths.
export default defineConfig({
  base: './',
  plugins: [react(), zinoServiceWorker(), contentSecurityPolicy()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
  },
});
