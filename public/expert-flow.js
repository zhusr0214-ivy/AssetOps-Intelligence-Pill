import {discussionLanguageMatches} from './expert-language.js';
import {api,escapeHtml as e} from './incidents.js';

export function knowledgeGapMarkup(report,caseId) {
  if(!['knowledge_gap','out_of_scope'].includes(report.status))return '';
  const candidates=report.specialists?.filter(s=>s.status==='knowledge_gap')||[];
  const ids=[...new Set(candidates.length?candidates.map(s=>s.pillId||s.id):report.pill?.id&&report.pill.id!=='multi-pill-bundle'?[report.pill.id]:[])].filter(id=>typeof id==='string'&&id);
  return `<section class="triage-section expert-gap"><h3>Extend knowledge from this gap</h3><p>Keep the supported findings and involve a specialist for the uncovered part. An expert can explain the missing distinction and improve the relevant capability after review.</p>${ids.length?ids.map(id=>`<a href="/studio/${encodeURIComponent(id)}?view=draft&amp;exampleCase=${encodeURIComponent(caseId)}">Discuss this case with the relevant expert</a>`).join(' '):'<a href="/studio">Find related domain knowledge or start a new capability</a>'}</section>`;
}

export function expertDialogueMarkup(record,editable=true) {
  const dialogue=record.expertDialogue,reply=dialogue?.reply;
  const pending=(record.expertFeedback||[]).filter(f=>f.status==='pending_knowledge_review');
  const active=dialogue&&!dialogue.documentId;
  const source=(record.documents||[]).find(doc=>doc.id===dialogue?.documentId);
  const sourceStatus=source?.captureCompleteness==='partial'?'经验已保留，仍有待整理内容。可以保存提取草稿，再点击“继续整理已保存内容”补全。':source?.status==='failed'?'Experience saved. Extraction failed; use Retry extraction below. You do not need to enter your experience again.':source?.status==='reviewed'?'Experience saved and source review completed.':source?.status==='extracted'?'Experience saved as a source. Review the extracted proposals below.':'Experience saved. Knowledge extraction has not completed yet; check its status below.';
  const languageMismatch=reply&&!discussionLanguageMatches(dialogue,reply);
  return `<section class="triage-section expert-dialogue" data-page-panel="draft sources"><h3>Talk through your experience</h3><p>Tell us what you notice, how you distinguish possible causes and what you do next. We organize the conditions and actions; you do not need to classify them.</p>${pending.length?`<p class="triage-notice">${pending.length} example corrections are waiting here. Discuss or confirm them as a source, then review the proposed knowledge before release.</p>`:''}${dialogue?.messages.length?`<details class="expert-transcript"><summary>Experience &amp; discussion history (${dialogue.messages.length})</summary>${dialogue.messages.map(m=>`<article><strong>${e(m.contributor)}</strong>${m.deferredQuestion?`<p>Deferred: ${e(m.deferredQuestion)}</p>`:`<p class="source-text">${e(m.text)}</p>`}</article>`).join('')}</details>`:''}${active&&reply?`<article class="expert-understanding"><h4>Is this what you mean?</h4>${languageMismatch?'<p class="triage-notice">复述未保持中文。下方确认将只使用你的原始经验和纠正，不会采纳这段英文复述。</p>':''}<p class="source-text">${e(reply.understanding)}</p>${reply.question?`<p><strong>${e(reply.question)}</strong></p>${reply.reason?`<p class="muted-label">${e(reply.reason)}</p>`:''}`:'<p>You can confirm this now or add an example whenever useful.</p>'}</article>`:''}${active&&dialogue.error?`<p role="alert" class="form-error">${e(dialogue.error)}</p>`:''}${editable?`<form data-expert-message><label>${active?'Add a detail, answer or correction':'Share experience in your own words'}<textarea name="message" rows="4" maxlength="12000" placeholder="For example: When only one card fails, I first check…"></textarea></label><div class="actions"><button type="submit" class="primary">${active?'Continue discussion':'Help me organize this'}</button>${active&&reply?.question?'<button type="button" data-expert-defer>Leave this question for later</button>':''}${active&&['failed','thinking'].includes(dialogue.status)?'<button type="button" data-expert-retry>Retry saved message</button>':''}${active&&!reply&&dialogue.messages.length?'<button type="button" data-expert-continue>Organize the saved experience</button>':''}</div></form>${active?`<button type="button" data-expert-confirm>${reply&&!languageMismatch?'This matches — prepare knowledge for review':'Prepare my saved experience for review'}</button><p class="muted-label">You may leave a question unresolved. Your experience and the understanding you explicitly confirm become source material. Extracted knowledge still needs your review.</p>`:''}`:''}${dialogue?.documentId?`<p role="status">${e(sourceStatus)}</p>`:''}${pending.length?`<details><summary>反馈只涉及报告表达或遗漏展示？</summary><p>若专业规则本身无误，可把反馈改为报告问题，无需重新提取知识。原反馈会保留。</p>${pending.map(f=>`<button type="button" data-report-feedback="${e(f.trialId)}">将这条反馈归为报告问题</button>`).join('')}</details>`:''}${relatedMarkup(record)}</section>`;
}

