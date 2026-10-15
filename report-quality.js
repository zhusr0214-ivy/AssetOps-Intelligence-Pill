// Validate presentation without inventing a diagnosis, facts or rule matches.
export function reportQualityIssues(value,snapshot){
 const list=v=>Array.isArray(v)?v:[];
 const issues=[],description=String(snapshot.fields?.description||'');
 const chinese=(description.match(/\p{Script=Han}/gu)||[]).length>=12&&!/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(description);
 if(chinese){
  const narrative=[value.summary,...list(value.hypotheses).flatMap(h=>[h?.reasoning,...list(h?.uncertainties)]),...list(value.informationNeeds).map(n=>n?.reason),...list(value.followUpQuestions).map(n=>n?.reason),value.prioritySuggestion?.reason];
  if(narrative.some(s=>typeof s==='string'&&/[A-Za-z]{3,}/.test(s)&&!/\p{Script=Han}/u.test(s)))issues.push('reportLanguage: The case is Chinese. Write summary, reasoning, uncertainties and follow-up reasons in Chinese; retain exact original evidence quotes and catalog IDs. Do not translate enum keys.');
 }
 const dateKeys=text=>[...String(text||'').matchAll(/(\d{4})[年/\-](\d{1,2})[月/\-](\d{1,2})(?:日)?/g)].map(m=>`${Number(m[1])}-${Number(m[2])}-${Number(m[3])}`);
 const knownDates=new Set(Object.values(snapshot.fields||{}).filter(v=>typeof v==='string').flatMap(dateKeys));
 const reportText=[value.summary,...list(value.hypotheses).flatMap(h=>[h?.reasoning,...list(h?.uncertainties)]),...list(value.informationNeeds).map(n=>n?.reason),...list(value.followUpQuestions).map(n=>n?.reason)].filter(Boolean).join(' ');
 if(dateKeys(reportText).some(date=>!knownDates.has(date)))issues.push('unsupportedDate: The report includes a calendar date not supplied in the case. Remove the invented date; preserve the reported time of day without guessing a day, month or year.');
 const safeClaim=/(?:无|没有|不存在)(?:紧急)?安全风险|现场(?:已经|已)?安全|\bno (?:urgent )?safety risk\b|\b(?:site|area) is safe\b/i;
 const sourceText=Object.values(snapshot.fields||{}).filter(v=>typeof v==='string').join(' ');
 if(safeClaim.test(reportText)&&!safeClaim.test(sourceText))issues.push('unsupportedSafety: No reported hazard is not proof that there is no safety risk. Remove the unsupported safety assurance; keep safety unconfirmed unless explicitly reported in the case. Do not change a supported branch merely because safety is unconfirmed.');
 const unverified=/(?:尚未|还未|未曾|没有|未)(?:核查|核实|检查|确认|查看|验证)|尚不清楚|尚未明确|不知道|\b(?:not yet (?:checked|verified|confirmed)|has not been (?:checked|verified|confirmed)|unknown|unconfirmed|unverified)\b/i;
 for(const [index,h] of list(value.hypotheses).entries())if(Array.isArray(h?.evidence)&&h.evidence.some(e=>typeof e?.quote==='string'&&unverified.test(e.quote)&&typeof snapshot.fields?.[e.field]==='string'&&snapshot.fields[e.field].includes(e.quote))&&Array.isArray(h.uncertainties)&&!h.uncertainties.length)issues.push(`explicitUnknowns: hypothesis ${index+1} cites explicitly unverified or unknown facts but leaves uncertainties empty. Preserve those stated limitations as concise uncertainties in the case language. A valid branch or a complete scoped assessment does not confirm its fault cause. Do not change branch selection merely to fill this field.`);
 const reportedUnknown=Object.entries(snapshot.fields||{}).filter(([field,value])=>['description','observations','impact','affectedScope','occurredAt'].includes(field)&&typeof value==='string'&&unverified.test(value));
 if(list(value.hypotheses).length&&reportedUnknown.length&&!list(value.hypotheses).some(h=>Array.isArray(h?.uncertainties)&&h.uncertainties.length))issues.push('explicitUnknowns: The case explicitly reports unverified/unknown facts but ALL uncertainty lists are empty. Preserve the applicable reported limitations even when the model chose not to cite the unknown sentence. Do not infer verification from branch selection. Reported fields: '+reportedUnknown.map(([field,text])=>field+': '+text.slice(0,450)).join(' | '));
 return issues;
}

// Restore only verbatim, source-verified limitations; never infer a new unknown.
export function preserveCitedUnknowns(value,snapshot){
 const unverified=/(?:尚未|还未|未曾|没有|未)(?:核查|核实|检查|确认|查看|验证)|尚不清楚|尚未明确|不知道|\b(?:not yet (?:checked|verified|confirmed)|has not been (?:checked|verified|confirmed)|unknown|unconfirmed|unverified)\b/i;
 for(const h of Array.isArray(value?.hypotheses)?value.hypotheses:[]){
  if(!Array.isArray(h?.uncertainties)||h.uncertainties.length)continue;
  const quotes=(Array.isArray(h.evidence)?h.evidence:[]).filter(e=>typeof e?.quote==='string'&&typeof snapshot.fields?.[e.field]==='string'&&snapshot.fields[e.field].includes(e.quote));
  const limitations=quotes.flatMap(e=>e.quote.split(/(?<=[。！？.!?])\s*/u)).map(s=>s.trim()).filter(s=>s&&s.length<=1000&&unverified.test(s));
  h.uncertainties=[...new Set(limitations)].slice(0,5);
 }
 return value;
}
