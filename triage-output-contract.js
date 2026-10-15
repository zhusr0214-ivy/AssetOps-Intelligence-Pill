import {reportQualityIssues} from './report-quality.js';
import { priorities } from './intake.js';
// Output checks shared by the single corrective request and final server validation.
// These checks never manufacture a rule match or remove a reported information gap.
export function triageContractIssues(value, snapshot, pill) {
 const issues=[], rules=pill.rules||[],actions=pill.actions||[],hypotheses=Array.isArray(value?.hypotheses)?value.hypotheses:[];
 const text=(v,max=2000)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
 if(!text(value?.summary))issues.push('reportShape: summary must be nonempty text of at most 2000 characters.');
 if(!Array.isArray(value?.hypotheses)||value.hypotheses.length>3*(pill.members?.length||1))issues.push('reportShape: hypotheses must be an array within the allowed hypothesis count.');
 if(!Array.isArray(value?.actionIds)||value.actionIds.length>5*(pill.members?.length||1))issues.push('reportShape: actionIds must be an array within the allowed action count.');
 for(const [index,h] of hypotheses.entries()){
  if(!text(h?.reasoning))issues.push(`reportShape: hypothesis ${index+1} needs nonempty reasoning of at most 2000 characters.`);
  if(!Array.isArray(h?.uncertainties)||h.uncertainties.length>5||h.uncertainties.some(v=>!text(v,1000)))issues.push(`reportShape: hypothesis ${index+1} uncertainties must be an array of at most 5 nonempty strings, each at most 1000 characters; use [] when there are no uncertainties.`);
 }
 if(!Array.isArray(value?.missingFields)||value.missingFields.length>5)issues.push('reportShape: missingFields must be an array of at most 5 entries; use [] when no prerequisite blocks assessment.');
 for(const [index,h] of hypotheses.entries()) {
  if(!rules.some(r=>r.id===h?.ruleId))issues.push(`ruleReference: hypothesis ${index+1} ruleId ${String(h?.ruleId).slice(0,100)} is absent from the supplied catalog. Copy the full exact rule ID, never shorten or invent it.`);
  if(!Array.isArray(h?.evidence)||h.evidence.length<1||h.evidence.length>6)issues.push(`reportShape: hypothesis ${index+1} evidence must contain 1 to 6 items.`);
 }
 issues.push(...plumbingConditionIssues(value,snapshot,pill));
 issues.push(...accessScopeConditionIssues(value,snapshot,pill));
 issues.push(...cleaningConditionIssues(value,snapshot,pill));
 issues.push(...reportQualityIssues(value,snapshot));
 const suggestion=value?.prioritySuggestion;
 if(suggestion!==null && (!suggestion || !priorities.includes(suggestion.value) || typeof suggestion.reason!=='string' || !suggestion.reason.trim() || suggestion.reason.length>1000))issues.push('prioritySuggestion must be null or {value, reason}, where value is low, medium, high or urgent and reason is nonempty text of at most 1000 characters. For a hypothetical assessment without a grounded priority recommendation, return null.');
 const cited=new Set(hypotheses.map(h=>h?.ruleId));
 for(const id of Array.isArray(value?.actionIds)?value.actionIds:[]) {
   const action=actions.find(a=>a.id===id);
   if(!action)issues.push(`Action ID ${String(id).slice(0,100)} is absent from the supplied catalog. Use an exact catalog ID only when its rule is supported by case evidence.`);
   else if(!(action.ruleIds||[]).some(ruleId=>cited.has(ruleId)))issues.push(`Action ${action.id} has no cited linked rule. Its allowed rule IDs are ${(action.ruleIds||[]).join(', ')}. Cite a supported linked rule with exact case evidence, or omit the action; never add a rule solely to satisfy the association.`);
 }
 if(snapshot.validationScenario===true && value?.blockingReasons!==undefined && (!Array.isArray(value.blockingReasons) || value.blockingReasons.length>5 || value.blockingReasons.some(r=>!r || typeof r!=='object' || !['asset','occurredAt'].includes(r.field))))issues.push('missingFields blockingReasons must be an array of at most 5 structured asset/time justifications.');
 if(snapshot.validationScenario===true) for(const field of Array.isArray(value?.missingFields)?value.missingFields:[]) {
   if(!['asset','occurredAt'].includes(field))continue;
   const justification=Array.isArray(value.blockingReasons)?value.blockingReasons.find(r=>r?.field===field):null;
   const rule=rules.find(r=>r.id===justification?.ruleId);
   const source=[rule?.guidance,rule?.cardExplanation].filter(Boolean).join('\n');
   const vocabulary=field==='asset'?/asset|equipment (?:id|identifier)|设备(?:编号|标识)|资产(?:编号|标识)/i:/occurredAt|onset|start time|timestamp|occurrence time|发生时间|开始时间|时间戳/i;
   if(!rule || typeof justification?.quote!=='string' || !justification.quote.trim() || !source.includes(justification.quote) || !vocabulary.test(justification.quote) || typeof justification.reason!=='string' || !justification.reason.trim() || justification.reason.length>1000)issues.push(`missingFields ${field}: for this hypothetical scenario, justify the blocking requirement with blockingReasons [{field, ruleId, quote, reason}]. Quote the exact supplied rule guidance that makes this field a prerequisite for the assessment. A collection task alone is not a prerequisite. If no such rule exists, keep the detail unknown in uncertainties and assess the supported collection/referral scope. Preserve genuine safety blockers.`);
 }
 return issues;
}

