// Verifies that every production dependency uses a permissive license compatible with
// distributing Zino3D (web, iOS, Android). Usage: npm run licenses
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Zlib',
]);

const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { encoding: 'utf8' }));
const seen = new Map();
function walk(deps, base) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const dir = join(base, 'node_modules', name);
    const key = `${name}@${info.version}`;
    if (!seen.has(key)) {
      let license;
      try {
        const pkg = JSON.parse(
          readFileSync(join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8'),
        );
        license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN');
      } catch {
        // nested install path
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
          license = typeof pkg.license === 'string' ? pkg.license : 'UNKNOWN';
        } catch {
          license = 'UNKNOWN';
        }
      }
      seen.set(key, license);
    }
    walk(info.dependencies, dir);
  }
}
walk(tree.dependencies, process.cwd());

let failed = false;
for (const [pkg, license] of [...seen].sort()) {
  const ids = license.replace(/[()]/g, '').split(/\s+OR\s+/);
  const ok = ids.some((id) => ALLOWED.has(id.trim()));
  console.log(`${ok ? '✓' : '✗'} ${pkg.padEnd(40)} ${license}`);
  if (!ok) failed = true;
}
if (failed) {
  console.error(
    '\nSome production dependencies use licenses outside the allow-list. Review before shipping.',
  );
  process.exit(1);
}
console.log(`\nAll ${seen.size} production dependencies use allowed licenses.`);
