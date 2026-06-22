// Small fetch wrapper that retries once on a network-layer failure
// (DNS, connect, TLS) but NOT on application-level HTTP errors (4xx,
// 5xx). Docker's embedded DNS resolver intermittently returns
// EAI_AGAIN; one retry after a brief pause covers it without
// pretending we're a real resilience layer.

const RETRY_DELAY_MS = 400;

/**
 * Fetch with one retry on transient network failures. HTTP errors
 * (non-2xx) are returned as-is — the caller decides what to do with
 * them. Use for outbound calls to third-party APIs from MCP tools.
 */
export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    // Pure network error (TypeError from undici); not an HTTP error.
    // Wait briefly so a flaking resolver has time to recover.
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return fetch(input, init);
  }
}
