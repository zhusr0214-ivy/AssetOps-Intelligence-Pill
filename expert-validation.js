import {createHash,randomUUID} from 'node:crypto';
import {evaluationKey,sampleStatistics,automaticScopeChecks} from './pill-evaluation.js';
import {triagePromptVersion} from './triage-agent.js';

export const expertKnowledgeKey=record=>createHash('sha256').update(JSON.stringify(record.content.pill)).digest('hex');
export function recordExpertValidation(record,validateDraft,authenticatedActor) {
  if(!authenticatedActor?.id)throw Object.assign(Error('Authenticated expert confirmation is required.'),{status:403});
  const baseline=record.releases.find(r=>r.active&&!r.disabled)?.pill||null,key=evaluationKey(record,baseline);
  if(!record.expertAttempt&&record.evaluations?.at(-1)?.method==='expert_confirmed_examples'&&record.evaluations.at(-1).key===key&&record.evaluations.at(-1).passed)return record.evaluations.at(-1);
  const knowledgeKey=expertKnowledgeKey(record),suite=record.evaluationSuite||[],now=new Date().toISOString(),previous=record.evaluations?.at(-1);
  const results=suite.map(item=>{
    const trial=(record.expertTrials||[]).find(t=>t.knowledgeKey===knowledgeKey&&t.feedback?.decision==='accepted'&&t.feedback.actorId&&JSON.stringify(t.facts)===JSON.stringify(item.facts)&&t.report.status===item.expected.status&&t.feedback.expectedHandling===item.expected.workflow?.steps&&(!t.promptVersion||t.promptVersion===triagePromptVersion)&&(!t.model||t.model===(process.env.SOCLAAS_MODEL||'default'))&&(t.promptVersion||!previous||previous.promptVersion===triagePromptVersion&&previous.model===(process.env.SOCLAAS_MODEL||'default')));
    const sample=trial?{passed:true,actual:{status:trial.report.status,ruleIds:trial.report.hypotheses.map(h=>h.ruleId),actionIds:trial.report.actions.map(a=>a.id),missingFields:trial.report.missingFields},report:structuredClone(trial.report),checks:{expertConfirmed:true,currentKnowledge:true},modelCalled:trial.report.status!=='out_of_scope',durationMs:0,expertConfirmation:{trialId:trial.id,actorId:trial.feedback.actorId,reviewer:trial.feedback.contributor,at:trial.feedback.at}}:{passed:false,error:'This saved example needs expert confirmation against the current knowledge.',failureCode:'expert_confirmation_required',modelCalled:false,durationMs:0};
    return {name:item.name,expected:structuredClone(item.expected),candidate:{...sample,samples:[sample],statistics:sampleStatistics([sample])},baseline:null,regression:false,comparisonReliable:null};
  });
  const validation=validateDraft(record.content);
  const blockers=[...validation.errors];
  if(record.expertAttempt)blockers.push('Re-run the saved example: its analysis is not yet available.');
  if(!suite.some(t=>t.expected.status==='complete'))blockers.push('Confirm at least one supported example.');
  if(record.documents?.some(d=>d.captureCompleteness==='partial'))blockers.push('Complete the pending source extraction before release; retained drafts are not completed knowledge.');
  if(record.documents?.some(d=>d.status!=='reviewed'))blockers.push('Review pending source proposals.');
  if(record.expertDialogue?.messages.some(m=>m.text)&&!record.expertDialogue.documentId)blockers.push('Confirm the pending discussion as a source.');
  if(record.expertFeedback?.some(f=>f.status==='pending_knowledge_review'))blockers.push('Review the pending expert corrections.');
  if(record.expertFeedback?.some(f=>f.status==='pending_report_fix'))blockers.push('Re-run and confirm examples with pending report-only corrections.');
  const scope=automaticScopeChecks(record.content.pill,suite.find(t=>t.expected.status==='complete')?.facts||{});
  const run={id:`EVAL-${randomUUID()}`,method:'expert_confirmed_examples',key,startedAt:now,completedAt:now,requestedBy:authenticatedActor.id,promptVersion:triagePromptVersion,model:process.env.SOCLAAS_MODEL||'default',content:structuredClone(record.content),suite:structuredClone(suite),baseline:structuredClone(baseline),results,statistics:sampleStatistics(results.flatMap(r=>r.candidate.samples)),automaticScopeChecks:scope,blockers,passed:!blockers.length&&scope.passed&&results.length>0&&results.every(r=>r.candidate.passed),coverage:{uniqueCases:suite.length,categories:[...new Set(suite.map(t=>t.facts.category))],expectedStatuses:[...new Set(suite.map(t=>t.expected.status))],safetyProof:false,independentRegression:false},evidenceNote:'Human confirmation of already generated, validated reports. No second model run, automatic semantic grading, repeated-trial stability claim or baseline comparison was performed.'};
  if(run.passed&&!record.independentReviewRequired)run.expertReview={decision:'accepted',method:'expert_example_confirmation',actorId:authenticatedActor.id,reviewer:authenticatedActor.name,identityVerified:true,credentialsIndependentlyVerified:false,certification:false,at:now,key,scope:record.content.pill.scope,limitations:record.content.pill.boundaries.join('\n'),notes:'Confirmed the generated example reports; final publication review remains required.'};
  record.evaluations=[...(record.evaluations||[]),run];record.validation=validation;record.state=validation.passed?'validated':'draft';
  record.events.push({action:'expert_examples_validated',runId:run.id,actorId:authenticatedActor.id,at:now});
  return run;
}
