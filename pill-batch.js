import {createHash} from 'node:crypto';
import {releaseHash} from './pill-versions.js';
import {ensureDraftRouting,ensureActionLinks} from './pill-draft.js';
import {fail} from './improvement-plan.js';

export function createBatchPublisher({mutate,contentFrom,validateDraft,running,evaluating,persistence}) {
  return (batch,items,body)=>mutate(records=>{
    if(!body.authenticatedRoles?.includes('admin')||!body.authenticatedActor?.id)throw fail('Only administrators can publish improvement batches.',403);
    const planHash=createHash('sha256').update(JSON.stringify({id:batch.id,items,validation:batch.validation,...(batch.review?{review:batch.review}:{})})).digest('hex');
    const prior=records.flatMap(r=>r.releases.filter(v=>v.improvement?.batchId===batch.id));
    if(prior.length){
      if(prior.length!==items.length||prior.some(v=>v.improvement.planHash!==planHash))throw fail('Batch publication receipt does not match the proposal.',409);
      return prior.map(v=>({id:v.pill.id,version:v.pill.version}));
    }
    // Prepare every target before touching records. JSON uses one atomic rename;
    // SQLite uses its existing transaction for all releases and the Case receipt.
    const prepared=items.map(item=>{
      let r=records.find(r=>r.id===item.id);
      if(item.isNew){if(r)throw fail('New Pill ID already exists.',409);r={id:item.id,revision:0,state:'draft',releases:[],events:[],documents:[]};}
      else {
        const release=r?.releases.find(v=>v.active&&!v.disabled);
        if(!r||r.revision!==item.baseRevision||r.state!=='published'||release?.pill.version!==item.baseVersion)throw fail('A target Pill changed or has an editable draft. Re-analyze against current versions.',409);
        if(release.contentHash&&release.contentHash!==releaseHash(release))throw fail('Published Pill checksum mismatch.',409);
      }
      if(evaluating.has(item.id)||r.documents?.some(d=>running.has(`${item.id}/${d.id}`))||persistence?.isLeased(`studio:analyze:${item.id}`)||persistence?.isLeased(`studio:evaluate:${item.id}`))throw fail('A target Pill is being analyzed or evaluated.',409);
      if(['rules','actions','boundaries','escalationConditions'].some(key=>(item.content.pill[key]||[]).length>30)||(item.content.sources||[]).length>20||(item.content.examples||[]).length>20)throw fail('A target exceeds the Pill content limit. No batch changes were truncated or published.');
      const content=contentFrom(item.content,item.id);ensureDraftRouting(content.pill);
      const validation=validateDraft(content);if(!validation.passed)throw fail(`${content.pill.name}: ${validation.errors[0]}`);
      ensureActionLinks(content.pill);
      return {record:structuredClone(r),content,validation,isNew:item.isNew};
    });
    const at=new Date().toISOString();
    for(const {record:r,content,validation,isNew} of prepared){
      const previous=r.releases.find(v=>v.active)?.pill;
      r.releases.forEach(v=>v.active=false);
      const pill={...structuredClone(content.pill),status:'approved',version:`${r.releases.length+1}.0.0`};
      const release={pill,sources:content.sources,examples:content.examples,captureHistory:structuredClone(r.captureHistory||[]),learningImports:structuredClone(r.learningImports||[]),...(r.expertFeedback?.length?{expertFeedback:structuredClone(r.expertFeedback),expertTrials:structuredClone(r.expertTrials||[])}:{}),active:true,publishedAt:at,reviewer:body.authenticatedActor.name,actorId:body.authenticatedActor.id,identityVerified:true,validation,
        improvement:{batchId:batch.id,caseId:batch.caseId,solutionId:batch.solutionId,planHash,validation:batch.validation,...(batch.review?{review:batch.review}:{})},evaluation:{method:'admin_batch_review',usedAsReleaseGate:false}};
      release.contentHash=releaseHash(release);r.releases.push(release);
      Object.assign(r,{content,state:'published',validation,revision:r.revision+1,updatedAt:at});delete r.draftBase;
      r.events.push({action:'publish',batchId:batch.id,actorId:body.authenticatedActor.id,at,target:{id:r.id,version:pill.version},previous:previous?{id:r.id,version:previous.version}:null});
      if(isNew)records.push(r);else records[records.findIndex(v=>v.id===r.id)]=r;
    }
    return prepared.map(({record:r})=>({id:r.id,version:r.releases.at(-1).pill.version}));
  });
}
