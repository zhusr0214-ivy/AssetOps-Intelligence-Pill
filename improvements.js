import {randomUUID} from 'node:crypto';
import {createImprovementAgent,validateImprovementPlan,materializeTargets,buildBatchItems,fail} from './improvement-plan.js';

export function createImprovementService(store,studio,agent=createImprovementAgent()) {
  const busy=new Set();
  const getCase=async id=>{const i=(await store.list()).find(i=>i.id===id);if(!i)throw fail('Case not found.',404);return i;};
  const find=(i,id)=>{const b=i.improvementBatches?.find(b=>b.id===id);if(!b)throw fail('Improvement proposal not found.',404);return b;};
  const check=(b,revision)=>{if(!Number.isInteger(revision)||revision!==b.revision)throw fail('Proposal changed. Reload before continuing.',409);};
  const authorize=(body,publish=false)=>{if(!body.authenticatedActor?.id||!body.authenticatedRoles?.some(r=>(publish?['admin']:['admin','expert']).includes(r)))throw fail('Your role cannot perform this improvement operation.',403);};
  const locked=async(id,fn)=>{if(busy.has(id))throw fail('Improvement operation is running. Retry shortly.',409);busy.add(id);try{return await store.withLease(`improvements:${id}`,fn);}finally{busy.delete(id);}};
  const persist=(i,b)=>store.update(i.id,{improvementBatches:(i.improvementBatches||[]).map(v=>v.id===b.id?b:v)},i.revision||0);
  return {
    async list(){return (await store.list()).flatMap(i=>(i.improvementBatches||[]).map(b=>({id:b.id,caseId:i.id,title:i.title,owner:b.experience.expert,experience:b.experience.solution,summary:b.summary,status:b.status,createdAt:b.createdAt,targets:b.targets.map(t=>({name:t.name}))})));},
    async get(caseId,id){return find(await getCase(caseId),id);},
    async create(caseId,body){
      authorize(body);
      console.log('[improvements.create] start', caseId, body.solutionId, 'revision:', body.revision);
      let batchId=await locked(caseId,async()=>{
        const i=await getCase(caseId),s=i.expertSolutions?.find(s=>s.id===body.solutionId);
        if(!s)throw fail('Expert experience not found.',404);
        if(s.improvementBatchId){
          const existing=find(await getCase(caseId),s.improvementBatchId);
          if(existing.status!=='pending_analysis')return null;
          return s.improvementBatchId;
        }
        if(body.confirmed!==true||body.revision!==(i.revision||0))throw fail('Confirm the current expert experience before proceeding.',409);
        const b={id:`BATCH-${randomUUID()}`,caseId,solutionId:s.id,revision:0,status:'pending_analysis',createdAt:new Date().toISOString(),experience:structuredClone(s),summary:'',targets:[],history:[],validation:null};
        await store.update(caseId,{improvementBatches:[...(i.improvementBatches||[]),b],expertSolutions:i.expertSolutions.map(v=>v.id===s.id?{...v,improvementBatchId:b.id,status:'pending_improvement',experienceConfirmation:{actorId:body.authenticatedActor.id,name:body.authenticatedActor.name,at:b.createdAt}}:v)},i.revision||0);
        return b.id;
      });
      if(batchId){try{console.log('[improvements.create] calling analyze', caseId, batchId); await this.analyze(caseId,batchId,{...body,revision:0}); console.log('[improvements.create] analyze done');}catch(error){console.error('[improvements.create] analyze failed', error.status, error.message); if(error.status!==409)throw error;}}
      return getCase(caseId);
    },
    async analyze(caseId,id,body){
      authorize(body);
      return locked(caseId,async()=>{
        let i=await getCase(caseId);const b=find(i,id);check(b,body.revision);
        if(['publishing','published','closed'].includes(b.status))throw fail('This proposal cannot be analyzed again.',409);
        const records=await studio.list();
        const input={caseId,experience:b.experience,pills:records.flatMap(r=>r.releases.filter(v=>v.active&&!v.disabled).map(v=>v.pill))};
        if(JSON.stringify(input).length>160000)throw fail('The published library is too large for one improvement analysis; no Pills were silently omitted.');
        const plan=validateImprovementPlan(await agent(input),input);
        i=await getCase(caseId);const current=find(i,id);check(current,body.revision);
        const next={...current,summary:plan.summary,targets:materializeTargets(plan,input,records),status:plan.targets.length?'in_review':'no_changes',revision:current.revision+1,validation:null,
          history:[...current.history,{action:'analyze',actorId:body.authenticatedActor.id,at:new Date().toISOString(),previousTargets:current.targets}]};
        await persist(i,next);return next;
      });
    },
    async save(caseId,id,body){
      authorize(body);
      return locked(caseId,async()=>{
        const i=await getCase(caseId),b=find(i,id);check(b,body.revision);
        if(b.status!=='in_review')throw fail('Only review proposals can be edited.',409);
        const all=b.targets.flatMap(t=>t.changes);
        if(!Array.isArray(body.changes)||body.changes.length!==all.length||new Set(body.changes.map(c=>c?.id)).size!==all.length)throw fail('Provide every change exactly once.');
        const next=structuredClone(b);
        for(const edit of body.changes){
          const c=next.targets.flatMap(t=>t.changes).find(c=>c.id===edit?.id);
          if(!c||!['pending','accepted','excluded'].includes(edit.decision)||typeof edit.after!=='string'||!edit.after.trim()||edit.after.length>(c.field==='scope'?4000:2000))throw fail('Invalid change decision or text.');
          Object.assign(c,{after:edit.after.trim(),decision:edit.decision});
        }
        next.review=null;next.revision++;
        next.history.push({action:'save',actorId:body.authenticatedActor.id,at:new Date().toISOString(),previousTargets:b.targets});
        await persist(i,next);return next;
      });
    },
    async publish(caseId,id,body){
      authorize(body,true);
      return locked(caseId,async()=>{
        const run=async()=>{
          let i=await getCase(caseId),b=find(i,id);
          if(b.status==='published')return b;
          if(b.status!=='publishing'){
            check(b,body.revision);
            if(b.status!=='in_review')throw fail('Only reviewed proposals can be published.');
            buildBatchItems(b);
            b={...b,status:'publishing',revision:b.revision+1,review:{actorId:body.authenticatedActor.id,name:body.authenticatedActor.name,at:new Date().toISOString(),method:'admin_publication_of_selected_changes',outcomeVerified:false}};
            i=await persist(i,b);
          }
          const releases=await studio.publishImprovementBatch(b,buildBatchItems(b),body);
          i=await getCase(caseId);const current=find(i,id);
          const done={...current,status:'published',releases,revision:current.revision+1,publishedAt:new Date().toISOString()};
          await persist(i,done);return done;
        };
        try{return await (store.transaction?store.transaction(run):run());}
        catch(error){
          // A failed validation/stale-version check writes no release. Permit re-analysis.
          if(!store.transaction&&[409,422].includes(error.status)){
            const i=await getCase(caseId),b=find(i,id);
            const released=(await studio.list()).some(r=>r.releases.some(v=>v.improvement?.batchId===id));
            if(b.status==='publishing'&&!released)await persist(i,{...b,status:'in_review',revision:b.revision+1,validation:null});
          }
          throw error;
        }
      });
    },
    async close(caseId,id,body){
      authorize(body);
      return locked(caseId,async()=>{const i=await getCase(caseId),b=find(i,id);check(b,body.revision);
        if(!['no_changes','in_review'].includes(b.status)||b.targets.some(t=>t.changes.some(c=>c.decision!=='excluded')))throw fail('Exclude all changes before closing without publication.');
        const next={...b,status:'closed',revision:b.revision+1};await persist(i,next);return next;});
    }
  };
}
