import { escapeHtml as e } from './incidents.js';

export function studioStep(record) {
  if (record.state === 'published') return 3;
  if (record.state === 'in_review') return 3;
  const p = record.content.pill;
  if (!p.applicability?.categories?.length) return 1;
  if (!p.rules?.length && record.documents?.some(d => ['ready','failed','analyzing','extracted'].includes(d.status))) return 0;
  if (!p.rules?.length || !p.actions?.length || !record.validation?.passed) return 1;
  if (record.evaluationRequired && !record.evaluationGate?.passed) return 2;
  return 1;
}

export function bindStudioFlow(view, record, {subpages = false} = {}) {
  const current = studioStep(record);
  const titles = ['1 · Source & knowledge review', '2 · Draft & structural validation', '3 · Model evaluation', '4 · Approval & published versions'];
  const instructions = [
    record.documents?.some(d=>d.status==='extracted') ? 'Extraction is complete. Review the candidate evidence, select the items to keep, then click Save decisions and merge selected.' : 'Click Analyze on the source below. After extraction, review and select the knowledge to merge into the draft.',
    !record.content.pill.applicability?.categories?.length ? 'First choose the domain and incident categories, then save. Next, analyze your source.' : record.validation?.passed ? 'The draft structure is valid. Configure model evaluation, or submit the validated draft for expert review when ready.' : 'Complete the draft rules, linked actions, sources and examples. Save, then validate the structure.',
    record.evaluationGate?.state === 'expert_review_required' ? 'Trials passed. A separate reviewer must review the results and record a decision.' : 'Save 2–8 cases including a supported case and a negative case, then run evaluation. Review failures before proceeding.',
    record.state === 'published' ? 'This version is published. Return to your Case and run a new analysis to use it.' : 'A separate reviewer must review this version and approve publication or return it for changes.'
  ];
  if (subpages) {
    const keys=['sources','draft','evaluation','publication'];
    const next=document.createElement('aside');next.className='studio-next-step';
    next.innerHTML=`<div><span class="studio-eyebrow">NEXT STEP · ${current+1} / 4</span><h3>${e(titles[current].replace(/^\d · /,''))}</h3><p>${e(instructions[current])}</p></div><a class="button primary" href="/studio/${encodeURIComponent(record.id)}?view=${keys[current]}">Go to current step</a>`;
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
    body.innerHTML='<summary>View proposed knowledge & source evidence</summary>';
    [...card.children].filter(n=>n!==heading && !n.matches('.badge, ul')).forEach(n=>body.append(n)); card.append(body);
  });
  view.querySelectorAll('[data-capture-review]').forEach(form=>{
    const count=document.createElement('p');count.className='capture-selection-status';count.setAttribute('role','status');form.querySelector('h4')?.after(count);
    const update=()=>count.textContent=`${form.querySelectorAll('input[name^="accept-"]:checked').length} selected / ${form.querySelectorAll('input[name^="accept-"]').length} candidates. Review evidence before merging.`;
    form.addEventListener('change',update);update();
  });
  view.querySelectorAll('[data-operation="validate"], [data-operation="submit"]').forEach(b=>b.classList.add('primary'));
}
