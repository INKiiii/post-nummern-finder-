import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base './': Die App läuft so unter jedem Unterpfad (z. B. GitHub Pages /<repo>/leitstand/).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
