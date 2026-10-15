import {ahuPill} from '../triage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createIncidentStore } from '../incident-store.js';
import { createHandler } from '../server.js';
import { createIntakeAgent } from '../intake-agent.js';

test('intake through correction and re-analysis preserves unrelated facts', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'assetops-flow-'));
 const store = createIncidentStore(join(dir, 'cases.json'));
 let correction = false;
 const intake = createIntakeAgent({env:{SOCLAAS_API_KEY:'mock',SOCLAAS_BASE_URL:'https://example.test/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({title:'Cooling issue',category:'hvac_cooling',location:'Level 18',asset:'AHU-18-02',occurredAt:'',impact:'Two occupants report discomfort.',observations:correction?'the room temperature is 26°C':'The room temperature is 28.4°C.\nThe fan is running.',actionsTaken:'',affectedScope:'',corrections:correction?['observations']:[],contradictions:[]})}}]})})});
 const handler = createHandler(store, intake, async snapshot => ({summary:'Reported cooling issue requires review.',hypotheses:[{ruleId:'HVAC-01',reasoning:'Review reported readings.',evidence:[{field:'observations',quote:snapshot.fields.observations.split('\n').find(line=>line.includes('room temperature'))}],uncertainties:['Reading timestamp is not provided.']}],actionIds:['check-readings'],missingFields:[],prioritySuggestion:null}),{runtimePills:async()=>[ahuPill]});
 async function req(method,url,data) {
  const stream=Readable.from(data===undefined?[]:[JSON.stringify(data)]);
  Object.assign(stream,{method,url,headers:{host:'localhost'}});
  let status,body;
  await handler(stream,{writeHead(n){status=n;},end(text){body=JSON.parse(text);}});
  return {status,...body};
 }
 const created=await req('POST','/api/incidents',{description:'AHU-18-02 on Level 18. Two occupants report discomfort. The start time is unknown.',priority:'medium'});
 const path=`/api/incidents/${created.incident.id}`;
 const triage=`/api/triage/${created.incident.id}`;
 const message=await req('POST',`${path}/messages`,{requestId:'flow-first',content:'AHU-18-02 on Level 18. Two occupants report discomfort. The start time is unknown. The room temperature is 28.4°C. The fan is running.'});
 assert.equal(message.status,200);
 const confirmed=await req('POST',`${path}/finalize`,{revision:message.incident.revision});
 assert.equal(confirmed.status,200);
 const first=await req('POST',`${triage}/runs`,{revision:confirmed.incident.revision});
 assert.equal(first.status,200);assert.equal(first.report.status,'complete');
 correction=true;
 const edited=await req('POST',`${path}/messages`,{requestId:'flow-second',content:'Actually, the room temperature is 26°C.'});
 const proposed=edited.incident.conflicts.find(c=>c.field==='observations').proposed;
 assert.match(proposed,/26°C/);assert.match(proposed,/fan is running/);assert.ok(!proposed.includes('28.4'));
 const accepted=await req('PATCH',path,{revision:edited.incident.revision,observations:proposed});
 const finalized=await req('POST',`${path}/finalize`,{revision:accepted.incident.revision});
 assert.equal(finalized.status,200);
 const stale=await req('GET',triage);assert.equal(stale.reports[0].stale,true);
 assert.equal((await req('POST',`${triage}/reports/${first.report.id}/chat`,{question:'What is the temperature?'})).status,409);
 const second=await req('POST',`${triage}/runs`,{revision:finalized.incident.revision});
 assert.equal(second.status,200);assert.equal(second.report.stale,false);
 assert.match(second.report.snapshot.fields.observations,/26°C/);
 assert.match(second.report.snapshot.fields.observations,/fan is running/);
 assert.equal((await req('GET',triage)).reports.length,2);
});
