import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

function listFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Generates a versioned application-shell service worker (dist/sw.js) at build time.
 * Only the app's own build output is precached; user models are never cached by the worker.
 */
export function zinoServiceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'zino3d-service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle(_options, bundle) {
      const files = new Set<string>(['./', './index.html']);
      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith('.map')) continue;
        files.add(`./${fileName}`);
      }
      const publicDir = config.publicDir;
      for (const file of listFiles(publicDir)) {
        const rel = relative(publicDir, file).split('\\').join('/');
        if (rel === 'sw.js' || rel.startsWith('samples/')) continue;
        files.add(`./${rel}`);
      }
      const hash = createHash('sha256');
      for (const f of [...files].sort()) hash.update(f);
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk') hash.update(name + chunk.code.length);
      }
      const template = readFileSync(join(config.root, 'build/sw-template.js'), 'utf8');
      const source = template
        .replace('__ZINO_CACHE_VERSION__', hash.digest('hex').slice(0, 16))
        .replace('__ZINO_PRECACHE__', JSON.stringify([...files].sort(), null, 2));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
