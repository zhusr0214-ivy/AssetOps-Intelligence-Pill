const han=text=>(String(text||'').match(/\p{Script=Han}/gu)||[]).length;
const latin=text=>(String(text||'').match(/[A-Za-z]/g)||[]).length;
export function needsChineseDiscussion(input) {
  const text=(input?.messages||[]).map(m=>m.text||'').join('\n');
  return !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)&&han(text)>=20&&han(text)>latin(text)*0.5;
}
export function discussionLanguageMatches(input,reply) {
  if(!needsChineseDiscussion(input))return true;
  return ['understanding','question','reason'].every(key=>!reply?.[key]||han(reply[key])>=Math.min(8,reply[key].length)&&han(reply[key])>latin(reply[key])*0.5);
}
