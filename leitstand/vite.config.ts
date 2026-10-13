import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base './': Die App läuft so unter jedem Unterpfad (z. B. GitHub Pages /<repo>/leitstand/).
export default defineConfig({
  base: './',
  plugins: [react()],
  // three.js ist groß; ein Bündel von gut 1 MB ist für die 3D-Szene erwartbar
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1600 },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
