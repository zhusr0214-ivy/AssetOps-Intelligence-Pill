import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPillStudio} from '../pill-studio.js';
import {matchPill} from '../pill-routing.js';

const actor={id:'admin',name:'Admin'};
const candidate=(id,type,text)=>({id,type,title:type,text,evidence:[{blockId:'b',location:'Paragraph 1',quote:text}],relatedRuleIds:[],relatedActionIds:[],missing:[]});
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'pill-direct-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const options={parser:async()=>({blocks:[{id:'b',location:'Paragraph 1',text:'Lighting failure: record the affected floor.'}],warnings:[]}),captureAgent:async()=>({routing:{categories:['electrical_distribution']},candidates:[candidate('K-s','scope','Initial assessment of floor lighting failure.'),candidate('K-a','action','Record the affected floor.'),{...candidate('K-r','rule','If lighting fails, record the affected floor.'),relatedActionIds:['K-a']}],questions:[],conflicts:[]})};
  return {file:join(dir,'pills.json'),options,studio:createPillStudio(join(dir,'pills.json'),options)};
}
const change=(studio,r,op,body={})=>studio.change(r.id,op,{revision:r.revision,authenticatedActor:actor,authenticatedRoles:['admin'],...body});
test('name + source -> extracted editable draft -> admin publish -> matching library version',async t=>{
  const {studio,file,options}=await setup(t);
  let r=await studio.create({name:'Floor lights',authenticatedActor:actor});
  r=await studio.upload(r.id,r.revision,'lighting.txt',Buffer.from('Lighting notes'));
  r=await studio.analyze(r.id,r.documents[0].id,r.revision);
  assert.equal(r.state,'draft');assert.equal(r.content.pill.actions.length,1);assert.ok(r.documents[0].draftApplied);
  assert.equal((await studio.library()).length,0);
  r=await change(studio,r,'prepare-draft');assert.equal(r.content.pill.actions.length,1);
  const content=structuredClone(r.content);content.pill.scope='Floor lighting assessment, excluding repairs.';content.pill.actions[0].instruction='Record the affected floor and room.';
  r=await change(studio,r,'save',{content});
  const reopened=await createPillStudio(file,options).get(r.id);assert.equal(reopened.content.pill.scope,content.pill.scope);
  r=await change(studio,r,'publish');
  assert.equal(r.state,'published');const [released]=await studio.library();
  assert.ok(matchPill({category:'electrical_distribution'},released));assert.equal(matchPill({category:'hvac_cooling'},released),null);
  assert.equal(released.actions[0].requiresApproval,true);assert.equal(released.rules[0].guidance,content.pill.rules[0].guidance);
  assert.equal(r.releases[0].evaluation.method,'admin_direct_publication');
});
test('Library edit keeps old release live; discarding only deletes draft; publishing advances version',async t=>{
  const {studio}=await setup(t);let r=await studio.create({name:'Lighting',authenticatedActor:actor});
  r=await studio.upload(r.id,r.revision,'a.txt',Buffer.from('Notes'));r=await studio.analyze(r.id,r.documents[0].id,r.revision);r=await change(studio,r,'publish');
  const original=structuredClone(r.releases[0]);
  r=await change(studio,r,'fork');let content=structuredClone(r.content);content.pill.scope='Revised scope';r=await change(studio,r,'save',{content});
  assert.equal((await studio.library())[0].scope,original.pill.scope);
  assert.equal((await studio.delete(r.id,{revision:r.revision})).preservedReleases,true);
  r=await studio.get(r.id);assert.equal(r.state,'published');assert.deepEqual(r.releases[0],original);
  r=await change(studio,r,'fork');content=structuredClone(r.content);content.pill.scope='Lighting on floor 12';r=await change(studio,r,'save',{content});r=await change(studio,r,'publish');
  assert.equal(r.releases.length,2);assert.equal(r.releases[0].active,false);assert.equal(r.releases[1].active,true);assert.equal(r.releases[0].pill.scope,original.pill.scope);
});
test('only admins publish; empty scope/action text is rejected, old evaluation is not a gate',async t=>{
  const {studio}=await setup(t);let r=await studio.create({name:'Lighting',authenticatedActor:actor});
  await assert.rejects(change(studio,r,'publish'),/scope/);
  r=await studio.upload(r.id,r.revision,'a.txt',Buffer.from('Notes'));r=await studio.analyze(r.id,r.documents[0].id,r.revision);
  await assert.rejects(change(studio,r,'publish',{authenticatedRoles:['expert']}),/administrators/);
  const content=structuredClone(r.content);content.pill.actions[0].instruction='';r=await change(studio,r,'save',{content});
  await assert.rejects(change(studio,r,'publish'),/valid action/);
  content.pill.actions[0].instruction='Record the reported location.';r=await change(studio,r,'save',{content});
  r=await change(studio,r,'save-evaluations',{suite:[{name:'Old incomplete test',facts:{category:'electrical_distribution'},expected:{status:'complete',ruleIds:[],actionIds:[],missingFields:[]}}],draftOnly:true});
  assert.equal(r.evaluationRequired,true);r=await change(studio,r,'publish');assert.equal(r.state,'published');
});
test('delete unpublished draft and reject stale writes or malformed action entries',async t=>{
  const {studio}=await setup(t);const r=await studio.create({name:'Lighting',authenticatedActor:actor});
  await assert.rejects(studio.delete(r.id,{revision:999}),/changed/);
  const content=structuredClone(r.content);content.pill.actions=[null];await assert.rejects(change(studio,r,'save',{content}),/Invalid action/);
  await studio.delete(r.id,{revision:r.revision});await assert.rejects(studio.get(r.id),/not found/);
});
test('publication requires explicit decision rules but not operating limits or escalation',async t=>{
  const {studio}=await setup(t);let r=await studio.create({name:'Lighting',authenticatedActor:actor});
  r=await studio.upload(r.id,r.revision,'a.txt',Buffer.from('Notes'));r=await studio.analyze(r.id,r.documents[0].id,r.revision);
  const content=structuredClone(r.content),rules=structuredClone(r.content.pill.rules);
  content.pill.rules=[];content.pill.actions[0].ruleIds=[];r=await change(studio,r,'save',{content});
  await assert.rejects(change(studio,r,'publish'),/decision rule/);
  content.pill.rules=[{...rules[0],guidance:' '}];r=await change(studio,r,'save',{content});
  await assert.rejects(change(studio,r,'publish'),/decision rule/);
  content.pill.rules=rules;content.pill.boundaries=[];content.pill.escalationConditions=[];
  r=await change(studio,r,'save',{content});r=await change(studio,r,'publish');assert.equal(r.state,'published');
});
