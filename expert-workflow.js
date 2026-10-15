import {recordExpertValidation} from './expert-validation.js';
import {triagePromptVersion} from './triage-agent.js';
import {discussionLanguageMatches} from './public/expert-language.js';
import {createHash,randomUUID} from 'node:crypto';
import {fields} from './intake.js';
import {matchPill} from './pill-routing.js';
import {validateTriageResult} from './triage.js';
import {validateSuite} from './pill-evaluation.js';
import {relatedKnowledge} from './expert-interview.js';

const fail=(message,status=422)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
const knowledgeKey=record=>createHash('sha256').update(JSON.stringify(record.content.pill)).digest('hex');
const actor=body=>({actorId:body.authenticatedActor?.id||null,contributor:body.authenticatedActor?.name||'Expert'});
export function expertPlan(report) {
  return [report.summary,...(report.actions||[]).map(a=>`${a.owner?`${a.owner}: `:''}${a.instruction}`)].filter(Boolean).join('\n').slice(0,4000);
}

export function createExpertMethods({list,mutate,find,service,interviewAgent,evaluationAgent,validateDraft}) {
  const methods={
    async expertValidate(id,body) {
      const saved=await mutate(records=>{const record=find(records,id,body.revision);recordExpertValidation(record,validateDraft,body.authenticatedActor);record.revision++;return record;});
      if(body.submit===true)return service.change(id,'submit',{revision:saved.revision,autoValidate:true,authenticatedActor:body.authenticatedActor});
      return saved;
    },
    async expertTurn(id,body) {
      if(!['experience','feedback','defer','retry','continue'].includes(body.kind||'experience'))throw fail('Unknown expert message type.');
      if(!['defer','retry','continue'].includes(body.kind)&&!text(body.message,12000))throw fail('Describe your experience or correction in up to 12000 characters.');
      if(body.sourceReference!==undefined&&(typeof body.sourceReference!=='string'||body.sourceReference.length>1000)||body.expertName!==undefined&&(typeof body.expertName!=='string'||body.expertName.length>120))throw fail('Source details are too long.');
      // Save before the provider call: a failed request must not erase expertise.
      const saved=await mutate(records=>{
        const record=find(records,id,body.revision);
        let dialogue=record.expertDialogue;
        if(!dialogue||dialogue.documentId){
          if(['retry','defer','continue'].includes(body.kind))throw fail('There is no pending discussion to continue.');
          if(dialogue){record.expertDialogueHistory=[...(record.expertDialogueHistory||[]),dialogue];if(record.expertDialogueHistory.length>20)throw fail('Start a separate source after 20 discussions.');}
          dialogue=record.expertDialogue={id:`EXPERT-${randomUUID()}`,messages:[],reply:null};
        }
        if(body.kind==='retry'||body.kind==='continue'){if(body.kind==='retry'&&!['failed','thinking'].includes(dialogue.status))throw fail('Only a failed or interrupted discussion can be retried.',409);}
        else {
          if(body.kind==='defer'&&!dialogue.reply?.question)throw fail('There is no question to defer.');
          if(dialogue.messages.length>=40)throw fail('Confirm this discussion before adding more experience.');
          const message={id:randomUUID(),kind:body.kind||'experience',text:body.kind==='defer'?'':body.message.trim(),...(body.kind==='defer'?{deferredQuestion:dialogue.reply.question}:{}),...actor(body),...(body.sourceReference?{sourceReference:body.sourceReference.trim()}:{}),...(body.expertName?{expertName:body.expertName.trim()}:{}),at:new Date().toISOString()};
          if(dialogue.messages.reduce((n,m)=>n+m.text.length,0)+message.text.length>45000)throw fail('Confirm this discussion before adding more experience.');
          dialogue.messages.push(message);
        }
        dialogue.status='thinking';delete dialogue.error;record.state='draft';record.validation=null;record.revision++;
        if(body.authenticatedActor)record.contributorIds=[...new Set([...(record.contributorIds||[]),body.authenticatedActor.id])];
        record.events.push({action:'expert_message_saved',dialogueId:dialogue.id,revision:record.revision,at:new Date().toISOString(),...actor(body)});
        return structuredClone(record);
      });
      try {
        const records=await list();
        const reply=structuredClone(await interviewAgent({pill:saved.content.pill,sourceBlocks:(saved.documents||[]).flatMap(d=>d.blocks||[]).slice(-30),messages:saved.expertDialogue.messages,previous:saved.expertDialogue.reply,relatedPills:relatedKnowledge(records,saved)}));
        if(reply.question&&saved.expertDialogue.messages.some(m=>m.deferredQuestion?.trim()===reply.question.trim())){reply.question=null;reply.reason=null;}
        return await mutate(records=>{const record=find(records,id,saved.revision);record.expertDialogue.reply=reply;record.expertDialogue.status='ready';record.revision++;return record;});
      } catch(error) {
        await mutate(records=>{const record=records.find(r=>r.id===id);if(record?.revision===saved.revision){record.expertDialogue.status='failed';record.expertDialogue.error='Discussion unavailable. Your experience is saved; retry or confirm the source.';record.revision++;}});
        throw error;
      }
    },
    async expertConfirm(id,body) {
      let record=find(await list(),id,body.revision),dialogue=record.expertDialogue;
      if(body.confirmed!==true||!dialogue?.messages.some(m=>m.text))throw fail('Confirm your supplied experience before extracting it.');
      if(body.confirmedUnderstanding===true&&dialogue.reply&&!discussionLanguageMatches(dialogue,dialogue.reply))throw fail('复述未保持专家原话语言。请刷新页面，选择仅使用已保存的原始经验。');
      if(!dialogue.documentId){
        // Questions provide context; only expert answers can become source claims.
        let transcript=dialogue.messages.filter(m=>m.text).map(m=>`Expert: ${m.expertName||m.contributor}\n${m.sourceReference?`Reference: ${m.sourceReference}\n`:''}${m.text}`).join('\n\n');
        if(body.confirmedUnderstanding===true&&dialogue.reply?.understanding)transcript+=`\n\nRestatement explicitly adopted by ${body.authenticatedActor?.name||'the expert'}:\n${dialogue.reply.understanding}`;
        record=await service.upload(id,record.revision,`${dialogue.id}.txt`,Buffer.from(transcript,'utf8'),body.authenticatedActor,{dialogueId:dialogue.id});
        dialogue=record.expertDialogue;
      }
      const document=record.documents.find(d=>d.id===dialogue.documentId);
      if(['extracted','reviewed'].includes(document.status)&&document.captureCompleteness!=='partial')return record;
      return service.analyze(id,document.id,record.revision);
    },
    async expertTrial(id,body) {
      if(!text(body.description,4000))throw fail('Describe one real or hypothetical example in up to 4000 characters.');
      const saved=find(await list(),id,body.revision),pill=saved.content.pill;
      if(!pill.rules?.length)throw fail('Confirm some extracted knowledge before trying an example.');
      if(saved.expertTrials?.at(-1)&&!saved.expertTrials.at(-1).feedback)throw fail('Review the latest example before trying another one.',409);
      if((saved.expertTrials||[]).length>=30)throw fail('This draft already retains 30 example trials.');
      const facts=Object.fromEntries(fields.map(k=>[k,'']));Object.assign(facts,{category:pill.applicability?.categories?.[0]||'hvac_cooling',description:body.description.trim(),observations:body.description.trim()});
      const reportFeedback=(saved.expertFeedback||[]).filter(f=>f.kind==='report'&&f.status==='pending_report_fix'&&saved.expertTrials?.some(t=>t.id===f.trialId&&JSON.stringify(t.facts)===JSON.stringify(facts))).slice(-5).map(f=>({correction:f.correction}));
      const snapshot={id:'expert-example',revision:0,validationScenario:true,fields:facts,...(reportFeedback.length?{reportFeedback}:{})};
      let report;
      if(!matchPill(facts,pill))report={status:'out_of_scope',summary:'This example is outside the current Pill scope. Discuss the gap or extend related knowledge.',hypotheses:[],actions:[],missingFields:[]};
      else {
        try {report=validateTriageResult(await evaluationAgent(snapshot,pill),snapshot,pill);report.status=report.missingFields.length?'needs_information':report.hypotheses.length?'complete':'knowledge_gap';}
        catch(error) {
          // A failed generation is retained separately, never as a passing trial.
          return mutate(records=>{const record=find(records,id,saved.revision);record.expertAttempt={description:facts.description,status:'analysis_unavailable',summary:'本次暂不能可靠判断应采用哪个处理分支。案例已保存；当前结果不能用于确认测试通过。',nextStep:'请重试本案例。若仍无法分析，可补充你期望的处理方式，作为专家反馈完善知识。',reason:[502,503,504].includes(error.status)?'模型服务暂时未能完成分析。':'模型输出未通过一致性检查，尚未形成可信的处理建议。',at:new Date().toISOString()};record.validation=null;record.revision++;return record;});
        }
      }
      return mutate(records=>{const record=find(records,id,saved.revision);delete record.expertAttempt;record.expertTrials=[...(record.expertTrials||[]),{id:`EXAMPLE-${randomUUID()}`,facts,report,proposedHandling:expertPlan(report),knowledgeKey:knowledgeKey(record),promptVersion:triagePromptVersion,model:process.env.SOCLAAS_MODEL||'default',at:new Date().toISOString(),...actor(body)}];record.revision++;return record;});
    },
    async expertFeedback(id,body) {
      if(body.reclassify===true){
        if(body.feedbackKind!=='report')throw fail('Choose a report-only correction.');
        return mutate(records=>{
          const record=find(records,id,body.revision),entry=record.expertFeedback?.find(f=>f.trialId===body.trialId),trial=record.expertTrials?.find(t=>t.id===body.trialId),dialogue=record.expertDialogue;
          if(!entry||entry.status!=='pending_knowledge_review'||trial?.feedback?.decision!=='corrected')throw fail('This correction is not awaiting knowledge review.',409);
          if(dialogue?.documentId&&(dialogue.feedbackIds||[]).includes(body.trialId))throw fail('This correction already became a source; review that source first.',409);
          if(dialogue&&(dialogue.feedbackIds||[]).includes(body.trialId)){
            const only=(dialogue.feedbackIds||[]).length===1;
            const messages=dialogue.messages.filter(m=>m.trialId===body.trialId||only&&m.kind==='feedback'&&!m.trialId);
            record.expertDialogueHistory=[...(record.expertDialogueHistory||[]),{...structuredClone(dialogue),messages:structuredClone(messages),status:'report_feedback_archived'}];
            dialogue.messages=dialogue.messages.filter(m=>!messages.includes(m));dialogue.feedbackIds=dialogue.feedbackIds.filter(v=>v!==body.trialId);dialogue.reply=null;
            if(!dialogue.messages.length)delete record.expertDialogue;
          }
          entry.kind='report';entry.status='pending_report_fix';trial.feedback.kind='report';record.validation=null;record.revision++;
          record.events.push({action:'expert_feedback_reclassified',trialId:body.trialId,kind:'report',at:new Date().toISOString(),...actor(body)});return record;
        });
      }
      if(body.feedbackKind!==undefined&&!['knowledge','report'].includes(body.feedbackKind))throw fail('Unknown feedback kind.');
      if(!['accepted','corrected'].includes(body.decision)||!text(body.expectedHandling,4000))throw fail('Confirm or correct the handling you expect for this example.');
      if(body.decision==='corrected'&&!text(body.feedback,4000))throw fail('Explain what was wrong or missing so it can improve the knowledge.');
      const reviewed=await mutate(records=>{
        const record=find(records,id,body.revision),trial=record.expertTrials?.find(t=>t.id===body.trialId);
        if(!trial||trial.feedback)throw fail('This example is missing or already reviewed.',409);
        if(trial.knowledgeKey!==knowledgeKey(record))throw fail('Knowledge changed. Try the example again before reviewing it.',409);
        if(trial&&body.decision==='accepted'&&(body.expectedHandling.trim()!==trial.proposedHandling.trim()||body.expectedStatus&&body.expectedStatus!==trial.report.status))throw fail('Choose Wrong or missing something and explain the change when correcting the expected handling.');
        const expected={status:body.expectedStatus||trial.report.status,workflow:{steps:body.expectedHandling.trim(),responsibility:'',information:'',completion:''},ruleIds:[],actionIds:[],missingFields:[]};
        // Internal references support the existing structural/examples editor;
        // workflow evaluation still compares handling, never exact ID sets.
        if(body.decision==='accepted'&&expected.status==='complete'){
          expected.ruleIds=trial.report.hypotheses.map(h=>h.ruleId);expected.actionIds=trial.report.actions.map(a=>a.id);
        }
        if(expected.status==='needs_information')expected.missingFields=trial.report.missingFields;
        const prior=(record.evaluationSuite||[]).find(item=>JSON.stringify(item.facts)===JSON.stringify(trial.facts));
        const suite=[...(record.evaluationSuite||[]).filter(item=>JSON.stringify(item.facts)!==JSON.stringify(trial.facts)),{name:prior?.name||`Expert example ${(record.expertTrials||[]).indexOf(trial)+1}`,mode:'scenario',facts:trial.facts,expected}];
        // A gap example can be retained before the first supported case exists.
        record.evaluationSuite=validateSuite(suite,{allowIncomplete:!suite.some(t=>t.expected.status==='complete')});
        trial.feedback={kind:body.feedbackKind||'knowledge',decision:body.decision,expectedHandling:body.expectedHandling.trim(),correction:body.feedback?.trim()||'',at:new Date().toISOString(),...actor(body)};
        if(body.decision==='accepted'&&trial.report.hypotheses.length&&trial.report.actions.length&&(record.content.examples||[]).length<20)record.content.examples.push({scenario:trial.facts.description,rationale:body.expectedHandling.trim(),ruleIds:trial.report.hypotheses.map(h=>h.ruleId),actionIds:trial.report.actions.map(a=>a.id)});
        record.expertFeedback=[...(record.expertFeedback||[]),{trialId:trial.id,...trial.feedback,status:body.decision==='corrected'?(body.feedbackKind==='report'?'pending_report_fix':'pending_knowledge_review'):'confirmed_example'}];
        if(body.decision==='accepted')for(const entry of record.expertFeedback||[])if(entry.status==='pending_report_fix'&&record.expertTrials.find(t=>t.id===entry.trialId&&JSON.stringify(t.facts)===JSON.stringify(trial.facts))){entry.status='resolved_by_retest';entry.resolvedByTrialId=trial.id;}
        if(body.decision==='corrected'&&body.feedbackKind!=='report'){
          let dialogue=record.expertDialogue;
          if(!dialogue||dialogue.documentId){
            if(dialogue){if((record.expertDialogueHistory||[]).length>=20)throw fail('Start a separate source after 20 discussions.');record.expertDialogueHistory=[...(record.expertDialogueHistory||[]),dialogue];}
            dialogue=record.expertDialogue={id:`EXPERT-${randomUUID()}`,messages:[],reply:null};
          }
          const correction=`Example supplied by the expert:\n${trial.facts.description}\nExpert correction:\n${body.feedback.trim()}\nExpert expected handling:\n${body.expectedHandling.trim()}`;
          if(dialogue.messages.length>=40||dialogue.messages.reduce((n,m)=>n+m.text.length,0)+correction.length>45000)throw fail('Confirm the current discussion before adding this correction.');
          dialogue.messages.push({id:randomUUID(),kind:'feedback',trialId:trial.id,text:correction,...actor(body),at:new Date().toISOString()});
          dialogue.feedbackIds=[...new Set([...(dialogue.feedbackIds||[]),trial.id])];dialogue.reply=null;dialogue.status='ready';
        }
        record.evaluationRequired=true;record.state='draft';record.validation=null;record.revision++;
        if(body.authenticatedActor)record.contributorIds=[...new Set([...(record.contributorIds||[]),body.authenticatedActor.id])];
        record.events.push({action:'expert_example_reviewed',trialId:trial.id,decision:body.decision,revision:record.revision,at:trial.feedback.at,...actor(body)});
        if(body.decision==='accepted'&&body.authenticatedActor?.id)recordExpertValidation(record,validateDraft,body.authenticatedActor);
        return record;
      });
      if(body.decision==='corrected'&&body.feedbackKind==='report'){
        const trial=reviewed.expertTrials.find(t=>t.id===body.trialId);
        return methods.expertTrial(id,{revision:reviewed.revision,description:trial.facts.description,authenticatedActor:body.authenticatedActor});
      }
      return reviewed;
    }
  };
  return methods;
}
