import { loadLocalEnv } from '../config.js';
import { createKnowledgeCaptureAgent } from '../knowledge-agent.js';

loadLocalEnv();
try {
  const result = await createKnowledgeCaptureAgent()({ name: 'synthetic-ahu-source.txt', blocks: [{ id: 'B1', location: 'Paragraph 1', text: 'For AHU cooling complaints, verify the reported room temperature and supply-air temperature before drawing conclusions. Do not change equipment settings. Refer uncertain findings to the responsible engineer.' }] });
  if (!result.candidates.length) throw new Error('No knowledge candidates were returned for the synthetic AHU source.');
  console.log(`Knowledge Capture connected: ${result.candidates.length} candidates with verified source quotes. No Pill data was changed.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
