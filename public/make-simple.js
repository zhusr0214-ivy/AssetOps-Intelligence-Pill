import { pillMarkup } from './library.js';
import {escapeHtml as e} from './incidents.js';
export function simplifyMake(view,record) {
 const form=view.querySelector('#pill-editor');if(!form)return;
 const details=document.createElement('details');details.className='make-advanced';details.dataset.pagePanel='draft';
 details.innerHTML='<summary>Edit knowledge · content and relationships</summary><p>Edit the saved knowledge below. Changes save automatically; rule and action relationships remain available for specialist review.</p>';
 form.replaceWith(details);details.append(form);
 const card=document.createElement('section');card.className='make-review-summary';card.dataset.pagePanel='draft';
 const p=record.content.pill;const pendingSource=record.documents?.some(d=>d.status!=='reviewed');
 card.innerHTML=`<h3>Confirmed knowledge</h3><p>${p.rules?.length ? 'Review the saved knowledge below. Expand Edit knowledge to make changes, then continue to Test.' : 'Review source candidates, check their evidence and confirm what to retain.'}</p><div class="make-metadata"><span><strong>Domain</strong> ${e((p.domain||'Not selected').replaceAll('_',' '))}</span><span><strong>Owner</strong> ${e(p.owner)}</span><span><strong>Sources</strong> ${(record.documents||[]).length}</span></div><div class="make-knowledge-counts">${[['Rules',p.rules?.length||0],['Actions',p.actions?.length||0],['Boundaries',p.boundaries?.length||0]].map(([name,count])=>`<span><strong>${count}</strong> ${name}</span>`).join('')}</div>${p.rules?.length?'<p class="triage-notice">Knowledge is in the draft. Continue to validation; any missing requirements will be listed there.</p><a class="button primary" href="/studio/'+encodeURIComponent(record.id)+'?view=evaluation">Try an example</a>':'<p>No reviewed rules yet. Select knowledge from a source and confirm the source review first.</p>'}`;
 if(p.rules?.length){card.querySelector('.make-metadata')?.remove();card.querySelector('.make-knowledge-counts')?.remove();}
 if(!p.rules?.length)card.querySelector('h3').textContent='Knowledge overview';
 if(pendingSource && p.rules?.length){card.querySelector('a')?.remove();card.querySelector('.triage-notice')?.remove();card.querySelector('p').textContent='Review the pending source proposals first. Confirmed knowledge is retained below for comparison.';}
 details.before(card);
 if(p.rules?.length){const preview=document.createElement('section');preview.className='make-knowledge-preview';preview.dataset.pagePanel='draft';preview.innerHTML=pillMarkup({...p,status:'draft',version:'draft'}, {captureHistory:record.captureHistory||[]});preview.querySelector('.pill-footer')?.remove();preview.querySelector('.pill-header')?.remove();if(pendingSource){const comparison=document.createElement('details');comparison.dataset.pagePanel='draft';comparison.innerHTML='<summary>Previously confirmed knowledge</summary>';comparison.append(preview);card.after(comparison);}else card.after(preview);}
 const sources=view.querySelector('.capture-panel');if(sources){sources.querySelector('h3').textContent='1 · Provide material';const hint=sources.querySelector(':scope > p');if(hint)hint.textContent='Upload a file or add experience. AI prepares knowledge for your review; it does not publish it.';}
 if(sources && record.documents?.some(d=>d.status==='reviewed') && !record.documents.some(d=>['extracted','ready','failed','analyzing'].includes(d.status))) {
   sources.querySelector('h3').textContent='Materials & provenance';
   const hint=sources.querySelector(':scope > p');if(hint)hint.textContent='Knowledge has been confirmed. Add material only when it contains new information; source omissions should be corrected from the original evidence.';
   const supplement=document.createElement('details');supplement.className='capture-supplement';supplement.innerHTML='<summary>Add supplementary material</summary>';
   const upload=sources.querySelector('#upload-source'),manual=sources.querySelector('.manual-source');if(upload)supplement.append(upload);if(manual){manual.open=false;manual.querySelector('summary').textContent='Add new expert information';supplement.append(manual);}sources.append(supplement);
   const provenance=document.createElement('details');provenance.className='capture-provenance';provenance.innerHTML='<summary>Source records & review history</summary>';sources.querySelectorAll('.capture-document').forEach(doc=>{doc.open=false;provenance.append(doc);});sources.append(provenance);
   // Keep supplemental input available but let the confirmed knowledge lead the page.
   details.after(sources.closest('[data-page-panel]'));
 }
 prioritizeReview(view);
 view.querySelectorAll('[data-capture-review]').forEach(review=>{
  const names={scope:'Scope',rule:'Decision rules',action:'Suggested actions',boundary:'Limits & unknowns',escalation:'Escalation',example:'Examples',evidence:'Evidence'};
  const doc=record.documents?.find(d=>d.id===review.dataset.captureReview);const sections=new Map();
  review.querySelectorAll('.capture-candidate').forEach((candidate,index)=>{
   const type=doc?.candidates[index]?.type||'evidence';let section=sections.get(type);
   if(!section){section=document.createElement('section');section.className='make-candidate-group';section.innerHTML=`<h5>${({scope:'Where this applies',rule:'How to judge',action:'What to do and who handles it',boundary:'What must not be done',escalation:'When to involve someone else',example:'Examples',evidence:'Supporting material'})[type]||type}</h5>`;candidate.before(section);sections.set(type,section);}section.append(candidate);
  });
 });
}

