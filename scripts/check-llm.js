import assert from 'node:assert/strict';
import { loadLocalEnv } from '../config.js';
import { createIntakeAgent } from '../intake-agent.js';
import { fileURLToPath } from 'node:url';

export function assertLiveIntakeResult(result) {
  assert.equal(result.mode, 'llm');
  assert.equal(result.fields.priority, 'high');
  assert.equal(result.fields.asset, 'AHU-18-01');
  assert.ok(['hvac', 'hvac_cooling'].includes(result.fields.category), 'Expected an HVAC cooling classification.');
  assert.equal(result.readyForTriage, true);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
loadLocalEnv();
try {
  const base = process.env.SOCLAAS_BASE_URL?.replace(/\/+$/, '');
  const key = process.env.SOCLAAS_API_KEY;
  if (!base || !key) throw new Error('Missing SOCLAAS configuration.');
  const url = new URL(`${base}/models`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid SOCLAAS base URL.');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Model list request failed (HTTP ${response.status}).`);
  const models = await response.json();
  console.log(`Model list reachable: ${Array.isArray(models.data) ? models.data.length : 0} models.`);
  const result = await createIntakeAgent()({
    description: 'Synthetic test: AHU-18-01 at Tower A floor 18 has not been cooling since 2pm today. Three tenants report discomfort. Room temperature is 29 C. No action has been taken.',
    priority: 'high'
  });
  assertLiveIntakeResult(result);
  console.log('Live intake passed: extraction, required fields and user priority verified.');
} catch (error) {
  // Never print upstream response bodies, request headers or credentials.
  const certificateError = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.cause?.code);
  console.error(certificateError ? 'TLS certificate verification failed. Check the provider certificate chain or your approved network CA; do not disable certificate verification.' : error.name === 'AssertionError' ? 'Live intake returned unexpected extracted fields.' : error.status ? error.message : 'Connection check failed. Verify credentials, URL and network access.');
  process.exitCode = 1;
}
}
