/**
 * Tiny pass/fail reporter shared by every test suite. Prints a checkmark
 * per check and an end-of-suite summary. Exit code wiring is left to the
 * suite (so suites can keep doing finally-cleanup before exiting).
 */

export class Reporter {
  constructor(suite) {
    this.suite = suite;
    this.results = [];
    this.startedAt = Date.now();
    console.log(`\n${suite}`);
    console.log('='.repeat(suite.length));
  }

  async check(name, fn) {
    try {
      const detail = await fn();
      this.results.push({ name, pass: true, detail });
      console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      this.results.push({ name, pass: false, error: msg });
      console.log(`  ✗ ${name} — ${msg}`);
    }
  }

  summary() {
    const pass = this.results.filter((r) => r.pass).length;
    const fail = this.results.filter((r) => !r.pass).length;
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    console.log('\n' + '═'.repeat(40));
    console.log(`RESULT: ${pass}/${pass + fail} passed in ${seconds}s`);
    if (fail > 0) {
      console.log('Failures:');
      for (const r of this.results.filter((r) => !r.pass)) {
        console.log(`  ✗ ${r.name}: ${r.error}`);
      }
    }
    console.log('═'.repeat(40));
    return fail === 0;
  }
}
