import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Erzeugt nach dem Build den Service Worker mit der Liste aller App-Dateien.
 * Regionspakete (regions/) werden bewusst nicht vorab geladen, sie liegen in IndexedDB.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'hnf-service-worker',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          const rel = path.relative(outDir, p).split(path.sep).join('/');
          if (e.isDirectory()) {
            if (rel !== 'regions') walk(p);
          } else if (rel !== 'sw.js' && !rel.endsWith('.map')) files.push(rel);
        }
      };
      walk(outDir);
      const hash = crypto.createHash('sha1');
      for (const f of files.sort()) hash.update(f).update(fs.readFileSync(path.join(outDir, f)));
      const template = fs.readFileSync(path.resolve('src/sw.js'), 'utf8');
      const sw = template
        .replace('__VERSION__', hash.digest('hex').slice(0, 10))
        .replace('__FILES__', JSON.stringify(['./', ...files.filter((f) => f !== 'index.html')]));
      fs.writeFileSync(path.join(outDir, 'sw.js'), sw);
    },
  };
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const sha = (process.env.GITHUB_SHA ?? '').slice(0, 7);
const APP_VERSION = `${pkg.version} (${new Date().toISOString().slice(0, 10)}${sha ? ' · ' + sha : ''})`;

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [serviceWorker()],
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['tests/**/*.test.{ts,js,mjs}'] },
} as any);
