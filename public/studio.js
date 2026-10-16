import {currentUser} from './session.js';
import {api, escapeHtml as e} from './incidents.js';
import {renderCaptureEntry} from './knowledge.js';
import {renderPillPreview} from './pill-preview.js';

export async function renderStudio(root,path,navigate) {
  const view=root.ownerDocument.createElement('section');root.replaceChildren(view);
  view.innerHTML='<p role="status">Loading Pill Studio...</p>';
  try{
    if(['/studio/new','/studio/new/upload','/studio/new/expert'].includes(path)){await renderCaptureEntry(view,'unified',navigate);return;}
    if(['/studio','/studio/improvements','/studio/analytics'].includes(path)){
      const {records}=await api('/api/studio');if(!view.isConnected)return;
      view.innerHTML=`<header class="workspace-heading"><h2>Pill Studio</h2></header><div class="table-scroll"><table class="incident-table"><thead><tr><th>Pill</th><th>Owner</th><th>Status</th></tr></thead><tbody>${records.filter(r=>r.state!=='published').map(r=>`<tr><td><a href="/studio/${e(r.id)}">${e(r.content.pill.name)}</a></td><td>${e(r.content.pill.owner)}</td><td>Draft</td></tr>`).join('')}</tbody></table></div>`;return;
    }
    const match=path.match(/^\/studio\/([^/]+)$/);if(!match)throw new Error('Pill page not found.');
    const base=`/api/studio/${encodeURIComponent(match[1])}`;let {record}=await api(base);
    const user=currentUser(),canEdit=user?.roles?.some(r=>['admin','expert'].includes(r));
    if(record.state!=='published'&&canEdit&&(record.documents||[]).some(d=>d.status==='extracted'&&!d.draftApplied&&d.status!=='reviewed')){
      record=(await api(`${base}/prepare-draft`,{method:'POST',body:JSON.stringify({revision:record.revision})})).record;
    }
    const edit=new URL(view.ownerDocument.defaultView.location.href).searchParams.get('edit')==='1'&&canEdit;
    if(edit&&record.state==='published')record=(await api(`${base}/fork`,{method:'POST',body:JSON.stringify({revision:record.revision})})).record;
    if(!view.isConnected)return;
    renderPillPreview(view,record,navigate,{editing:edit});
  }catch(error){if(view.isConnected)view.innerHTML=`<p class="form-error" role="alert">${e(error.message)}</p>`;}
}
