import {escapeHtml as e} from './incidents.js';

export function simplifyPublication(view,record,user) {
 const readiness=view.querySelector('.publication-readiness');if(!readiness)return;
 const own=record.contributorIds?.includes(user?.id),roles=user?.roles||[];
 const independent=record.independentReviewRequired===true;
 const reviewer=(roles.includes('admin')||roles.includes('reviewer')||roles.includes('expert'))&&(!independent||!own);
 const submitted=record.state==='in_review',published=record.state==='published';
 const run=record.evaluations?.at(-1),stats=run?.statistics;
 const heading=published?'Published':submitted?reviewer?independent?'Ready for independent review':'Confirm & publish':'Waiting for independent review':'Not submitted for review';
 const explanation=published?'This knowledge version is available for matching cases.':submitted?reviewer?'Check the knowledge, test results and operating limits. Approve publication if the recommendations and limits are appropriate, or return the draft with the changes needed.':own?'You contributed to this draft. A different authorized reviewer must review and approve it. You do not need to fill in an approval form.':'An authorized reviewer must review this draft and decide whether to publish it.':'Complete validation and submit the draft from Validate recommendations.';
 readiness.innerHTML=`<h3>${e(heading)}</h3><p>${e(explanation)}</p><p>Recommendation tests: ${run?`${e(stats?.passed??run.results.filter(r=>r.candidate.passed).length)} / ${e(stats?.samples??run.results.length)} passed`:'not run'}. ${submitted?'Draft submitted; not yet published.':''}</p><div class="publication-review-links"><a class="button" href="/studio/${e(record.id)}?view=draft">Review knowledge & sources</a><a class="button" href="/studio/${e(record.id)}?view=evaluation">Review test results</a></div>`;
 const form=view.querySelector('#pill-approval');
 if(form){
  if(!reviewer){form.remove();}
  else {
   form.querySelector('h3').textContent='Your decision';
   const rename=(name,label)=>{const el=form.querySelector(`[name="${name}"]`);if(el)el.closest('label').firstChild.textContent=label;return el;};
   const scope=rename('scope','Scope covered by this review');if(scope)scope.readOnly=true;
   const limits=rename('limitations','Operating limits');if(limits)limits.readOnly=true;
   rename('qualification','Your professional role / relevant expertise');
   const reference=form.querySelector('[name="reference"]');if(reference)reference.closest('label').hidden=true;
   rename('notes','Review comments / changes required');
   const notes=form.querySelector('[name="notes"]');if(notes)notes.placeholder='State why the knowledge is suitable for use, or what must be changed.';
   const checkbox=form.querySelector('[name="expertConfirmed"]');if(checkbox)checkbox.closest('label').lastChild.textContent='I checked the sources and test results, and confirm the recommendations are suitable within the stated scope and limits.';
   const publish=form.querySelector('[value="publish"]');if(publish)publish.textContent=independent?'Approve & publish':'Confirm & publish';
   const back=form.querySelector('[value="return"]');if(back)back.textContent='Return for revision';
   const legend=form.querySelector('[data-combined-review] legend');if(legend)legend.textContent='Knowledge to approve';
   const helper=form.ownerDocument.createElement('p');helper.textContent='Test evidence is attached automatically. Publishing makes this knowledge available for case assessment; it does not authorize equipment operation.';form.querySelector('h3').after(helper);
   for(const p of form.querySelectorAll('p'))if(p.textContent.startsWith('Publishing activates'))p.hidden=true;
  }
 }
 for(const panel of view.querySelectorAll('[data-page-panel="publication"]')){
  if(panel===readiness||panel===form)continue;
  if(panel.querySelector('h3')?.textContent==='Structural validation passed')panel.remove();
 }
 const next=view.querySelector('.studio-next-step');if(next&&new URL(view.ownerDocument.defaultView.location.href).searchParams.get('view')==='publication')next.hidden=true;
 const status=view.querySelector('#studio-status');if(status&&submitted)status.textContent='';
 const history=[...view.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Versions and audit history');if(history){history.querySelector('summary').textContent='Published versions & review history';readiness.parentElement.append(history);}
}