function relatedMarkup(record) {
  const related=record.relatedPills||[];
  return `<details class="expert-related"><summary>Related knowledge in this domain (${related.length})</summary><p>These capabilities complement each other. Extend the relevant knowledge when a new branch appears; create a separate Pill when responsibility or operating scope differs.</p>${related.map(p=>`<article><a href="/studio/${encodeURIComponent(p.id)}?view=draft">${e(p.name)}</a> <span class="badge">${p.approved?'Has an approved version':'Draft knowledge'}</span><p>${e(p.scope||'Scope is being defined.')}</p></article>`).join('')||'<p>No related capability has been saved yet.</p>'}</details>`;
}

export function expertExamplesMarkup(record,editable=true) {
  const latest=record.expertTrials?.at(-1),report=latest?.report,attempt=record.expertAttempt;
  const statusLabels={complete:'已生成处理建议',needs_information:'需要补充关键信息',knowledge_gap:'现有知识不足',out_of_scope:'超出此 Pill 范围'};
  const unknowns=[...new Set(report?.hypotheses?.flatMap(h=>h.uncertainties||[])||[])];
  return `<section class="triage-section expert-examples" data-page-panel="evaluation"><h3>Try an example you know</h3><p>Describe a situation, see the analysis, then tell us what fits and what needs correcting. You do not need to cover every possible scenario.</p>${editable?'<form data-expert-example><label>Your example<textarea name="description" rows="4" maxlength="4000" required placeholder="Describe what happened and what was known at the time.">'+e(attempt?.description||(!latest?.feedback?'':latest.feedback.kind==='report'&&latest.feedback.decision==='corrected'?latest.facts.description:''))+'</textarea></label><button type="submit" class="primary">See how the Pill handles it</button></form>':''}${attempt?`<article data-expert-trial tabindex="-1"><h4>本次结论：暂不能可靠判断</h4><p>${e(attempt.summary)}</p><p>${e(attempt.reason)}</p><p>${e(attempt.nextStep)}</p></article>`:''}${latest&&!attempt?`<article data-expert-trial tabindex="-1" aria-label="Latest example result"><h4>本次分析</h4><span class="badge">${e(statusLabels[report.status]||report.status)}</span>${report.status==='complete'?'<p class="muted-label">表示可以在当前范围内给出建议，不代表现场问题已经解决。</p>':''}<section class="expert-result-actions"><h5>建议怎么处理</h5>${report.actions.length?`<ul>${report.actions.map(a=>`<li>${e(a.instruction)}${a.owner&&a.owner!=='待确认'?`<span class="muted-label">负责角色：${e(a.owner)}</span>`:''}</li>`).join('')}</ul>`:`<p>${e(report.summary)}</p>`}</section>${unknowns.length?`<section class="expert-result-unknowns"><h5>还不能确定</h5><ul>${unknowns.map(s=>`<li>${e(s)}</li>`).join('')}</ul></section>`:''}<details class="expert-result-evidence"><summary>查看判断依据与案例</summary><h5>测试案例</h5><p class="source-text">${e(latest.facts.description)}</p>${report.actions.length?`<h5>分析说明</h5><p class="source-text">${e(report.summary)}</p>`:''}${report.hypotheses?.map(h=>`<article><strong>${e(record.content?.pill?.rules?.find(r=>r.id===h.ruleId)?.title||'适用规则')}</strong><p>${e(h.reasoning)}</p>${h.evidence?.map(ref=>`<blockquote>${e(ref.quote)}</blockquote>`).join('')||''}</article>`).join('')||''}${report.followUpQuestions?.length?`<h5>建议补充的信息</h5><ul>${report.followUpQuestions.map(q=>`<li>${e(q.reason)}</li>`).join('')}</ul>`:''}</details>${editable&&!latest.feedback?`<form data-expert-feedback><label>你是否认可这个处理方式？<select name="decision"><option value="accepted">符合我的判断</option><option value="corrected">需要纠正或补充</option></select></label><details class="expert-feedback-expectation"><summary>查看或修改本次确认内容</summary><label>Expected handling — confirm or edit<textarea name="expectedHandling" rows="8" maxlength="4000" required>${e(latest.proposedHandling)}</textarea></label></details><div data-feedback-correction hidden><label class="studio-check"><input type="checkbox" name="reportOnly">已有专业规则正确，只修正模型的使用或报告展示</label><label>What should change, and why?<textarea name="feedback" rows="3" maxlength="4000"></textarea></label><details><summary>Expected assessment state (if different)</summary><select name="expectedStatus" aria-label="Expected assessment state">${[['complete','Can assess within scope'],['needs_information','Need essential information first'],['knowledge_gap','Knowledge needs extending'],['out_of_scope','Outside this scope']].map(([v,label])=>`<option value="${v}" ${v===report.status?'selected':''}>${label}</option>`).join('')}</select></details></div><button type="submit" class="primary">Save my feedback</button><p class="muted-label">确认后保存为后续对比案例；不会自动发布。</p></form>`:latest.feedback?`<p>Expert feedback: ${e(latest.feedback.decision)}. ${latest.feedback.decision==='corrected'&&latest.feedback.kind==='report'?'报告纠正已保存；可直接再次分析本案例，系统会参考你的意见，无需重新提取知识。':latest.feedback.decision==='corrected'?`<a href="/studio/${encodeURIComponent(record.id)}?view=draft">Continue the correction in Prepare knowledge</a>`:'This example is saved for future comparison.'}</p>`:''}</article>`:''}${record.expertTrials?.length>1?`<details><summary>Earlier examples &amp; feedback</summary>${record.expertTrials.slice(0,-1).map(t=>`<article><p>${e(t.facts.description)}</p><p>${e(t.feedback?.expectedHandling||'Not yet reviewed')}</p></article>`).join('')}</details>`:''}</section>`;
}