// Explicitly separate follow-up collection from a prerequisite for today's recommendation.
export function classifyInformationNeeds(value,pill) {
 if(value?.informationNeeds===undefined)return value;
 const fields=['asset','observations','affectedScope','occurredAt','impact'];
 const fail=(detail='Invalid information need.')=>{throw Object.assign(new Error('Information needs: '+detail),{status:502,validationCode:'blocking_requirement'});};
 if(!Array.isArray(value.informationNeeds)||value.informationNeeds.length>5)fail('Return an array of at most 5 informationNeeds.');
 for(const field of value.missingFields||[]){if(!fields.includes(field))fail('missingFields must contain only supported prerequisite fields.');if(!value.informationNeeds.some(n=>n?.field===field))fail('Classify every field in missingFields as blocking or follow_up; do not silently omit it from informationNeeds.');}
 const blockers=[],followUps=[];
 for(const need of value.informationNeeds){
  if(!need||typeof need!=='object')fail('Each information need must be an object.');
  if(!['blocking','follow_up'].includes(need.kind))fail('kind must be exactly blocking or follow_up.');
  if(typeof need.reason!=='string'||!need.reason.trim()||need.reason.length>1000)fail('Each entry requires a nonempty reason of at most 1000 characters.');
  if(need.kind==='blocking'){
   if(!fields.includes(need.field))fail('A blocking field must be asset, observations, affectedScope, occurredAt or impact.');
   const rule=pill.rules?.find(r=>r.id===need.ruleId),source=[rule?.guidance,rule?.cardExplanation].filter(Boolean).join('\n');
   if(!rule||typeof need.quote!=='string'||!need.quote.trim()||!source.includes(need.quote))fail('A blocking entry must cite an exact supplied ruleId and quote from its guidance; an action checklist is not a prerequisite. Use follow_up only when the detail is collected during the recommended response.');
   blockers.push(need.field);
  }else {
   const detail=need.detail??(fields.includes(need.field)?null:need.field);
   if(detail!==null&&detail!==undefined&&(typeof detail!=='string'||!detail.trim()||detail.length>120))fail('A follow-up detail must be text of at most 120 characters.');
   followUps.push({field:fields.includes(need.field)?need.field:null,...(detail?{detail}:{}),reason:need.reason});
  }
 }
 if(new Set(blockers).size!==blockers.length)fail('Do not repeat a blocking field; classify it once.');
 return {...value,missingFields:blockers,followUpQuestions:followUps};
}

