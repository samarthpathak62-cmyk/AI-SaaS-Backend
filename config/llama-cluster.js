// Supports a single llama-server (simplest case) or multiple, comma-separated in .env,
// so you can add more GPU workers later without changing any route code.
// Example .env: LLAMA_SERVER_URLS=http://127.0.0.1:8080/v1/chat/completions,http://127.0.0.1:8081/v1/chat/completions

const urls = (process.env.LLAMA_SERVER_URLS || process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080/v1/chat/completions')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

let index = 0;
const failedUntil = new Map(); // url -> timestamp until which we skip it

function nextServerUrl() {
  const now = Date.now();
  for (let i = 0; i < urls.length; i++) {
    const url = urls[(index + i) % urls.length];
    const cooldownUntil = failedUntil.get(url) || 0;
    if (cooldownUntil <= now) {
      index = (index + i + 1) % urls.length;
      return url;
    }
  }
  // everything is in cooldown - just return the next one anyway
  index = (index + 1) % urls.length;
  return urls[index];
}

// Mark a server as temporarily unhealthy so we skip it for a bit (30s)
function markFailed(url) {
  failedUntil.set(url, Date.now() + 30_000);
}

module.exports = { nextServerUrl, markFailed, allServers: urls };
