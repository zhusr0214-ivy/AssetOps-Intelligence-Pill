import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createIntakeAgent} from '../intake-agent.js';
import {createIncidentStore} from '../incident-store.js';
import {createHandler} from '../server.js';
import {assessIntake} from '../intake.js';
import {details} from '../public/incidents.js';
import {visibleAssistantText} from '../public/conversation.js';
const base={title:'',category:'hvac_cooling',asset:'',location:'',occurredAt:'',impact:'',observations:'',actionsTaken:'',affectedScope:''};
const make=proposal=>createIntakeAgent({env:{SOCLAAS_API_KEY:'test',SOCLAAS_BASE_URL:'https://example.test/v1'},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({...base,...proposal})}}]})})});
const ctx=(first,next,manualFields=[])=>({manualFields,messages:[{role:'user',content:first},{role:'user',content:next}]});
test('scope appends across turns without overwriting observations',async()=>{
 const first='The east office zone is affected.';
 const second='Two meeting rooms are also affected.';
 const r=await make({affectedScope:second})({description:first,affectedScope:first,observations:'Temperature is high'},ctx(first,second));
 assert.equal(r.fields.affectedScope,first+'\n'+second);
 assert.equal(r.fields.observations,'Temperature is high');assert.equal(r.conflicts.length,0);
});
test('manual scope needs confirmation; unsupported scope is discarded',async()=>{
 const first='Level 14 is affected.';
 const next='Level 15 is also affected.';
 const r=await make({affectedScope:next})({description:first,affectedScope:first},ctx(first,next,['affectedScope']));
 assert.equal(r.fields.affectedScope,first);assert.equal(r.conflicts.length,1);
 const invalid=await make({affectedScope:'All 50 floors'})({description:first},ctx(first,next));
 assert.equal(invalid.fields.affectedScope,'');
});
test('scope field supports old incidents and summary display without becoming required',()=>{
 const old=assessIntake({description:'AHU warm',location:'Level 18',impact:'Complaints',occurredAt:'Unknown',priority:'high'});
 assert.equal(old.fields.affectedScope,'');assert.equal(old.readyForTriage,true);
 assert.match(details({...old.fields,affectedScope:'East zone'}),/Affected scope/);
 assert.match(details({...old.fields,affectedScope:'East zone'}),/East zone/);
});
test('priority reminder is hidden only in the latest assistant message and data stays intact',()=>{
 const old={role:'assistant',content:'Please choose Priority in the summary.'};
 const latest={role:'assistant',content:'The case summary is updated.\nIs anyone trapped?\nPlease choose Priority in the summary.'};
 const incident={priority:'high',messages:[old,latest]};
 assert.equal(visibleAssistantText(old,incident),old.content);
 assert.match(visibleAssistantText(latest,incident),/Is anyone trapped/);
 assert.ok(!visibleAssistantText(latest,incident).includes('choose Priority'));
 assert.match(latest.content,/choose Priority/);
 assert.match(visibleAssistantText(latest,{...incident,priority:''}),/choose Priority/);
});
async function request(handler,method,url,data){
 const req=Readable.from(data===undefined?[]:[JSON.stringify(data)]);
 Object.assign(req,{method,url,headers:{host:'localhost'}});
 let status,payload;
 await handler(req,{writeHead(code){status=code},end(body){payload=JSON.parse(body)}});
 return {status,...payload};
}
test('scope survives actual API create, edit, reload and finalize',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'intake-scope-'));
 const file=join(dir,'incidents.json');
 t.after(async()=>{await unlink(file);await rmdir(dir)});
 const handler=createHandler(createIncidentStore(file));
 const created=await request(handler,'POST','/api/incidents',{description:'AHU warm',location:'Level 18',impact:'Complaints',occurredAt:'Unknown',priority:'high',affectedScope:'East zone'});
 assert.equal(created.status,201);
 const path='/api/incidents/'+created.incident.id;
 const saved=await request(handler,'PATCH',path,{affectedScope:'East zone and two meeting rooms'});
 assert.equal(saved.status,200);
 const reloaded=await request(createHandler(createIncidentStore(file)),'GET',path);
 assert.equal(reloaded.incident.affectedScope,'East zone and two meeting rooms');
 const finalized=await request(handler,'POST',path+'/finalize',{});
 assert.equal(finalized.status,200);assert.equal(finalized.incident.affectedScope,reloaded.incident.affectedScope);
});
