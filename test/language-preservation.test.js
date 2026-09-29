import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {conversationReply} from '../conversation.js';
test('original Chinese messages remain unchanged',()=>{
 const incomplete=conversationReply({description:'Reported issue'},'\u95ee\u9898');
 assert.match(incomplete,/已更新事件摘要。/);
 assert.match(incomplete,/问题发生在哪栋楼、哪层或哪个区域？/);
 assert.match(incomplete,/请在摘要中选择 Priority。/);
 const complete=conversationReply({description:'Reported issue',location:'Floor 1',occurredAt:'Unknown',impact:'Delay',priority:'low'},'\u95ee\u9898');
 assert.equal(complete,'事件信息已经齐全，请核对摘要，确认后提交分诊。');
 const conflict=conversationReply({description:'Reported issue',priority:'low',conflicts:[{field:'title'}]},'\u95ee\u9898');
 assert.match(conflict,/有信息与当前摘要不一致，请先在事件摘要中确认待核对项。/);
});
test('new domain questions remain English and title prompts preserve source-language policy',()=>{
 const result=conversationReply({description:'Lift stopped',category:'lift_fault',priority:'high'},'\u7535\u68af');
 assert.match(result,/Is anyone trapped inside the lift\?/);
 const source=readFileSync(new URL('../intake-agent.js',import.meta.url),'utf8');
 assert.ok(source.includes("in the description's language"));
 assert.ok(source.includes("in the user's language"));
 assert.ok(!source.includes('Title must be a short incident label in English'));
});
