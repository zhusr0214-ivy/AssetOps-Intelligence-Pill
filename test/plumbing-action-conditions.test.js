import test from 'node:test';import assert from 'node:assert/strict';import {plumbingConditionIssues} from '../triage-output-contract.js';
const pill={domain:'water_leak',rules:[{id:'single',title:'单个水槽原因'},{id:'multi',title:'多点排水缓慢'},{id:'disuse',title:'长期未使用异味'}],actions:[{id:'a1',title:'单点异常的记录与对比任务'},{id:'a2',title:'异味问题的记录与转介任务'}]};
const snapshot=description=>({fields:{description}});
test('unconfirmed point count and unreported disuse cannot enable conditional rules or tasks',()=>{
 const value={hypotheses:[{ruleId:'single'},{ruleId:'multi'},{ruleId:'disuse'}],actionIds:['a1','a2']};assert.equal(plumbingConditionIssues(value,snapshot('排水口异味和咕噜声。是否排水慢、附近排水点是否异常均未确认。'),pill).length,4);
});
test('explicit single point, multiple points and disuse meet their own conditions',()=>{
 for(const [ruleId,text] of [['single','一个水槽排水慢，另一个水槽排水正常。'],['multi','两个水槽同时排水缓慢，其中一个返水。'],['disuse','茶水间三周未使用，今天发现异味。']])assert.deepEqual(plumbingConditionIssues({hypotheses:[{ruleId}],actionIds:[]},snapshot(text),pill),[]);
});
