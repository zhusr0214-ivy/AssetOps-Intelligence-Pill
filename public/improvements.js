import {api,escapeHtml as e} from './incidents.js';
import {currentUser} from './session.js';

const labels={scope:'Scope',actions:'Action',rules:'Decision rule',boundaries:'Operating limit'};
const states={pending_analysis:'Pending analysis',in_review:'Pending review',no_changes:'No changes proposed',publishing:'Publication pending recovery',published:'Published',closed:'Closed'};
export async function renderImprovements(view,path){
  const match=path.match(/^\/studio\/improvements\/([^/]+)\/([^/]+)$/);
  if(!match)throw new Error('Improvement proposal not found.');
  const base=`/api/improvements/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
  let {batch}=await api(base),busy=false;
  const roles=currentUser()?.roles||[],canEdit=roles.some(r=>['admin','expert'].includes(r)),admin=roles.includes('admin');
  const request=async(operation,body={})=>{batch=(await api(`${base}/${operation}`,{method:'POST',body:JSON.stringify({...body,revision:batch.revision})})).batch;};
  const save=()=>request('save',{changes:[...view.querySelectorAll('[data-change]')].map(el=>({id:el.dataset.change,decision:el.querySelector('select').value,after:el.querySelector('textarea').value}))});
  const run=async(operation)=>{
    if(busy)return;
    if(operation==='analyze'&&batch.targets.length&&!view.ownerDocument.defaultView.confirm('Re-analyze current Pill versions? Existing proposal edits will be replaced; the previous proposal stays in history.'))return;
    busy=true;view.querySelector('[data-error]').textContent='';view.querySelector('[data-status]').textContent=operation==='analyze'?'Analyzing expert experience...':'Saving...';
    view.querySelectorAll('button,input,textarea,select').forEach(b=>b.disabled=true);
    try{
      if(['save','publish','close'].includes(operation)&&batch.status==='in_review')await save();
      if(operation!=='save')await request(operation);
      paint();view.querySelector('[data-status]').textContent=operation==='save'?'Proposal saved.':'';
    }catch(error){view.querySelector('[data-error]').textContent=error.message;view.querySelector('[data-status]').textContent='';view.querySelector('[data-reload]').hidden=false;}
    finally{busy=false;view.querySelectorAll('[data-operation]').forEach(b=>b.disabled=b.dataset.operation==='publish'?!admin:!canEdit);view.querySelectorAll('input,textarea,select').forEach(el=>el.disabled=!canEdit||batch.status!=='in_review');view.querySelector('[data-reload]').disabled=false;}
  };
  function paint(){
    if(!view.isConnected)return;
    const editable=canEdit&&batch.status==='in_review';
    view.innerHTML=`<header class="workspace-heading"><h2>Pill Studio</h2><a class="back-link" href="/studio">&larr; Pill Studio</a></header>
      <article class="improvement-review"><header class="pill-header"><h3>Experience improvement</h3><span class="badge">${e(states[batch.status])}</span></header>
      <a href="/cases/${e(batch.caseId)}">Source Case</a><p class="source-text">${e(batch.experience.solution)}</p><small>${e(batch.experience.expert)}</small>
      ${batch.summary?`<p>${e(batch.summary)}</p>`:''}
      ${batch.targets.map(t=>`<section class="improvement-target"><h3>${e(t.name)} <small>${t.isNew?'New Pill':`v${e(t.baseVersion)}`}</small></h3>
        ${t.dependsOn.length?`<p>Requires: ${e(t.dependsOn.map(k=>batch.targets.find(v=>v.key===k)?.name||k).join(', '))}</p>`:''}
        ${t.changes.map(c=>`<article class="improvement-change" data-change="${e(c.id)}"><div class="pill-field-heading"><h4>${labels[c.field]}</h4><select aria-label="Decision for ${e(t.name)} ${labels[c.field]}" ${editable?'':'disabled'}>${['pending','accepted','excluded'].map(d=>`<option value="${d}" ${c.decision===d?'selected':''}>${{pending:'Pending',accepted:'Accept',excluded:'Exclude'}[d]}</option>`).join('')}</select></div>
        <div class="improvement-diff"><section><h5>Before</h5><p class="source-text">${e(c.before||'Not present')}</p></section><label>After<textarea rows="4" maxlength="${c.field==='scope'?4000:2000}" ${editable?'':'readonly'}>${e(c.after)}</textarea></label></div>
        <p>${e(c.reason)}</p><details><summary>Expert evidence</summary><blockquote>${e(c.quote)}</blockquote></details></article>`).join('')}</section>`).join('')}
      ${(batch.releases||[]).map(r=>`<a href="/library/${e(r.id)}">${e(batch.targets.find(t=>t.pillId===r.id)?.name||r.id)} / v${e(r.version)}</a>`).join('')}
      <p data-status role="status"></p><p data-error role="alert"></p><button data-reload hidden>Reload proposal</button><div class="actions">
        ${['pending_analysis','in_review','no_changes'].includes(batch.status)?`<button data-operation="analyze">${batch.status==='pending_analysis'?'Analyze experience':'Re-analyze'}</button>`:''}
        ${batch.status==='in_review'?'<button data-operation="save">Save proposal</button><button data-operation="close">Close without publishing</button><button class="primary" data-operation="publish">Publish selected changes</button>':''}
        ${batch.status==='no_changes'?'<button data-operation="close">Close proposal</button>':''}
        ${batch.status==='publishing'?'<button class="primary" data-operation="publish">Retry publication</button>':''}
      </div></article>`;
    view.querySelectorAll('[data-operation]').forEach(b=>{b.disabled=b.dataset.operation==='publish'?!admin:!canEdit;b.onclick=()=>run(b.dataset.operation);});
    view.querySelector('[data-reload]').onclick=async()=>{if(busy)return;try{batch=(await api(base)).batch;paint();}catch(error){view.querySelector('[data-error]').textContent=error.message;}};
  }
  paint();
}
