import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCaptureLanguage} from '../knowledge-agent.js';
const blocks=[{text:'Expert: QA\nReference: fixture\n接到水槽下方漏水的报告，先问清楚位置、什么时候开始、现在是否还在滴水，以及地面积水有没有扩大。不要猜测漏水原因。'}];
test('Chinese narrative with English metadata rejects translated candidates',()=>{assert.throws(()=>validateCaptureLanguage({candidates:[{title:'Leak assessment',text:'Record the location.'}]},blocks),/Chinese/);});
test('Chinese content with technical IDs is retained and English sources stay valid',()=>{const value={candidates:[{title:'漏水信息收集',text:'记录设备 PIPE-01 的位置，不猜测原因。'}]};assert.equal(validateCaptureLanguage(value,blocks),value);const english={candidates:[{title:'Leak assessment',text:'Record location.'}]};assert.equal(validateCaptureLanguage(english,[{text:'Record the sink location and onset time.'}]),english);});
