const categoryDomains = {hvac_cooling:'ahu_cooling',hvac_local_comfort:'hvac_local_comfort',energy:'energy',electrical_distribution:'electrical_distribution',water_leak:'water_leak',lift_fault:'lift_fault',other:'asset_operations'};

export function normalizeRouting(value) {
  const categories = [...new Set(Array.isArray(value?.categories)?value.categories:[])].filter(v => Object.hasOwn(categoryDomains,v));
  return categories.length ? {categories,assetPrefixes:[],keywords:[]} : null;
}

// Legacy sources lack model routing metadata; use their explicit subject, never AHU by default.
export function draftRouting(pill) {
  const text = [pill.name,pill.scope,...(pill.actions || []).map(a=>a.instruction)].join(' ');
  const categories = [
    ['electrical_distribution',/lighting|lights?\b|electrical|breaker|照明|灯|配电/i],
    ['hvac_cooling',/air conditioning|\bahu\b|\bhvac\b|cooling|空调|制冷/i],
    ['water_leak',/water leak|plumbing|dripp|drain|漏水|管道|排水/i],
    ['lift_fault',/elevator|\blift\b|电梯/i],
    ['energy',/energy consumption|energy efficiency|能耗|节能/i]
  ].filter(([,pattern])=>pattern.test(text)).map(([category])=>category);
  return {categories:categories.length?categories:['other'],assetPrefixes:[],keywords:[]};
}

export function ensureDraftRouting(pill) {
  if(pill.domain==='ahu_cooling'&&!pill.applicability)return;
  if(!pill.applicability&&Object.values(categoryDomains).includes(pill.domain)){
    pill.applicability={categories:[Object.keys(categoryDomains).find(key=>categoryDomains[key]===pill.domain)],assetPrefixes:[],keywords:[]};return;
  }
  if (!normalizeRouting(pill.applicability)) pill.applicability=draftRouting(pill);
  pill.domain=categoryDomains[pill.applicability.categories[0]] || 'asset_operations';
}

export function applyExtractedDraft(record) {
  const content=record.content,pill=content.pill;
  for(const doc of record.documents || []) {
    if(doc.status!=='extracted'||doc.draftApplied||doc.status==='reviewed')continue;
    const candidates=doc.candidates || [];
    const ids=new Map(candidates.map(c=>[c.id,`CAP-${c.id.replace(/^K-/, '')}`]));
    const refs=(values,kind)=>[...new Set((values || []).filter(id=>candidates.some(c=>c.id===id&&c.type===kind)).map(id=>ids.get(id)))];
    for(const c of candidates) {
      if(c.type==='scope'&&!pill.scope.includes(c.text))pill.scope=[pill.scope,c.text].filter(Boolean).join('\n');
      if(c.type==='rule')pill.rules.push({id:ids.get(c.id),title:c.title,guidance:c.text,cardExplanation:c.text,actionIds:refs(c.relatedActionIds,'action')});
      if(c.type==='action')pill.actions.push({id:ids.get(c.id),title:c.title,instruction:c.text,owner:c.owner||'',requiresApproval:true,ruleIds:refs(c.relatedRuleIds,'rule')});
      if(c.type==='boundary'&&!pill.boundaries.includes(c.text))pill.boundaries.push(c.text);
      if(c.type==='escalation'&&!pill.escalationConditions.includes(c.text))pill.escalationConditions.push(c.text);
      if(c.type==='example')content.examples.push({scenario:c.text,rationale:'',ruleIds:refs(c.relatedRuleIds,'rule'),actionIds:refs(c.relatedActionIds,'action')});
    }
    for(const rule of pill.rules)for(const id of rule.actionIds){const action=pill.actions.find(a=>a.id===id);if(action&&!action.ruleIds.includes(rule.id))action.ruleIds.push(rule.id);}
    for(const action of pill.actions)for(const id of action.ruleIds){const rule=pill.rules.find(r=>r.id===id);if(rule&&!rule.actionIds.includes(action.id))rule.actionIds.push(action.id);}
    content.sources.push({expert:record.content.pill.owner||'',reference:`${doc.name} / ${doc.id}`,knowledge:candidates.map(c=>c.text).join('\n')});
    if(!pill.source)pill.source=doc.name;
    const routing=normalizeRouting(doc.routing);
    if(routing){pill.applicability={...routing,categories:[...new Set([...(record.routingFromExtraction?pill.applicability?.categories||[]:[]),...routing.categories])]};record.routingFromExtraction=true;}
    doc.draftApplied=true;
  }
  ensureDraftRouting(pill);
}

export function ensureActionLinks(pill) {
  pill.rules=pill.rules.filter(r=>r.guidance?.trim());
  for(const rule of pill.rules)rule.actionIds=rule.actionIds.filter(id=>pill.actions.some(a=>a.id===id));
  for(const action of pill.actions){
    action.ruleIds=action.ruleIds.filter(id=>pill.rules.some(r=>r.id===id));
    const linked=pill.rules.filter(r=>r.actionIds.includes(action.id)).map(r=>r.id);
    action.ruleIds=[...new Set([...action.ruleIds,...linked])];
  }
  const unlinked=pill.actions.filter(a=>!a.ruleIds.length);
  if(unlinked.length){
    let id='scope-rule';while(pill.rules.some(r=>r.id===id))id+='-1';
    pill.rules.push({id,title:'Applicable scope',guidance:pill.scope,cardExplanation:pill.scope,actionIds:unlinked.map(a=>a.id)});
    unlinked.forEach(a=>a.ruleIds=[id]);
  }
  for(const action of pill.actions)for(const id of action.ruleIds){const rule=pill.rules.find(r=>r.id===id);if(!rule.actionIds.includes(action.id))rule.actionIds.push(action.id);}
}
