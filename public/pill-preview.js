import {api, escapeHtml as e} from './incidents.js';
import {currentUser} from './session.js';

export function pillContentMarkup(p, {hideEmptyOptional=false, anchors=false, showEscalation=true}={}) {
  const anchor = value => anchors && value ? ` id="${e(encodeURIComponent(`${p.id}${p.status==='approved'?`-${p.version}`:''}-${value}`))}"` : '';
  const rows = (label, key, field, optional=false) => {
    const values=(p[key]||[]).map(item=>({id:item?.id,text:field ? item[field] || (key==='rules'?item.cardExplanation:'') || item.title : item})).filter(item=>item.text);
    if(optional && hideEmptyOptional && !values.length)return '';
    return `<section class="triage-section" data-collection="${key}"><h3>${label}</h3>${values.map(item=>`<p class="source-text"${anchor(item.id)}>${e(item.text)}</p>`).join('') || '<p>Not specified</p>'}</section>`;
  };
  return `<article class="pill-content-preview"><section class="triage-section"><h3>Scope</h3><p class="source-text">${e(p.scope || 'Not specified')}</p></section>${rows('Actions','actions','instruction')}${rows('Decision rules','rules','guidance')}${rows('Operating limits','boundaries',null,true)}${showEscalation ? rows('Escalation','escalationConditions',null,true) : ''}</article>`;
}

export function previewMarkup(record, editing=false) {
  const p=record.content.pill;
  const text=(label,key)=>editing?`<label>${label}<textarea name="${key}" rows="3" maxlength="4000">${e(p[key]||'')}</textarea></label>`:`<section class="triage-section"><h3>${label}</h3><p class="source-text">${e(p[key]||'Not specified')}</p></section>`;
  const collection=(label,key,field)=>`<section class="triage-section" data-collection="${key}"><h3>${label}</h3>${(p[key]||[]).map((item,i)=>editing?`<div data-item="${i}" class="pill-draft-item"><textarea rows="3" maxlength="2000" aria-label="${label} ${i+1}">${e(field?item[field]:item)}</textarea><button type="button" data-remove="${key}" data-index="${i}" aria-label="Remove ${label.toLowerCase()} ${i+1}" title="Remove">&times;</button></div>`:`<p class="source-text">${e(field?item[field]:item)}</p>`).join('')||(!editing?'<p>Not specified</p>':'')}${editing?`<button type="button" data-add="${key}" aria-label="Add ${label.toLowerCase()}" title="Add ${label.toLowerCase()}">+</button>`:''}</section>`;
  return `<header class="workspace-heading"><h2>${e(p.name)}</h2><span class="badge">${e(record.state==='published'?'Published':'Draft')}</span></header>
  ${editing ? `<article class="pill-content-preview">
    ${editing?`<label>Pill name<input name="name" maxlength="200" value="${e(p.name)}"></label>`:''}
    ${text('Scope','scope')}
    ${collection('Actions','actions','instruction')}
    ${collection('Decision rules','rules','guidance')}
    ${collection('Operating limits','boundaries')}
    ${collection('Escalation','escalationConditions')}
  </article>` : pillContentMarkup(p)}<p data-preview-status role="status"></p><p data-preview-error class="form-error source-text" role="alert" hidden></p>
  <div class="actions">${record.state==='published'?'<button type="button" data-edit-preview>Edit</button>':`<button type="button" data-edit-preview>${editing?'Cancel':'Edit'}</button><button type="button" data-delete-preview>Delete</button><button type="button" data-save-preview>Save</button><button type="button" class="primary" data-publish-preview>Publish</button>`}</div>`;
}

