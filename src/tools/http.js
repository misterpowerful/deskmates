// Shared HTTP plumbing for the GitHub/Gmail/Calendar/OAuth tool modules: a
// fetch with a hard timeout, and retry for idempotent reads only.

import { withRetry } from "../retry.js";

export const DEFAULT_TIMEOUT_MS = 10000;

// Retry settings for reads; exported so tests can shorten the backoff.
export const readRetryOptions = {};

// fetch() that gives up after timeoutMs. A timeout is rethrown as a
// TimeoutError (transient for withRetry) with a message the model can act on.
export async function fetchWithTimeout(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, label = "HTTP" } = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      const timeout = new Error(`${label} request timed out after ${timeoutMs / 1000}s`);
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw err;
  }
}

// Error carrying the HTTP status so isTransientError can classify it.
export function statusError(message, status) {
  return Object.assign(new Error(message), { status });
}

// Runs an idempotent read through withRetry. Never use for writes.
export function retryRead(fn) {
  return withRetry(fn, readRetryOptions);
}