export function plumbingConditionIssues(value,snapshot,pill){
 if(pill.domain!=='water_leak')return [];
 const facts=[snapshot.fields?.description,snapshot.fields?.observations].filter(Boolean).join('。').split(/[。！？；;，,\n]/u).filter(s=>!/(?:是否|未确认|未报告|未知|不清楚|没有|未发现|未见)/u.test(s)).join('。');
 const single=/(?:单个水槽|一个水槽|单点异常)/u.test(facts)&&/(?:其他|另一个|附近|邻近)[^。]{0,25}(?:正常|无异常)/u.test(facts);
 const multi=/(?:多个排水点|[两二三四五六七八九]个水槽|多点)[^。]{0,40}(?:缓慢|慢|返水|受影响|异常)/u.test(facts);
 const disuse=/(?:长期|长时间|[一二三四五六七八九十0-9]+(?:天|周|个月))[^。]{0,12}(?:未使用|停用|闲置)/u.test(facts);
 const selected=[...(Array.isArray(value.hypotheses)?value.hypotheses:[]).map(h=>pill.rules?.find(r=>r.id===h?.ruleId)),...(Array.isArray(value.actionIds)?value.actionIds:[]).map(id=>pill.actions?.find(a=>a.id===id))].filter(Boolean);
 const issues=[];
 for(const item of selected){const title=item.title||'',text=item.guidance||item.instruction||'';
 if((/单点异常|单个水槽/u.test(title)||/^(?:当)?单个水槽/u.test(text))&&!single)issues.push(`Applicability: ${item.id} requires a confirmed single affected sink and normal nearby drainage; unknown scope does not satisfy this condition. Omit it and collect the missing scope under an applicable general rule.`);
 if((/多点异常|多点排水/u.test(title)||/^当同一区域多个排水点/u.test(text))&&!multi)issues.push(`Applicability: ${item.id} requires reported multiple affected drainage points; unknown scope does not satisfy this condition.`);
 if(/长期未使用|长期停用/u.test(title)&&!disuse)issues.push(`Applicability: ${item.id} requires reported long disuse. Ask about disuse rather than assuming its condition is met.`);
 }
 return issues;
}

// These explicit card-count prerequisites are not satisfied by a sentence
// merely mentioning both alternatives. Unknowns and questions are not facts.
export function accessScopeConditionIssues(value,snapshot,pill){
 const narrative=[snapshot.fields?.description,snapshot.fields?.observations,snapshot.fields?.affectedScope].filter(Boolean).join('。');
 const facts=narrative.split(/[。！？;；\n]|(?<=[.!?])\s+/u).filter(s=>!/(?:是否|尚不清楚|未确认|未知|不清楚|尚不明确|\bunknown\b|\bunclear\b|\bwhether\b|not (?:yet )?known|not sure)/iu.test(s)).join('。');
 const single=/(?:(?:只有|仅(?:有)?)(?:一|1)张卡|(?:一|1)名员工)[^。]{0,55}(?:失败|拒绝|打不开|未打开)|only (?:one|a single) card[^。]{0,40}(?:fail|denied)/iu.test(facts)&&/(?:其他|其余)[^。]{0,35}(?:正常|可以正常)|other (?:cards|people|employees)[^。]{0,40}(?:work|normal|succeed)/iu.test(facts);
 const multi=/(?:多个人|多人|多张卡|[两二三四五六七八九0-9]+名员工)[^。]{0,65}(?:失败|拒绝访问|打不开|未打开)|(?:multiple|several|two|three) (?:people|employees|cards)[^。]{0,60}(?:fail|denied)/iu.test(facts);
 const issues=[];
 for(const h of Array.isArray(value?.hypotheses)?value.hypotheses:[]){
  const rule=pill.rules?.find(r=>r.id===h?.ruleId);if(!rule)continue;
  const guidance=rule.guidance||rule.cardExplanation||'';
  const requiresSingle=/^(?:当)?(?:只有|仅(?:有)?)(?:一|1)张卡[^。]{0,45}(?:失败|拒绝)|^(?:when|if) only (?:one|a single) card[^.]{0,40}(?:fails|is denied)/iu.test(guidance);
  const requiresMulti=/^当(?:多个人|多人|多张卡)[^。]{0,35}(?:失败|拒绝)|^(?:when|if) (?:multiple|several) (?:people|cards)[^.]{0,50}fail/iu.test(guidance);
  const requiresUnknown=/尚不清楚[^。]{0,45}(?:单卡|多卡|多人)|(?:unknown|unconfirmed) (?:single|card|scope)/iu.test(guidance);
  if(requiresUnknown&&(single||multi))issues.push(`Applicability: ${rule.id} is for unconfirmed card-failure scope, but this case already confirms the ${single?'single':'multiple'}-card branch. Unverified card authorization, expiry or fault cause does not make the reported scope unknown. Do not demand exhaustive attempts by every card; use the confirmed branch and preserve unknown causes separately.`);
  if(requiresSingle&&!single)issues.push(`Applicability: ${rule.id} requires confirmed single-card failure and other cards working normally at that door. Unknown scope does not satisfy it. Do not cite this rule just to discuss an unconfirmed alternative; describe the unresolved branch in the summary instead.`);
  if(requiresMulti&&!multi)issues.push(`Applicability: ${rule.id} requires reported multiple cards or people failing at the same door. Unknown scope does not satisfy it. Omit unsupported hypotheses and retain the unanswered scope question; do not invent a generic rule or action.`);
 }
 return issues;
}

