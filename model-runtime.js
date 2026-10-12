export function createModelTransport({ fetchImpl = fetch, clock = Date.now, concurrency = 3, threshold = 3, cooldownMs = 30000 } = {}) {
  let active = 0, failures = 0, openUntil = 0, calls = 0, errors = 0, totalMs = 0;
  const transport = async (url, options = {}) => {
    if (clock() < openUntil || active >= concurrency) throw Object.assign(new Error('AI service is busy or temporarily unavailable. Retry shortly.'), { status: 503 });
    active++; calls++; const start = clock();
    try {
      const response = await fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000) });
      const reader = response.body?.getReader(), chunks = []; let size = 0;
      if (reader) {
        try {
          while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error('AI response exceeds size limit.'); chunks.push(value); }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
      }
      if (response.status === 429 || response.status >= 500) { failures++; errors++; } else failures = 0;
      if (failures >= threshold) openUntil = clock() + cooldownMs;
      return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), { status: response.status, headers: response.headers });
    } catch (error) { failures++; errors++; if (failures >= threshold) openUntil = clock() + cooldownMs; throw error; }
    finally { active--; totalMs += Math.max(0, clock() - start); }
  };
  transport.status = () => ({ active, calls, errors, averageMs: calls ? Math.round(totalMs / calls) : 0, circuit: clock() < openUntil ? 'open' : 'closed', retryAfterMs: Math.max(0, openUntil - clock()) });
  return transport;
}
export const modelFetch = createModelTransport();
