import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCaptureTypes} from '../knowledge-agent.js';
test('a buried referral task without an action requests bounded repair',()=>{assert.throws(()=>validateCaptureTypes({candidates:[{type:'boundary',text:'严禁安排拆管。当已有位置时，应整理记录并转交管道专业人员。'}]}),/action candidate/);});
test('pure prohibitions need no manufactured action and separated tasks remain unchanged',()=>{const boundary={candidates:[{type:'boundary',text:'禁止操作设备。'}]};assert.equal(validateCaptureTypes(boundary),boundary);const separated={candidates:[{type:'boundary',text:'禁止操作设备。'},{type:'action',text:'整理记录并转交专业人员。'}]};assert.equal(validateCaptureTypes(separated),separated);});

test('an entirely unlinked rule/action extraction requests source completeness repair',()=>{assert.throws(()=>validateCaptureTypes({candidates:[{type:'rule',text:'Reported hazard requires escalation',relatedActionKeys:[]},{type:'action',text:'Contact the responsible person',relatedRuleKeys:[]}]}),/unlinked/);});
