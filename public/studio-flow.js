import { escapeHtml as e } from './incidents.js';

export function studioStep(record) {
  if (record.state === 'published') return 3;
  if (record.state === 'in_review') return 3;
  if(record.documents?.some(d=>['extracted','analyzing','failed','ready'].includes(d.status)))return 0;
  const p = record.content.pill;
  if (!p.applicability?.categories?.length) return 1;
  if (!p.rules?.length && record.documents?.some(d => ['ready','failed','analyzing','extracted'].includes(d.status))) return 0;
  if (!p.rules?.length || !p.actions?.length) return 1;
  if (!record.validation?.passed || !record.evaluationRequired) return 2;
  if (record.evaluationRequired && !record.evaluationGate?.passed) return 2;
  return 2;
}

export function bindStudioFlow(view, record, {subpages = false} = {}) {
  const current = studioStep(record);
  const titles = ['1 · Source & knowledge review', '2 · Draft & structural validation', '3 · Model evaluation', '4 · Approval & published versions'];
  const instructions = [
    record.documents?.some(d=>d.status==='extracted') ? 'Extraction is complete. Review the candidate evidence, select the items to keep, then click Save & continue to Test.' : 'Click Analyze on the source below. After extraction, review and select the knowledge to merge into the draft.',
    !record.content.pill.applicability?.categories?.length ? 'First choose the domain and incident categories, then save. Next, analyze your source.' : record.validation?.passed ? 'The draft structure is valid. Configure model evaluation, or submit the validated draft for expert review when ready.' : 'Review the extracted knowledge and complete rules, actions and boundaries. Changes save automatically; test cases in step 2 also supply validation examples.',
    record.evaluations?.at(-1)?.passed === false ? 'The latest evaluation failed. Open Test to review the expected and actual results for each trial. Publication is blocked.' : record.evaluationGate?.state === 'expert_review_required' ? (record.independentReviewRequired?'Trials passed. Continue to independent review.':'Trials passed. Continue to expert confirmation and publication.') : 'Give an example you know, review the analysis, and confirm or correct its handling. Your feedback supplies the saved regression examples. Run their comparison when ready, then continue to expert review. You do not need to cover every scenario.',
    record.state === 'published' ? 'This version is published. Return to your Case and run a new analysis to use it.' : (record.independentReviewRequired?'A different expert must review this version before publication.':'Confirm the knowledge, test results and operating limits before publication.')
  ];
  if (subpages) {
    const keys=['draft','draft','evaluation','publication'];
    const phase=current<2?0:current===2?1:2;
    const next=document.createElement('aside');next.className='studio-next-step';
    const headings=['Prepare knowledge','Prepare knowledge','Validate recommendations','Review & release'];
    next.innerHTML=`<div><span class="studio-eyebrow">${record.state === 'published' ? 'PUBLISHED' : `CURRENT TASK · ${phase+1} / 3`}</span><h3>${e(headings[current])}</h3><p>${e(instructions[current])}</p></div>`;
    const header=view.querySelector('.workspace-heading');header?.after(next);
    // Keep teammate's URL-addressable panels mounted; compact only long candidate evidence.
    compactCandidates(view);
    return;
  }
  const groups = titles.map((title, i) => {
    const group = document.createElement('details'); group.className = 'studio-stage'; group.dataset.stage = String(i); group.open = current === i;
    group.innerHTML = `<summary><span>${e(title)}</span><small>${current === i ? 'Current step' : 'Open section'}</small></summary><div class="studio-stage-body"></div>`;
    return group;
  });
  const place = (node, index) => { if (node) groups[index].querySelector('.studio-stage-body').append(node); };
  place(view.querySelector('.capture-panel'),0);
  place(view.querySelector('#pill-editor'),1);
  // Put the current validation result beside the editor rather than above every section.
  const validation = [...view.children].find(n => n.matches?.('section.triage-section') && /Structural validation|Validation needs attention/.test(n.querySelector('h3')?.textContent || ''));
  if (validation) groups[1].querySelector('.studio-stage-body').prepend(validation);
  const evaluation = view.querySelector('.evaluation-panel');
  if (evaluation) {
    const policy = [...view.children].find(n => n.matches?.('section.triage-section') && n.querySelector('#evaluation-options, #evaluation-review'));
    place(policy,2); place(evaluation,2);
  }
  place(view.querySelector('#pill-approval'),3);
  if(record.state==='published') { place(view.querySelector('.pill-record'),3); place(view.querySelector('[data-operation="fork"]'),3); }
  for(const node of [...view.children]) if(node.tagName==='P' && node.textContent.startsWith('Model-only trials:')) place(node,2);
  for (const details of [...view.children].filter(n=>n.tagName==='DETAILS')) place(details,3);
  const navigator = document.createElement('section'); navigator.className='studio-next-step';
  navigator.innerHTML = `<div><span class="studio-eyebrow">NEXT STEP · ${current+1} / 4</span><h3>${e(titles[current].replace(/^\d · /,''))}</h3><p>${e(instructions[current])}</p></div><button type="button" class="primary" data-open-current>Go to current step</button><nav aria-label="Pill workflow">${titles.map((t,i)=>`<button type="button" data-step="${i}" ${i===current?'aria-current="step"':''}>${e(t)}</button>`).join('')}</nav>`;
  const header = view.querySelector('.workspace-heading'); header?.after(navigator);
  groups.forEach(g=>view.append(g));
  const open = index => { groups.forEach((g,i)=>g.open=i===index); groups[index].scrollIntoView?.({block:'start'}); };
  navigator.querySelector('[data-open-current]').onclick=()=>open(current);
  navigator.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>open(Number(b.dataset.step)));
  compactCandidates(view);
}

function compactCandidates(view) {
  // Keep selection visible; details hold the long evidence instead of filling the page.
  view.querySelectorAll('.capture-candidate').forEach(card=>{
    const heading=card.querySelector('label.studio-check'); if(!heading)return;
    const body=document.createElement('details'); body.className='candidate-evidence';
    body.innerHTML='<summary>View source evidence & references</summary>';
    [...card.children].filter(n=>n!==heading && !n.matches('.candidate-heading, .badge, ul, label')).forEach(n=>body.append(n)); card.append(body);
  });
  view.querySelectorAll('[data-capture-review]').forEach(form=>{
    const count=document.createElement('p');count.className='capture-selection-status';count.setAttribute('role','status');form.querySelector('h4')?.after(count);
    const update=()=>count.textContent=`${form.querySelectorAll('input[name^="accept-"]:checked').length} / ${form.querySelectorAll('input[name^="accept-"]').length} selected.`;
    form.addEventListener('change',update);update();
  });
  view.querySelectorAll('[data-operation="validate"], [data-operation="submit"]').forEach(b=>b.classList.add('primary'));
}
