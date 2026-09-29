import { loadLocalEnv } from '../config.js';
import { createTriageAgent } from '../triage-agent.js';
import { ahuPill, validateTriageResult } from '../triage.js';

loadLocalEnv();
try {
  const snapshot = { fields: {
    description: 'Synthetic demo: AHU-18-01 cooling complaint in the east zone.', title: 'AHU cooling complaint',
    category: 'hvac_cooling', location: 'Tower A, Level 18', asset: 'AHU-18-01', occurredAt: 'Today at 2pm',
    impact: 'Three tenants report discomfort.', observations: 'Room temperature is 29 C. Setpoint is 24 C. No supply-air reading is available.',
    actionsTaken: 'No action has been taken.', affectedScope: 'East office zone', priority: 'high'
  } };
  const report = validateTriageResult(await createTriageAgent()(snapshot, ahuPill), snapshot, ahuPill);
  console.log(`Live triage passed: ${report.hypotheses.length} hypotheses, ${report.actions.length} catalog actions, ${report.missingFields.length} information requests. No case was saved.`);
} catch (error) {
  console.error(error.status ? error.message : 'Live triage check failed. Check server configuration and connectivity.');
  process.exitCode = 1;
}
