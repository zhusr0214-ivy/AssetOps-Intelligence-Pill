import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPillStudio} from '../pill-studio.js';
import {createIncidentStore} from '../incident-store.js';
import {openDatabase} from '../database.js';
import {createImprovementService} from '../improvements.js';
import {buildBatchItems,validateImprovementPlan} from '../improvement-plan.js';
import {releaseHash} from '../pill-versions.js';
import {permitted} from '../auth.js';
import {Readable} from 'node:stream';
import {createHandler} from '../server.js';
const admin={authenticatedActor:{id:'admin',name:'Admin'},authenticatedRoles:['admin']};
const expert={authenticatedActor:{id:'expert',name:'Expert'},authenticatedRoles:['expert']};
async function setup(t,sqlite=false){
 const dir=await mkdtemp(join(tmpdir(),'improvements-'));const db=sqlite?openDatabase(join(dir,'test.sqlite')):null;
 t.after(async()=>{db?.close();await rm(dir,{recursive:true,force:true});});
 const studio=createPillStudio(join(dir,'pills.json'),{persistence:db}),store=createIncidentStore(join(dir,'cases.json'),{persistence:db});
 const ids=[];
 for(const name of ['Lighting','Electrical']){
  let r=await studio.create({name,...admin});
  const content={pill:{id:r.id,name,owner:'Expert',scope:'Floor lighting assessment.',domain:'electrical_distribution',rules:[{id:'r',title:'Rule',guidance:'If lighting fails, record the floor.',cardExplanation:'',actionIds:['a']}],actions:[{id:'a',title:'Record',instruction:'Record the floor.',owner:'Expert',requiresApproval:true,ruleIds:['r']}],boundaries:[],escalationConditions:[]},sources:[],examples:[]};
  r=await studio.change(r.id,'save',{...admin,revision:r.revision,content});r=await studio.change(r.id,'publish',{...admin,revision:r.revision});ids.push(r.id);
 }
 const incident=await store.create({title:'Floor lighting failure',expertSolutions:[{id:'exp',expert:'Expert',actorId:'expert',solution:'Record the room and floor. Keep clear of damaged wiring.',messageId:'m',createdAt:new Date().toISOString()}]});
 const plan={summary:'Improve location collection and safety boundaries.',targets:ids.map((id,index)=>({key:`t${index}`,pillId:id,name:index?'Electrical':'Lighting',dependsOn:index?['t0']:[],changes:[{field:index?'boundaries':'actions',entryId:index?null:'a',after:index?'Keep clear of damaged wiring.':'Record the room and floor.',reason:'Expert clarified the procedure.',quote:index?'Keep clear of damaged wiring.':'Record the room and floor.'}]}))};
 const agent=async()=>structuredClone(plan);
 const service=createImprovementService(store,studio,agent);
 let i=await service.create(incident.id,{...expert,revision:0,solutionId:'exp',confirmed:true});const id=i.improvementBatches[0].id;
 const analyze=async()=>{const b=await service.get(i.id,id);return service.analyze(i.id,id,{...expert,revision:b.revision});};
 const save=(b,edit=()=>{})=>{const changes=b.targets.flatMap(t=>t.changes.map(c=>({id:c.id,after:c.after,decision:'accepted'})));edit(changes);return service.save(i.id,id,{...expert,revision:b.revision,changes});};
 const publish=b=>service.publish(i.id,id,{...admin,revision:b.revision});
 return {dir,db,studio,store,service,ids,plan,agent,caseId:i.id,id,analyze,save,publish};
}
for(const sqlite of [false,true])test(`confirmed experience -> multi-Pill review -> atomic version release (${sqlite?'SQLite':'JSON'})`,async t=>{
 const f=await setup(t,sqlite);const originals=await f.studio.library();
 let b=await f.analyze();assert.equal(b.targets.length,2);assert.equal(b.status,'in_review');assert.deepEqual(await f.studio.library(),originals);
 b=await f.save(b);await assert.rejects(f.service.publish(f.caseId,f.id,{...expert,revision:b.revision,validated:true}),{status:403});
 b=await f.publish(b);assert.equal(b.status,'published');assert.equal(b.releases.length,2);assert.equal(b.review.outcomeVerified,false);assert.equal(b.review.actorId,'admin');
 const again=await f.publish(b);assert.deepEqual(again.releases,b.releases);
 for(const id of f.ids){const r=await f.studio.get(id);assert.equal(r.releases.length,2);assert.equal(r.releases[0].active,false);assert.equal(r.releases[1].active,true);assert.equal(r.releases[1].contentHash,releaseHash(r.releases[1]));assert.equal(r.releases[1].improvement.batchId,b.id);}
 const reopened=createImprovementService(createIncidentStore(join(f.dir,'cases.json'),{persistence:f.db}),f.studio);
 assert.equal((await reopened.get(f.caseId,f.id)).status,'published');
});
test('confirmation is idempotent and does not create individual Pill drafts',async t=>{
 const f=await setup(t);const i=await f.service.create(f.caseId,{...expert,solutionId:'exp',confirmed:true,revision:0});
 assert.equal(i.improvementBatches.length,1);assert.equal(i.expertSolutions[0].pillDraftId,undefined);assert.ok(i.expertSolutions[0].experienceConfirmation);
 assert.equal((await f.studio.list()).filter(r=>f.ids.includes(r.id)&&r.state!=='published').length,0);
});
test('one stale target blocks every target without releasing half a batch',async t=>{
 const f=await setup(t);let b=await f.save(await f.analyze());
 const r=await f.studio.get(f.ids[1]);await f.studio.change(r.id,'fork',{...admin,revision:r.revision});
 await assert.rejects(f.publish(b),{status:409});
 assert.equal((await f.studio.get(f.ids[0])).releases.length,1);
 assert.equal((await f.service.get(f.caseId,f.id)).status,'in_review');
});
test('unreviewed changes, stale edits and excluded dependencies block publishing',async t=>{
 const f=await setup(t);let b=await f.analyze();await assert.rejects(f.publish(b));
 await assert.rejects(f.save({...b,revision:999}),{status:409});
 b=await f.save(b,changes=>changes[0].decision='excluded');await assert.rejects(f.publish(b),/Dependent/);
 assert.equal((await f.studio.get(f.ids[0])).releases.length,1);
});
test('all-excluded proposal can close without changing versions',async t=>{
 const f=await setup(t);let b=await f.save(await f.analyze(),changes=>changes.forEach(c=>c.decision='excluded'));
 b=await f.service.close(f.caseId,f.id,{...expert,revision:b.revision});assert.equal(b.status,'closed');
 assert.equal((await f.studio.get(f.ids[0])).releases.length,1);
});
test('JSON publication receipt recovers after Case receipt write fails',async t=>{
 const f=await setup(t);let b=await f.save(await f.analyze());const update=f.store.update;let failOnce=true;
 f.store.update=(id,data,revision)=>{if(failOnce&&data.improvementBatches?.some(b=>b.status==='published')){failOnce=false;throw new Error('Simulated write failure');}return update(id,data,revision);};
 await assert.rejects(f.publish(b),/Simulated/);assert.equal((await f.studio.get(f.ids[0])).releases.length,2);
 b=await f.service.get(f.caseId,f.id);assert.equal(b.status,'publishing');b=await f.publish(b);assert.equal(b.status,'published');assert.equal((await f.studio.get(f.ids[0])).releases.length,2);
});
test('new Pill requires scope/actions/rules and preserves source evidence',async t=>{
 const f=await setup(t);f.plan.targets=[{key:'new',pillId:null,name:'New lighting guidance',dependsOn:[],changes:['scope','actions','rules'].map(field=>({field,entryId:null,after:field==='rules'?'If lighting fails, record the room and floor.':'Record the room and floor.',reason:'New domain experience.',quote:'Record the room and floor.'}))}];
 const b=await f.publish(await f.save(await f.analyze()));const r=await f.studio.get(b.releases[0].id);assert.equal(r.releases.length,1);assert.match(r.content.sources[0].reference,/BATCH/);
});
test('unknown targets, fabricated evidence and invalid dependencies are rejected',async t=>{
 const f=await setup(t);const input={experience:{solution:'Record the room and floor. Keep clear of damaged wiring.'},pills:(await f.studio.library()).filter(p=>p.active)};
 const bad=structuredClone(f.plan);bad.targets[0].changes[0].quote='Invented result';assert.throws(()=>validateImprovementPlan(bad,input));
 bad.targets[0].changes[0].quote='Record the room and floor.';bad.targets[0].pillId='unknown';assert.throws(()=>validateImprovementPlan(bad,input));
 bad.targets[0].pillId=f.ids[0];bad.targets[0].dependsOn=['missing'];assert.throws(()=>validateImprovementPlan(bad,input));
});
test('batch endpoints limit editing to experts/admins and publishing to admins',()=>{
 const user=role=>({roles:[role],disabled:false});const url='/api/improvements/c/b/';
 assert.equal(permitted(user('operator'),url+'save','POST'),false);assert.equal(permitted(user('expert'),url+'save','POST'),true);
 assert.equal(permitted(user('expert'),url+'publish','POST'),false);assert.equal(permitted(user('admin'),url+'publish','POST'),true);
});
test('HTTP confirmation opens a batch and rejects forged publish identities',async t=>{
 const f=await setup(t);
 const noChanges=async()=>({summary:'No changes needed.',targets:[]});
 const handler=createHandler(f.store,undefined,undefined,f.studio,undefined,undefined,noChanges);
 async function request(url,body,who=expert){
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{method:body===undefined?'GET':'POST',url,headers:{host:'localhost'},...who});let status,result;
  await handler(req,{writeHead(s){status=s;},end(text){result=JSON.parse(text);}});return {status,...result};
 }
 const i=await f.store.create({title:'Another case',expertSolutions:[{id:'exp2',solution:'Record floor.',expert:'Expert',actorId:'expert'}]});
 const confirmed=await request(`/api/cases/${i.id}/expert-experience-confirmation`,{solutionId:'exp2',confirmed:true,revision:0});
 assert.equal(confirmed.status,200);assert.ok(confirmed.incident.expertSolutions[0].improvementBatchId);assert.equal(confirmed.incident.expertSolutions[0].pillDraftId,undefined);
 const result=await request(`/api/improvements/${f.caseId}/${f.id}/publish`,{authenticatedRoles:['admin'],authenticatedActor:admin.authenticatedActor,validated:true,revision:0});
 assert.equal(result.status,403);
 const list=await request('/api/improvements');assert.equal(list.batches.length,2);
});
test('invalid second target prevents any writes and retries can re-analyze safely',async t=>{
 const f=await setup(t);f.plan.targets[1]={key:'new',pillId:null,name:'Incomplete new Pill',dependsOn:[],changes:[{field:'scope',entryId:null,after:'Room and floor',reason:'New scope',quote:'Record the room and floor.'}]};
 const b=await f.save(await f.analyze());await assert.rejects(f.publish(b),/valid action/);
 assert.equal((await f.studio.get(f.ids[0])).releases.length,1);assert.equal((await f.studio.list()).some(r=>r.content.pill.name==='Incomplete new Pill'),false);
});
