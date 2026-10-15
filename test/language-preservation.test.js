import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {conversationReply} from '../conversation.js';
test('Chinese conversation asks for facts and confirms them in chat without priority',()=>{
 const incomplete=conversationReply({description:'Reported issue'},'\u95ee\u9898');
 assert.match(incomplete,/问题发生在哪栋楼、哪层或哪个区域？/);
 assert.ok(!incomplete.includes('Priority'));
 const complete=conversationReply({description:'Reported issue',location:'Floor 1',occurredAt:'Unknown',impact:'Delay',priority:'low'},'\u95ee\u9898');
 assert.equal(complete,'已整理你提供的信息，可以确认事件并调用 Pill 分析。');
 const conflict=conversationReply({description:'Reported issue',priority:'low',conflicts:[{field:'title'}]},'\u95ee\u9898');
 assert.match(conflict,/新信息与之前的描述不一致，请在对话中确认需要保留的内容。/);
});
test('new domain questions remain English and title prompts preserve source-language policy',()=>{
 const result=conversationReply({description:'Lift stopped',category:'lift_fault',priority:'high'},'\u7535\u68af');
 assert.match(result,/Is anyone trapped inside the lift\?/);
 const source=readFileSync(new URL('../intake-agent.js',import.meta.url),'utf8');
 assert.ok(source.includes("in the description's language"));
 assert.ok(source.includes("in the user's language"));
 assert.ok(!source.includes('Title must be a short incident label in English'));
});
