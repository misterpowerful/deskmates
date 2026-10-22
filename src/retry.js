// Retry helper for transient failures (network hiccups, momentary service
// delays) from Claude and ElevenLabs calls. Permanent errors (bad request,
// auth, etc.) are surfaced immediately.

export const MAX_RETRIES = 3;
export const BASE_DELAY_MS = 250;

const TRANSIENT_STATUSES = new Set([408, 425, 429]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

// True for errors worth retrying: HTTP 408/425/429/5xx, or no HTTP status at
// all together with a connection-level code/name (fetch/SDK network failures).
// Anything else — including non-Error input — is treated as permanent.
export function isTransientError(err) {
  if (!err || typeof err !== "object") return false;
  const status = err.status ?? err.statusCode;
  if (typeof status === "number") {
    return TRANSIENT_STATUSES.has(status) || (status >= 500 && status <= 599);
  }
  const code = err.code ?? err.cause?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  return (
    err.name === "APIConnectionError" ||
    err.name === "APIConnectionTimeoutError" ||
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    (err.name === "TypeError" && /fetch failed/i.test(String(err.message)))
  );
}

// Calls fn() and retries up to `retries` times (default 3) on transient
// errors, waiting baseDelayMs * 2^attempt between tries (250, 500, 1000ms).
// The last error is rethrown once retries are exhausted.
export async function withRetry(fn, { retries = MAX_RETRIES, baseDelayMs = BASE_DELAY_MS, sleep, onRetry } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransientError(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      onRetry?.(err, attempt + 1, delay);
      await wait(delay);
    }
  }
}

export function retryMessage(label, err, attempt, delay) {
  return `${label} failed transiently (${err?.message ?? err}); retry ${attempt} in ${delay}ms`;
}

// Replaces each dotted method path (e.g. "messages.create") on `client` with
// a version that goes through withRetry. `this` binding is preserved.
// Returns the same client. Extra options are passed through to withRetry.
export function retryMethods(client, paths, label, logFn, options = {}) {
  for (const path of paths) {
    const parts = path.split(".");
    const name = parts.pop();
    const owner = parts.reduce((o, k) => o[k], client);
    const original = owner[name];
    owner[name] = (...args) =>
      withRetry(() => original.apply(owner, args), {
        ...options,
        onRetry: (err, attempt, delay) => logFn?.(retryMessage(label, err, attempt, delay)),
      });
  }
  return client;
}
