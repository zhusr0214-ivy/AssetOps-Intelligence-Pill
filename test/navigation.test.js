import test from 'node:test';
import assert from 'node:assert/strict';
import { jumpToSection } from '../public/navigation.js';
test('section jump prevents fragment navigation and opens collapsed destination', () => {
 let prevented=false, scrolled=false;
 const section={tagName:'DETAILS',open:false,parentElement:null,scrollIntoView(){scrolled=true;}};
 const link={target:'',hasAttribute:()=>false,getAttribute:()=> '#report-questions'};
 const event={button:0,target:{closest:()=>link},preventDefault(){prevented=true;}};
 assert.equal(jumpToSection(event,{getElementById:id=>id==='report-questions'?section:null}),true);
 assert.ok(prevented && scrolled && section.open);
});
test('missing destinations and modified clicks retain browser behavior', () => {
 const event={button:0,target:{closest:()=>({hasAttribute:()=>false,getAttribute:()=> '#missing'})},preventDefault(){throw Error('unexpected interception');}};
 assert.equal(jumpToSection(event,{getElementById:()=>null}),false);
 assert.equal(jumpToSection({...event,ctrlKey:true},{}),false);
});
