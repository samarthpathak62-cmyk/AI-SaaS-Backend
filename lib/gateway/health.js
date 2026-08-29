// Simple in-memory health/latency tracker. Good enough for a single VPS process.
// If you run multiple app instances (PM2 cluster mode), each tracks independently —
// fine in practice since a bad model gets marked down within one failed request per instance.
const LATENCY_SAMPLE_SIZE = 20;      // rolling window for average latency
const COOLDOWN_MS = 30 * 1000;       // how long a failed model is skipped for

// In-process state (fast path). Mirrored into Redis so multiple app instances
// on the same VPS (e.g. PM2 cluster mode) share health data.
const state = new Map(); // modelId -> { failedUntil, latencies: [] }

function getState(modelId) {
  if (!state.has(modelId)) state.set(modelId, { failedUntil: 0, latencies: [] });
  return state.get(modelId);
}

function isHealthy(modelId) {
  return getState(modelId).failedUntil < Date.now();
}

function markFailure(modelId) {
  const s = getState(modelId);
  s.failedUntil = Date.now() + COOLDOWN_MS;
}

function markSuccess(modelId, latencyMs) {
  const s = getState(modelId);
  s.failedUntil = 0;
  s.latencies.push(latencyMs);
  if (s.latencies.length > LATENCY_SAMPLE_SIZE) s.latencies.shift();
}

function averageLatency(modelId) {
  const s = getState(modelId);
  if (!s.latencies.length) return Infinity; // unknown = treated as slowest until proven otherwise
  return s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length;
}

module.exports = { isHealthy, markFailure, markSuccess, averageLatency };