export function mountExpertFlow(view,record,perform,user) {
  const editable=record.state!=='published'&&user?.roles?.some(r=>['admin','expert'].includes(r));
  const capture=view.querySelector('.capture-panel');
  const anchor=capture?.closest('[data-page-panel]')||capture;
  anchor?.insertAdjacentHTML('beforebegin',expertDialogueMarkup(record,editable));
  if(capture&&record.expertDialogue?.messages?.length){
    const pending=(record.documents||[]).some(doc=>doc.status!=='reviewed');
    const optional=view.ownerDocument.createElement('details');optional.className='expert-optional-material';
    optional.innerHTML='<summary>Add a file or other source (optional)</summary>';
    if(!pending){
      capture.before(optional);optional.append(capture);
      const heading=capture.querySelector('h3');if(heading)heading.hidden=true;
      const hint=capture.querySelector(':scope > p');if(hint)hint.textContent='Your experience is already saved in the discussion above. Upload a file only if it adds useful information.';
    }else{
      // Keep extraction failures, retries and review candidates visible independently of uploads.
      const upload=capture.querySelector('#upload-source'),manual=capture.querySelector('.manual-source');
      if(upload)optional.append(upload);if(manual)optional.append(manual);
      if(upload||manual)capture.append(optional);
      const heading=capture.querySelector('h3');
      if(heading&&/Provide material/i.test(heading.textContent))heading.textContent='Knowledge extraction';
      const hint=capture.querySelector(':scope > p');
      if(hint&&/Upload a file or add experience/i.test(hint.textContent))hint.textContent='Your experience is saved. Check extraction status below, then review the prepared knowledge.';
    }
  }
  const confirm=view.querySelector('[data-expert-confirm]');
  if(confirm){
    const hint=confirm.nextElementSibling,understanding=view.querySelector('.expert-understanding');
    confirm.classList.add('primary');
    if(understanding)understanding.after(confirm,...(hint?[hint]:[]));
    const stage=view.ownerDocument.createElement('p');stage.dataset.expertStageStatus='';stage.setAttribute('role','status');
    stage.textContent='Experience saved · not extracted yet. Confirm below to generate knowledge for review.';
    confirm.before(stage);
  }
  const evaluation=view.querySelector('[data-page-panel="evaluation"]');
  evaluation?.insertAdjacentHTML('afterbegin',expertExamplesMarkup(record,editable));
  if(!editable)return;
  const send=(operation,payload,message,nextView)=>perform(async current=>(await api(`/api/studio/${encodeURIComponent(record.id)}/expert/${operation}`,{method:'POST',body:JSON.stringify({...payload,revision:(current||record).revision})})).record,message,nextView,operation==='example'?'[data-expert-trial]':undefined);
  const form=view.querySelector('[data-expert-message]');
  const sourceCase=new URL(view.ownerDocument.defaultView.location.href).searchParams.get('exampleCase');
  if(sourceCase&&form&&!record.expertDialogue?.messages?.length){
    api(`/api/incidents/${encodeURIComponent(sourceCase)}`).then(({incident})=>{
      const input=form.elements.message;if(!input.isConnected||input.value.trim()||!incident)return;
      const facts=incident.fields||incident;
      input.value=`Case example ${sourceCase}:\n${[facts.description,facts.observations].filter(Boolean).join('\n')}\n\n`;
      const note=view.ownerDocument.createElement('p');note.className='triage-notice';note.textContent='Case context is filled in. Add your judgement and the conditions that distinguish the causes before sending; nothing has been imported as knowledge.';form.prepend(note);
    }).catch(()=>{const note=view.ownerDocument.createElement('p');note.className='form-error';note.textContent='Could not load the case context. You can describe the missing knowledge here.';if(form.isConnected)form.prepend(note);});
  }
  form?.addEventListener('submit',event=>{event.preventDefault();const message=form.elements.message.value.trim();if(!message){form.elements.message.focus();return;}send('message',{message},'Organizing your experience…');});
  view.querySelector('[data-expert-defer]')?.addEventListener('click',()=>send('message',{kind:'defer'},'Keeping that question open…'));
  view.querySelector('[data-expert-retry]')?.addEventListener('click',()=>send('message',{kind:'retry'},'Retrying the saved experience…'));
  view.querySelector('[data-expert-continue]')?.addEventListener('click',()=>send('message',{kind:'continue'},'Organizing the saved experience…'));
  view.querySelector('[data-expert-confirm]')?.addEventListener('click',()=>send('confirm',{confirmed:true,confirmedUnderstanding:Boolean(record.expertDialogue?.reply)&&discussionLanguageMatches(record.expertDialogue,record.expertDialogue.reply)},'Extracting conditions and handling from your experience…'));
  const example=view.querySelector('[data-expert-example]');
  example?.addEventListener('submit',event=>{event.preventDefault();send('example',{description:example.elements.description.value},'Analyzing your example…');});
  view.querySelectorAll('[data-report-feedback]').forEach(button=>button.addEventListener('click',()=>send('feedback',{trialId:button.dataset.reportFeedback,reclassify:true,feedbackKind:'report'},'Saving report correction…')));
  const feedback=view.querySelector('[data-expert-feedback]');
  const syncCorrection=()=>{const panel=feedback?.querySelector('[data-feedback-correction]');if(panel)panel.hidden=feedback.elements.decision.value!=='corrected';};
  feedback?.elements.decision.addEventListener('change',syncCorrection);
  feedback?.elements.expectedHandling.addEventListener('input',()=>{feedback.elements.decision.value='corrected';syncCorrection();});
  feedback?.elements.reportOnly.addEventListener('change',()=>{if(feedback.elements.reportOnly.checked)feedback.elements.decision.value='corrected';syncCorrection();});
  feedback?.elements.expectedStatus.addEventListener('change',()=>{feedback.elements.decision.value='corrected';syncCorrection();});
  feedback?.addEventListener('submit',event=>{event.preventDefault();const correction=feedback.elements.feedback;correction.setCustomValidity(feedback.elements.decision.value==='corrected'&&!correction.value.trim()?'Explain what was wrong or missing.':'');if(!feedback.reportValidity())return;send('feedback',{trialId:record.expertTrials.at(-1).id,feedbackKind:feedback.elements.reportOnly.checked?'report':'knowledge',decision:feedback.elements.decision.value,expectedHandling:feedback.elements.expectedHandling.value,feedback:correction.value,expectedStatus:feedback.elements.expectedStatus.value},feedback.elements.reportOnly.checked?'已保存纠正，正在按你的意见重新分析…':'Saving the example and your feedback…',feedback.elements.decision.value==='corrected'&&!feedback.elements.reportOnly.checked?'draft':undefined);});
  // Technical suite editing remains available without making it the expert's job.
  const suite=view.querySelector('[data-test-suite]');if(suite){suite.open=false;const title=suite.querySelector(':scope > summary');if(title)title.textContent='Saved examples & advanced expectations';}
}