// Enforce only an explicit, source-defined branch; this does not infer cleaning quality.
export function cleaningConditionIssues(value,snapshot,pill){
 const narrative=[snapshot.fields?.description,snapshot.fields?.observations].filter(Boolean).join('。');
 const affirmative=narrative.split(/[。！？;；\n]/u).filter(s=>!/(?:是否|不清楚|不确定|尚未确认|并非|不是|\bwhether\b|not sure)/iu.test(s)).join('。');
 const notStarted=/(?:本轮|该时段|此次|这次)?清洁(?:工作)?(?:尚未|还未|未)(?:开始|进行)|(?:尚未|还未|未)(?:开始|进行)清洁/iu.test(affirmative);
 if(!notStarted)return [];
 const rule=(pill.rules||[]).find(r=>/^(?:如果|若|当)?尚未清洁/.test(r.guidance||'')&&/核对清洁计划/.test(r.guidance||''));
 if(!rule)return [];
 const hypotheses=Array.isArray(value.hypotheses)?value.hypotheses:[],actionIds=Array.isArray(value.actionIds)?value.actionIds:[];
 const unsupportedSubject=/在岗|值班|(?:部分|局部)[^。]{0,8}清洁|清洁[^。]{0,8}(?:部分|局部)/i;
 const selectedText=hypotheses.map(h=>pill.rules.find(r=>r.id===h.ruleId)?.guidance||'').join(' ');
 const extraQuestions=[...(Array.isArray(value.informationNeeds)?value.informationNeeds.filter(n=>n?.kind==='follow_up'):[]),...(Array.isArray(value.followUpQuestions)?value.followUpQuestions:[])];
 const questionIssues=extraQuestions.some(q=>unsupportedSubject.test(q?.reason||''))&&!unsupportedSubject.test(narrative)&&!unsupportedSubject.test(selectedText)?['followUpScope: The reported cleaning state is already explicit. The supplied rules do not require investigating staff attendance or partial cleaning. Remove these speculative follow-up questions; do not reopen a confirmed state merely to exclude every imagined alternative. Keep genuine safety questions and rule-supported plan checks.']:[];
 if(hypotheses.some(h=>h.ruleId===rule.id)&&(rule.actionIds||[]).some(id=>actionIds.includes(id)))return questionIssues;
 return [`Applicability: The case explicitly reports cleaning has not started. Supplied rule ${rule.id} says to check the cleaning plan under that condition. Apply this rule and its supported plan-check action. Knowing the plan details is the OUTPUT of checking, not a prerequisite to recommend checking. Preserve uncertainty about blame. General intake cannot replace this already supported specific branch.`];
}
