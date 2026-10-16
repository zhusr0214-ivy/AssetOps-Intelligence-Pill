import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPillStudio} from '../pill-studio.js';
import {ahuPill} from '../triage.js';
const adminActor={id:'admin1',name:'Admin'},adminRoles=['admin'];
const suite=[{name:'Supported',facts:{category:'hvac_cooling',asset:'AHU-1',description:'Room warm.',observations:'Room temperature 29 C'},expected:{status:'complete',ruleIds:['HVAC-01'],actionIds:['check-readings'],missingFields:[]}},{name:'Outside',facts:{category:'lift_fault',asset:'LIFT-1',observations:'Unresponsive'},expected:{status:'out_of_scope',ruleIds:[],actionIds:[],missingFields:[]}}];
test('admin publishes directly with scope after evaluation',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'pill-simple-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const studio=createPillStudio(join(directory,'pills.json'),{evaluationAgent:async()=>({summary:'Check readings.',hypotheses:[{ruleId:'HVAC-01',reasoning:'Review.',evidence:[{field:'observations',quote:'Room temperature 29 C'}],uncertainties:[]}],actionIds:['check-readings'],missingFields:[],prioritySuggestion:null})});
 let r=await studio.get(ahuPill.id);r.content.sources=[{expert:'QA',reference:'fixture',knowledge:'Compare readings.'}];
 const change=async(operation,input={})=>r=await studio.change(r.id,operation,{revision:r.revision,authenticatedActor:adminActor,authenticatedRoles:adminRoles,...input});
 await change('save',{content:r.content,autoValidate:true});
 await change('save-evaluations',{suite,sharedExamples:true,autoValidate:true});
 r=await studio.evaluate(r.id,{revision:r.revision,authenticatedActor:adminActor,authenticatedRoles:adminRoles});
 await change('submit');
 const published=await change('publish');
 assert.equal(published.state,'published');
});
test('non-admin cannot publish',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'pill-simple-2'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const studio=createPillStudio(join(directory,'pills.json'));
 let r=await studio.get(ahuPill.id);
 await assert.rejects(studio.change(r.id,'publish',{revision:r.revision,authenticatedActor:{id:'expert',name:'Expert'},authenticatedRoles:['expert']}),{status:403});
});
test('admin without scope cannot publish',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'pill-simple-3'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const studio=createPillStudio(join(directory,'pills.json'));
 let r=await studio.get(ahuPill.id);
 const noScope=structuredClone(r.content);noScope.pill.scope='';
 await studio.change(r.id,'save',{revision:r.revision,content:noScope,authenticatedActor:adminActor,authenticatedRoles:adminRoles});
 await assert.rejects(studio.change(r.id,'publish',{revision:r.revision+1,authenticatedActor:adminActor,authenticatedRoles:adminRoles}),{status:422});
});
