/**
 * Self-check runner. Runs every suite sequentially and prints a
 * consolidated summary. Exits 0 if all suites passed, 1 otherwise.
 *
 *   server-multiplayer.mjs   raw Colyseus, 2 clients, ~30s
 *   ui-game-physics.mjs      Playwright, full lobby→game flow, ~60s
 *
 * Skip an individual suite with --skip=server, --skip=ui, etc.
 * Override URLs with --server=…, --lobby=…, --game=… (forwarded to suites).
 *
 * Usage:
 *   pnpm test:all
 *   node tests/all.mjs
 *   node tests/all.mjs --skip=ui
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rawArgs = process.argv.slice(2);
const args = Object.fromEntries(
  rawArgs.map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const skipSet = new Set(
  String(args.skip || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const forwarded = rawArgs.filter((a) => !a.startsWith('--skip'));

const suites = [
  { key: 'server', name: 'Multiplayer server (raw Colyseus, 2 clients)', file: 'server-multiplayer.mjs' },
  { key: 'behavior', name: 'Feature behavior (chase, drift, late join, world sync)', file: 'behavior-multiplayer.mjs' },
  { key: 'sync', name: 'Sync-rate (server vs client tick, inter-client drift)', file: 'sync-rate.mjs' },
  { key: 'logs', name: 'Log equivalence (server ring ≡ client ring)', file: 'log-equivalence.mjs' },
  { key: 'perf', name: 'Performance metrics (server tick rate)', file: 'perf-metrics.mjs' },
  { key: 'multikill', name: 'Multi-client kill (3 browsers, all log + cinematic)', file: 'multi-client-kill.mjs' },
  { key: 'ui', name: 'UI + game physics (Playwright)', file: 'ui-game-physics.mjs' },
];

const NODE = process.execPath;

const results = [];
const t0 = Date.now();

console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║ SELF-CHECK SUITE                                          ║');
console.log('╠═══════════════════════════════════════════════════════════╣');
for (const s of suites) {
  console.log(`║  · ${s.name.padEnd(54)}║`);
}
console.log('╚═══════════════════════════════════════════════════════════╝');

for (const suite of suites) {
  if (skipSet.has(suite.key)) {
    results.push({ ...suite, skipped: true });
    continue;
  }
  const t1 = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(NODE, [path.join(__dirname, suite.file), ...forwarded], {
      stdio: 'inherit',
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  results.push({
    ...suite,
    skipped: false,
    pass: code === 0,
    code,
    elapsed: ((Date.now() - t1) / 1000).toFixed(1),
  });
}

const totalSeconds = ((Date.now() - t0) / 1000).toFixed(1);

console.log('\n\n');
console.log('╔═══════════════════════════════════════════════════════════');
console.log('║  SELF-CHECK SUMMARY');
console.log('╠═══════════════════════════════════════════════════════════');
for (const r of results) {
  if (r.skipped) {
    console.log(`║  -    SKIP   ${''.padEnd(6)}  ${r.name}`);
    continue;
  }
  const mark = r.pass ? '✓' : '✗';
  const label = r.pass ? 'PASS' : 'FAIL';
  console.log(`║  ${mark}    ${label}   ${r.elapsed.padStart(5)}s  ${r.name}`);
}
const ran = results.filter((r) => !r.skipped);
const pass = ran.filter((r) => r.pass).length;
const fail = ran.filter((r) => !r.pass).length;
console.log('╠═══════════════════════════════════════════════════════════');
console.log(
  `║  RESULT: ${pass}/${ran.length} suites passed (${fail} failed) · ${totalSeconds}s total`
);
console.log('╚═══════════════════════════════════════════════════════════');

process.exit(fail > 0 ? 1 : 0);
