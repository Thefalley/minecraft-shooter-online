// Streams Profiler snapshots to the dev-server bridge (see vite.config.js) so
// they land in profiling/ for analysis while you play. Only sends while the
// profiler overlay is on (key L); a continuous tick every ~1s plus an explicit
// "mark" on key K. No-ops outside the browser or if the endpoint is absent
// (production/preview build) — fetch failures are swallowed.
const ENDPOINT = '/__profile';

export function installProfileExporter(profiler, getContext = () => ({}), { intervalMs = 1000 } = {}) {
  if (typeof window === 'undefined') return () => {};

  function buildPayload(kind) {
    const snap = profiler.snapshot();
    return {
      kind,
      time: new Date().toISOString(),
      ...getContext(),
      fps: Math.round(snap.fps),
      frame: { avg: +snap.frame.avg.toFixed(3), p95: +snap.frame.p95.toFixed(3), max: +snap.frame.max.toFixed(3) },
      phases: snap.sections.map((s) => ({
        label: s.label,
        avg: +s.avg.toFixed(3),
        p95: +s.p95.toFixed(3),
        share: snap.frame.avg > 0 ? +(100 * s.avg / snap.frame.avg).toFixed(1) : 0,
      })),
      muted: [...profiler.muted],
    };
  }

  function send(kind) {
    if (!profiler.enabled) return; // only capture while the overlay is on
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload(kind)),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* endpoint not present (e.g. production) — ignore */
    }
  }

  const timer = setInterval(() => send('auto'), intervalMs);
  const onKey = (event) => { if (event.code === 'KeyK') { event.preventDefault(); send('mark'); } };
  window.addEventListener('keydown', onKey);

  return function uninstall() {
    clearInterval(timer);
    window.removeEventListener('keydown', onKey);
  };
}

export default installProfileExporter;
