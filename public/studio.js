import {currentUser} from './session.js';
import {api, escapeHtml as e} from './incidents.js';
import {renderCaptureEntry} from './knowledge.js';
import {renderPillPreview} from './pill-preview.js';
import {renderImprovements} from './improvements.js';

export async function renderStudio(root,path,navigate) {
  const view=root.ownerDocument.createElement('section');root.replaceChildren(view);
  view.innerHTML='<p role="status">Loading Pill Studio...</p>';
  try{
    if(path.startsWith('/studio/improvements/')){await renderImprovements(view,path);return;}
    if(['/studio/new','/studio/new/upload','/studio/new/expert'].includes(path)){await renderCaptureEntry(view,'unified',navigate);return;}
    if(['/studio','/studio/improvements','/studio/analytics'].includes(path)){
      const {records,improvements=[]}=await api('/api/studio');if(!view.isConnected)return;
      const states={pending_analysis:'Pending analysis',in_review:'Pending review',no_changes:'No changes proposed',publishing:'Publication pending recovery'};
      const drafts=records.filter(r=>r.state!=='published').map(r=>{
        const p=r.content.pill,source=r.learningImports?.some(v=>v.caseId)?'Case':'Studio';
        return {name:p.name,owner:p.owner,source,status:'Draft',href:`/studio/${encodeURIComponent(r.id)}`,detail:'',text:[p.name,p.scope,...(p.actions||[]).map(a=>a.instruction),...(p.rules||[]).map(rule=>rule.guidance),...(r.learningImports||[]).map(v=>v.caseId)].join(' ')};
      });
      drafts.push(...improvements.filter(b=>!['published','closed'].includes(b.status)).map(b=>({name:b.title||b.caseId,owner:b.owner,source:'Case',status:states[b.status]||b.status,href:`/studio/improvements/${encodeURIComponent(b.caseId)}/${encodeURIComponent(b.id)}`,detail:b.targets.map(t=>t.name).join(', '),text:[b.title,b.caseId,b.experience,b.summary,...b.targets.map(t=>t.name)].join(' ')})));
      const owners=[...new Set(drafts.map(r=>r.owner).filter(Boolean))].sort();
      view.innerHTML=`<header class="workspace-heading"><h2>Pill Studio</h2></header>
        <div class="studio-filters operations-filters">
          <label>Search<input type="search" data-filter-search placeholder="Pill, Case or content"></label>
          <label>Owner<select data-filter-owner><option value="">All owners</option>${owners.map(owner=>`<option value="${e(owner)}">${e(owner)}</option>`).join('')}</select></label>
          <label>Source<select data-filter-source><option value="">All sources</option><option value="Case">Case</option><option value="Studio">Studio</option></select></label>
        </div><p data-filter-count role="status"></p>
        <div class="table-scroll"><table class="incident-table studio-table"><thead><tr><th>Name</th><th>Owner</th><th>Source</th><th>Status</th></tr></thead><tbody></tbody></table></div>`;
      const search=view.querySelector('[data-filter-search]'),owner=view.querySelector('[data-filter-owner]'),source=view.querySelector('[data-filter-source]');
      const filter=()=>{
        const query=search.value.trim().toLowerCase();
        const matches=drafts.filter(r=>{
          return (!query||r.text.toLowerCase().includes(query))&&(!owner.value||r.owner===owner.value)&&(!source.value||r.source===source.value);
        });
        view.querySelector('tbody').innerHTML=matches.map(r=>`<tr><td><a href="${e(r.href)}">${e(r.name)}</a>${r.detail?`<small>${e(r.detail)}</small>`:''}</td><td>${e(r.owner||'Not specified')}</td><td>${e(r.source)}</td><td>${e(r.status)}</td></tr>`).join('')||'<tr><td colspan="4">No matching items.</td></tr>';
        view.querySelector('[data-filter-count]').textContent=`${matches.length} of ${drafts.length} items`;
      };
      search.addEventListener('input',filter);owner.addEventListener('change',filter);source.addEventListener('change',filter);filter();return;
    }
    const match=path.match(/^\/studio\/([^/]+)$/);if(!match)throw new Error('Pill page not found.');
    const base=`/api/studio/${encodeURIComponent(match[1])}`;let {record}=await api(base);
    const imp=record.learningImports?.find(v=>v.caseId);
    if(imp){try{const inc=await api(`/api/incidents/${encodeURIComponent(imp.caseId)}`);const sol=inc.incident?.expertSolutions?.find(s=>s.pillDraftId===record.id);if(sol){if(sol.improvementBatchId){await renderImprovements(view,`/studio/improvements/${encodeURIComponent(imp.caseId)}/${encodeURIComponent(sol.improvementBatchId)}`);return;}if(!sol.pillDraftId){/* no draft, skip */}else{const user=currentUser();if(user?.roles?.some(r=>['admin','expert'].includes(r))){try{const {incident}=await api(`/api/cases/${encodeURIComponent(imp.caseId)}/expert-experience-confirmation`,{method:'POST',body:JSON.stringify({solutionId:sol.id,revision:inc.incident.revision||0,confirmed:true})});const updated=incident.expertSolutions?.find(s=>s.id===sol.id);if(updated?.improvementBatchId){await renderImprovements(view,`/studio/improvements/${encodeURIComponent(imp.caseId)}/${encodeURIComponent(updated.improvementBatchId)}`);return;}}catch(err){console.warn('Auto-migration to improvement batch failed:',err.message);}}}}}catch(err){console.warn('Improvement redirect failed:',err.message);}}
    const user=currentUser(),published=record.state==='published'||record.releases?.length,canEdit=user?.roles?.includes('admin')||(!published&&user?.roles?.includes('expert'));
    if(record.state!=='published'&&canEdit&&(record.documents||[]).some(d=>d.status==='extracted'&&!d.draftApplied&&d.status!=='reviewed')){
      record=(await api(`${base}/prepare-draft`,{method:'POST',body:JSON.stringify({revision:record.revision})})).record;
    }
    const edit=new URL(view.ownerDocument.defaultView.location.href).searchParams.get('edit')==='1'&&canEdit;
    if(edit&&record.state==='published')record=(await api(`${base}/fork`,{method:'POST',body:JSON.stringify({revision:record.revision})})).record;
    if(!view.isConnected)return;
    renderPillPreview(view,record,navigate,{editing:edit});
  }catch(error){if(view.isConnected)view.innerHTML=`<p class="form-error" role="alert">${e(error.message)}</p>`;}
}