export function compactExpertValidation(view,record,perform) {
  const panel=view.querySelector('.evaluation-panel'),examples=view.querySelector('.expert-examples');
  if(!panel||!examples)return;
  const run=record.evaluations?.at(-1),gate=record.evaluationGate;
  const summary=panel.querySelector('[data-evaluation-result]');
  if(summary){
    examples.append(summary);
    if(run?.method==='expert_confirmed_examples'){
      const current=!['outdated','not_run','not_enabled'].includes(gate?.state);
      summary.querySelector('h3').textContent=!current?'Knowledge changed — confirm the examples again':run.passed?'Examples confirmed by expert':'Validation needs attention';
      summary.querySelector('p').textContent=!current?'Try the saved examples against the changed knowledge and review the new reports.':run.passed?'The reports you reviewed are the validation evidence. Continue to final review; no second model run is required.':'Review the requirements below before continuing.';
      const pending=(run.results||[]).filter(r=>r.candidate?.failureCode==='expert_confirmation_required');
      if(pending.length){const counts=summary.querySelectorAll(':scope > p')[1];if(counts)counts.textContent=`${pending.length} 个已保存案例待使用当前版本重跑并确认；这不表示模型输出无效。`;}
      if(run.blockers?.length){const list=view.ownerDocument.createElement('ul');for(const text of run.blockers){const item=view.ownerDocument.createElement('li');item.textContent=text;list.append(item);}summary.append(list);}
    }
  }
  // Expert confirmation is the single visible validation workflow.
  // Keep its gate and next-step controls; remove duplicate automatic-trial tools.
  for(const button of view.querySelectorAll('[data-operation="submit"],[data-confirmation-step]'))examples.append(button);
  summary?.querySelector('[data-inspect-trials]')?.remove();
  panel.remove();
  if(!run&&record.expertTrials?.some(t=>t.feedback?.decision==='accepted')){
    const button=view.ownerDocument.createElement('button');button.type='button';button.className='primary';button.dataset.useExpertValidation='';button.textContent='Continue to confirmation';
    button.onclick=()=>perform(async current=>(await api(`/api/studio/${encodeURIComponent(record.id)}/expert/validate`,{method:'POST',body:JSON.stringify({revision:(current||record).revision,submit:true})})).record,'Recording the saved expert confirmations…','publication');
    examples.append(button);
    view.querySelectorAll('[data-operation="submit"],[data-confirmation-step]').forEach(b=>b.hidden=true);
  }
  for(const hint of [...examples.parentElement.children])if(hint.tagName==='P'&&hint.textContent.startsWith('Before submitting:'))hint.hidden=true;
}