export function renderPillPreview(view,initialRecord,navigate,{editing=false}={}) {
  let record=initialRecord,working=structuredClone(record),busy=false;
  const user=currentUser(),canEdit=user?.roles?.includes('admin')||(!(record.state==='published'||record.releases?.length)&&user?.roles?.includes('expert')),isAdmin=user?.roles?.includes('admin');
  const base=`/api/studio/${encodeURIComponent(record.id)}`;
  const request=async(operation,body={})=>(await api(`${base}/${operation}`,{method:'POST',body:JSON.stringify({...body,revision:record.revision})})).record;
  const capture=()=>{
    if(!editing)return;
    const pill=working.content.pill;
    for(const key of ['name','scope']){const input=view.querySelector(`[name="${key}"]`);if(input)pill[key]=input.value.trim();}
    for(const [key,field] of [['actions','instruction'],['rules','guidance'],['boundaries',null],['escalationConditions',null]]){
      view.querySelectorAll(`[data-collection="${key}"] [data-item]`).forEach(row=>{
        const index=Number(row.dataset.item),value=row.querySelector('textarea').value.trim();
        if(field){pill[key][index][field]=value;if(key==='rules')pill[key][index].cardExplanation=value;}
        else pill[key][index]=value;
      });
    }
  };
  const paint=()=>{
    view.innerHTML=previewMarkup(working,editing&&canEdit);
    view.querySelectorAll('button').forEach(b=>b.disabled=!canEdit||busy);
    if(!canEdit&&(record.state==='published'||record.releases?.length))view.querySelector('[data-edit-preview]').hidden=true;
    const publish=view.querySelector('[data-publish-preview]');if(publish){publish.disabled=!isAdmin||busy;publish.title=isAdmin?'Publish':'Only administrators can publish';}
    view.querySelector('[data-edit-preview]').onclick=async()=>{
      if(!canEdit||busy)return;
      if(record.state==='published'){await operate('fork');return;}
      editing=!editing;working=structuredClone(record);paint();
    };
    const save=view.querySelector('[data-save-preview]');if(save)save.onclick=()=>operate('save');
    if(publish)publish.onclick=()=>operate('publish');
    const del=view.querySelector('[data-delete-preview]');if(del)del.onclick=()=>{
      if(view.ownerDocument.defaultView.confirm(record.releases?.length?'Discard this draft? Published versions will be kept.':'Delete this draft? This cannot be undone.'))operate('delete');
    };
    view.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{
      capture();const key=b.dataset.add,id=`manual-${crypto.randomUUID().slice(0,12)}`;
      working.content.pill[key].push(key==='actions'?{id,title:'Action',instruction:'',owner:'',requiresApproval:true,ruleIds:[]}:key==='rules'?{id,title:'Rule',guidance:'',cardExplanation:'',actionIds:[]}: '');paint();
    });
    view.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{
      capture();const key=b.dataset.remove,removed=working.content.pill[key].splice(Number(b.dataset.index),1)[0];
      if(key==='rules')working.content.pill.actions.forEach(a=>a.ruleIds=a.ruleIds.filter(id=>id!==removed.id));
      if(key==='actions')working.content.pill.rules.forEach(r=>r.actionIds=r.actionIds.filter(id=>id!==removed.id));
      paint();
    });
  };
  async function operate(operation){
    if(busy||!canEdit||operation==='publish'&&!isAdmin)return;
    capture();busy=true;
    view.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);
    view.querySelector('[data-preview-error]').hidden=true;
    view.querySelector('[data-preview-status]').textContent=operation==='delete'?'Deleting...':'Saving...';
    try {
      if(operation==='delete'){
        await api(`${base}/delete`,{method:'POST',body:JSON.stringify({revision:record.revision})});
        navigate('/studio');return;
      }
      if(operation==='fork'){
        record=await request('fork');working=structuredClone(record);editing=true;
      }else{
        const content=structuredClone(working.content);
        if(!content.pill.name.trim())throw new Error('Enter the Pill name.');
        if(operation==='publish'&&!content.pill.scope.trim())throw new Error('Scope is required before publishing.');
        if(operation==='publish'&&(!content.pill.actions.length||content.pill.actions.some(a=>!a.instruction.trim())))throw new Error('At least one valid action is required. Fill in or remove empty actions.');
        record=await request('save',{content});
        if(operation==='publish'){
          record=await request('publish');
          navigate(`/library/${encodeURIComponent(record.id)}`);return;
        }
        working=structuredClone(record);editing=false;
      }
      busy=false;paint();view.querySelector('[data-preview-status]').textContent=operation==='fork'?'Editing a new draft. The published version is unchanged.':'Draft saved.';
    }catch(error){
      busy=false;paint();
      view.querySelector('[data-preview-status]').textContent=operation==='publish'?'Not published.':'';
      const el=view.querySelector('[data-preview-error]');el.hidden=false;el.textContent=error.message;
    }finally{busy=false;}
  }
  paint();
}
