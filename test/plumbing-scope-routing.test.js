import test from 'node:test';import assert from 'node:assert/strict';
import {matchPill,matchedPills} from '../pill-routing.js';
const pill=(id,scope,keywords=[])=>({id,domain:'water_leak',scope,applicability:{categories:['water_leak'],assetPrefixes:[],keywords}});
const leak=pill('leak','适用于茶水间水槽下方漏水报告的初步排查阶段。'),drain=pill('drain','建筑内水槽排水缓慢、返水或排水口间歇异味的初步判断。');
test('odor and gurgling route to drainage without activating a leakage-only scope',()=>{
 const incident={category:'water_leak',description:'水槽排水口间歇性异味，排水时咕噜声，是否返水未知。'};assert.deepEqual(matchedPills(incident,[leak,drain]).map(v=>v.pill.id),['drain']);
});
test('leaks still route and combined symptoms retain both capabilities',()=>{
 assert.ok(matchPill({category:'water_leak',description:'水槽下方持续滴水'},leak));assert.deepEqual(matchedPills({category:'water_leak',description:'水槽漏水且排水缓慢'},[leak,drain]).map(v=>v.pill.id),['drain','leak']);
});
test('explicit keywords and generic or missing scope facts preserve existing policy',()=>{
 assert.ok(matchPill({category:'water_leak',description:'异味'},pill('explicit','漏水',['异味'])));assert.ok(matchPill({category:'water_leak',description:'需初步记录'},pill('broad','给排水设施问题初步评估')));assert.ok(matchPill({category:'water_leak'},leak));assert.equal(matchPill({category:'electrical_distribution',description:'漏水'},leak),null);
});