export function prioritizeReview(view) {
 const panel=view.querySelector('.capture-panel');if(!panel)return;
 const reviews=[...panel.querySelectorAll('[data-capture-review]')];if(!reviews.length)return;
 const count=reviews.reduce((n,f)=>n+f.querySelectorAll('.capture-candidate').length,0);
 panel.querySelector('h3').textContent='Review extracted knowledge';
 const hint=panel.querySelector(':scope > p');if(hint)hint.textContent=`${count} knowledge candidates extracted. Read the proposed text, edit if needed, and select what to keep. Source evidence is available on each card.`;
 const main=document.createElement('div');main.className='capture-review-priority';
 const extras=document.createElement('details');extras.className='capture-reference-extras';extras.innerHTML='<summary>Original files, full source text & additional material</summary>';
 const retries=[...panel.querySelectorAll('[data-reextract]')];
 retries.forEach(button=>{button.title='Generate new candidates from the original source; previous extraction is retained.';panel.append(button);});
 const keep=new Set([panel.querySelector('h3'),hint,panel.querySelector('.knowledge-gaps'),...retries]);
 reviews.forEach(review=>{
   const questions=review.querySelector(':scope > ul');if(questions)questions.remove();
   const footer=document.createElement('div');footer.className='capture-review-footer';
   const context=document.createElement('div');context.className='capture-review-context';
   [...review.children].filter(n=>n.matches('label,p,button')&&!n.classList.contains('capture-selection-status')).forEach(n=>{
     if(n.matches('button') || n.querySelector('input[name="confirmed"]')) footer.append(n);
     else context.append(n);
   });
   review.querySelector('h4')?.after(context);
   const counter=review.querySelector('.capture-selection-status');if(counter)footer.prepend(counter);
   const bulk=review.querySelector('.capture-bulk-selection');if(bulk)footer.prepend(bulk);
   review.append(footer);main.append(review);
   review.querySelectorAll('.capture-candidate > ul').forEach(list=>{const notice=document.createElement('details');notice.className='candidate-link-notice';notice.innerHTML=`<summary>Review notes (${list.children.length})</summary>`;list.replaceWith(notice);notice.append(list);});
 });
 [...panel.children].filter(n=>!keep.has(n)).forEach(n=>extras.append(n));
 panel.append(main,extras);
}
