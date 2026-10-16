import test from 'node:test';
import assert from 'node:assert/strict';
import {applyExtractedDraft,ensureActionLinks} from '../pill-draft.js';
test('extraction maintains reciprocal rule/action links without a manual reference picker',()=>{
 const record={content:{pill:{name:'Lighting',scope:'Lighting',rules:[],actions:[],boundaries:[],escalationConditions:[]},sources:[],examples:[]},documents:[{id:'d',name:'notes',status:'extracted',candidates:[
 {id:'K-r',type:'rule',title:'Affected lights',text:'When lights fail',relatedActionIds:['K-a']},
 {id:'K-a',type:'action',title:'Record',text:'Record the location',relatedRuleIds:[]}
 ]}]};
 applyExtractedDraft(record);ensureActionLinks(record.content.pill);
 assert.deepEqual(record.content.pill.rules[0].actionIds,['CAP-a']);assert.deepEqual(record.content.pill.actions[0].ruleIds,['CAP-r']);
 applyExtractedDraft(record);assert.equal(record.content.pill.rules.length,1);
});
