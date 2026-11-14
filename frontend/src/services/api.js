/**
 * Client API Service for LuxTerra Backend
 */

export async function runSimulation(requestPayload, signal = null) {
  const response = await fetch('/api/simulate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestPayload),
    signal
  });

  if (!response.ok) {
    let errorDetail = `Simulation request failed with HTTP ${response.status}`;
    try {
      const err = await response.json();
      if (Array.isArray(err.detail)) {
        errorDetail = err.detail.map(d => d.msg || JSON.stringify(d)).join('; ');
      } else if (typeof err.detail === 'object' && err.detail !== null) {
        errorDetail = err.detail.message || JSON.stringify(err.detail);
      } else if (err.detail) {
        errorDetail = String(err.detail);
      }
    } catch (_) {}
    throw new Error(errorDetail);
  }

  return await response.json();
}
