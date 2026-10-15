// SP0 measurements only. No application state, credentials or request bodies are recorded.
export function summarize(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Expected non-empty finite non-negative latency samples');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const nearestRank = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: nearestRank(0.5),
    p95: nearestRank(0.95),
    max: sorted.at(-1),
  };
}

export function allowedBaselineUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      ['4173', '54321'].includes(url.port) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function requestCategory(value) {
  const url = new URL(value);
  const rpc = /^\/rest\/v1\/rpc\/([a-z][a-z0-9_]*)$/.exec(url.pathname);
  if (rpc) return `rpc:${rpc[1]}`;
  const table = /^\/rest\/v1\/([a-z][a-z0-9_]*)$/.exec(url.pathname);
  if (table) return `table:${table[1]}`;
  if (url.pathname.startsWith('/auth/')) return 'auth';
  if (url.pathname.startsWith('/realtime/')) return 'realtime';
  return 'app-or-other';
}
