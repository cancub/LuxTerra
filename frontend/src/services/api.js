/**
 * Client API Service for LuxTerra Backend
 */

const DEFAULT_SIMULATE_TIMEOUT_MS = 120000;

export async function runSimulation(requestPayload, signal = null, timeoutMs = DEFAULT_SIMULATE_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  const timerId = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Simulation request timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs)
    : null;

  let response;
  try {
    response = await fetch('/api/simulate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal
    });
  } catch (err) {
    if (timedOut) {
      throw new Error(`Simulation request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    if (timerId !== null) clearTimeout(timerId);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }

  if (!response.ok) {
    let errorDetail = `Simulation request failed with HTTP ${response.status}`;
    try {
      const rawText = await response.text();
      if (rawText) {
        try {
          const err = JSON.parse(rawText);
          if (Array.isArray(err.detail)) {
            errorDetail = err.detail.map(d => d.msg || JSON.stringify(d)).join('; ');
          } else if (typeof err.detail === 'object' && err.detail !== null) {
            errorDetail = err.detail.message || JSON.stringify(err.detail);
          } else if (err.detail) {
            errorDetail = String(err.detail);
          }
        } catch (_) {
          errorDetail = `HTTP ${response.status}: ${rawText.trim().slice(0, 200)}`;
        }
      }
    } catch (_) {}
    throw new Error(errorDetail);
  }

  return await response.json();
}
