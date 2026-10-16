import { createServer } from "node:http";
import { readFile, mkdir, access } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assessIntake, validateFields } from './intake.js';
import { createIncidentStore } from './incident-store.js';
import { createIntakeAgent } from './intake-agent.js';
import { createCaseConversationAgent } from './case-conversation-agent.js';
import { createCaseRecords } from './case-records.js';
import { loadLocalEnv } from './config.js';
import { sendMessage, manualFieldsFor } from './conversation.js';
import { createTriageService, ahuPill } from './triage.js';
import { createReviewService } from './review.js';
import { createPillStudio } from './pill-studio.js';
import { uploadLimit } from './document-parser.js';
import { createCaseDocuments } from './case-documents.js';
import { createLearningService } from './learning.js';
import {createImprovementService} from './improvements.js';
import { createTaskService } from './tasks.js';
import { operationsMetrics, operationsCSV } from './operations-metrics.js';
import { createAuth } from './auth.js';
import { createAudit } from './runtime.js';
import { secureApplication } from './application.js';
import { createCoordinationAgent } from './coordination-agent.js';
import { modelFetch } from './model-runtime.js';
import { openDatabase } from './database.js';
import { registerInstance, startBackupScheduler, createDatabaseBackup } from './storage-operations.js';

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

const modules = [
  { id: 'overview', title: 'Operations Overview', summary: 'Cases, reviews and knowledge updates.' },
  { id: 'cases', title: 'Case Workspace', summary: 'Case intake, analysis and human decisions.' },
  { id: 'studio', title: 'Pill Studio', summary: 'Expert knowledge, drafts and improvement candidates.' },
  { id: 'library', title: 'Pill Library', summary: 'Approved domain capabilities.' }
];
const apiRoutes = {
  "/api/modules": { modules },
  "/api/dashboard": { module: modules[0] },
  "/api/governance": { module: modules[3], pills: [ahuPill] },
  "/api/library": { module: modules[3], pills: [ahuPill].filter(pill => pill.status === 'approved') }
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": contentTypes[".html"] });
    res.end(fallback);
  }
}

async function readBody(req) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    const limit=/^\/api\/improvements\/[^/]+\/[^/]+\/save$/.test(req.url)?300000:100000;
    if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    body += chunk;
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
    delete value.authenticatedActor;
    delete value.authenticatedRoles;
    if (req.authenticatedActor) {
      value.authenticatedActor = req.authenticatedActor;
      value.actor = value.author = value.reviewer = req.authenticatedActor.name;
    }
    if (req.authenticatedRoles) value.authenticatedRoles = req.authenticatedRoles;
    return value;
  }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}

export function createHandler(store = createIncidentStore(process.env.DATA_FILE || join(__dirname, 'data/incidents.json')), intakeAgent, triageAgent, studio = createPillStudio(process.env.PILL_DATA_FILE || join(__dirname, 'data/pills.json')), learningAgent, coordinator, improvementAgent) {
 const extractionAgent = intakeAgent || createIntakeAgent();
 const conversationAgent = intakeAgent || createCaseConversationAgent({ extract: extractionAgent, loadPills: () => studio.runtimePills() });
 const busyCases = new Set();
 const caseDocuments = createCaseDocuments(store);
 const improvements = createImprovementService(store, studio, improvementAgent);
 const caseRecords = createCaseRecords(store, studio, {improvements});
 const triage = createTriageService(store, triageAgent, undefined, undefined, () => studio.runtimePills(), coordinator);
 const review = createReviewService(store, () => studio.runtimePills());
 const learning = createLearningService(store, studio, learningAgent);
 const tasks = createTaskService(store, () => studio.runtimePills());
 const atomic = fn => store.transaction ? store.transaction(fn) : fn();
 return async (req, res) => {
 try {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  if(path==='/api/improvements'&&req.method==='GET')return sendJson(res,200,{batches:await improvements.list()});
  const improvementMatch=path.match(/^\/api\/improvements\/([^/]+)\/([^/]+)(?:\/(analyze|save|publish|close))?$/);
  if(improvementMatch){
    const [,caseId,batchId,operation]=improvementMatch;
    if(req.method==='GET'&&!operation)return sendJson(res,200,{batch:await improvements.get(caseId,batchId)});
    if(req.method==='POST'&&operation)return sendJson(res,200,{batch:await improvements[operation](caseId,batchId,await readBody(req))});
    return sendJson(res,405,{error:'Method not allowed.'});
  }
  const publishedEdit = path.match(/^\/api\/studio\/([^/]+)(?:\/|$)/);
  if (publishedEdit && !['GET','HEAD'].includes(req.method) && req.authenticatedRoles && !req.authenticatedRoles.includes('admin')) {
    const record = await studio.get(decodeURIComponent(publishedEdit[1]));
    if (record.state === 'published' || record.releases?.length) return sendJson(res, 403, { error: 'Only administrators can edit published Pills.' });
  }
  const recordMatch = path.match(/^\/api\/cases\/([^/]+)\/(confirmations|result-summary|expert-solutions|expert-experience-confirmation)$/);
  if (recordMatch && req.method === 'POST') {
    const [, id, operation] = recordMatch;
    const allowed = ['expert-solutions', 'expert-experience-confirmation'].includes(operation) ? ['admin', 'expert'] : operation === 'confirmations' ? ['admin', 'expert', 'reviewer'] : ['admin', 'operator', 'expert', 'reviewer'];
    if (!req.authenticatedActor || !req.authenticatedRoles?.some(role => allowed.includes(role))) return sendJson(res, 403, { error: 'Your role does not permit this Case record operation.' });
    if (busyCases.has(id)) return sendJson(res, 409, { error: 'This Case is being updated. Retry shortly.' });
    busyCases.add(id);
    try {
      const body = await readBody(req);
      if (operation === 'confirmations' && body.messageId !== undefined && !req.authenticatedRoles.some(role => ['admin', 'reviewer'].includes(role))) return sendJson(res, 403, { error: 'A reviewer account is required for a Case supervision decision.' });
      const incident = operation === 'confirmations' ? await caseRecords.confirm(id, body) : operation === 'expert-solutions' ? await caseRecords.expertSolution(id, { ...body, deferDraft: true }) : operation === 'expert-experience-confirmation' ? await caseRecords.confirmExperience(id, body) : await caseRecords.summarize(id);
      return sendJson(res, 200, { incident });
    } finally { busyCases.delete(id); }
  }
  const attachmentMatch = path.match(/^\/api\/incidents\/([^/]+)\/(documents|document-questions)$/);
  if (attachmentMatch && req.method === 'POST') {
    const [, id, operation] = attachmentMatch;
    if (operation === 'document-questions') return sendJson(res, 200, { incident: await caseDocuments.ask(id, await readBody(req)) });
    let filename;
    try { filename = decodeURIComponent(req.headers['x-filename'] || ''); } catch { return sendJson(res, 400, { error: 'Invalid filename.' }); }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > uploadLimit) return sendJson(res, 413, { error: 'Files must be no larger than 10 MB.' }); chunks.push(Buffer.from(chunk)); }
    return sendJson(res, 201, { incident: await caseDocuments.upload(id, filename, Buffer.concat(chunks)) });
  }
  if (['/api/operations', '/api/operations/export'].includes(path) && req.method === 'GET') {
    const data = operationsMetrics(await store.list(), Object.fromEntries(url.searchParams));
    if (path.endsWith('/export')) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="assetops-operations.csv"', 'Cache-Control': 'no-store' }); return res.end(operationsCSV(data)); }
    return sendJson(res, 200, data);
  }
  if (path === '/api/tasks' && req.method === 'GET') return sendJson(res, 200, { tasks: await tasks.list() });
  const taskMatch = path.match(/^\/api\/cases\/([^/]+)\/tasks(?:\/([^/]+))?$/);
  if (taskMatch) {
    const [, id, taskId] = taskMatch;
    if (req.method === 'GET' && !taskId) return sendJson(res, 200, await tasks.get(id));
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.operation === 'verify' && req.authenticatedRoles && !req.authenticatedRoles.some(role => ['admin', 'reviewer'].includes(role))) return sendJson(res, 403, { error: 'Reviewer permission is required to verify a task.' });
      if (body.operation !== 'verify' && req.authenticatedRoles && !req.authenticatedRoles.some(role => ['admin', 'operator'].includes(role))) return sendJson(res, 403, { error: 'Operator permission is required to update task execution.' });
      return sendJson(res, taskId ? 200 : 201, { task: await atomic(() => taskId ? tasks.update(id, taskId, body) : tasks.create(id, body)) });
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const handlingMatch = path.match(/^\/api\/cases\/([^/]+)\/(handling|learning)$/);
  if (handlingMatch) {
    const [, id, operation] = handlingMatch;
    if (req.method === 'GET') return sendJson(res, 200, await learning.get(id));
    if (req.method === 'POST') { const body = await readBody(req); return sendJson(res, 201, operation === 'handling' ? { incident: await learning.record(id, body) } : { run: await learning.analyze(id, body) }); }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const proposalMatch = path.match(/^\/api\/learning\/([^/]+)\/([^/]+)\/([^/]+)\/(review|apply)$/);
  if (proposalMatch && req.method === 'POST') {
    const [, id, runId, proposalId, operation] = proposalMatch, body = await readBody(req);
    return sendJson(res, 200, operation === 'review' ? { proposal: await atomic(() => learning.decide(id, runId, proposalId, body)) } : { record: await learning.apply(id, runId, proposalId, body) });
  }
  if (path === '/api/library' && req.method === 'GET') return sendJson(res, 200, { pills: await studio.library() });
  const libraryMatch = path.match(/^\/api\/library\/([^/]+)(?:\/(compare|versions)(?:\/([^/]+)\/(activate|disable|restore))?)?$/);
  if (libraryMatch) {
    const [, id, section, version, operation] = libraryMatch;
    if (req.method === 'GET' && !section) return sendJson(res, 200, await studio.versionHistory(id));
    if (req.method === 'GET' && section === 'compare') return sendJson(res, 200, await studio.compareVersions(id, url.searchParams.get('from'), url.searchParams.get('to')));
    if (req.method === 'POST' && operation) return sendJson(res, 200, await studio.manageVersion(id, version, operation, await readBody(req)));
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (path === '/api/studio' && req.method === 'GET') { const records = await studio.list(), incidents = await store.list(); return sendJson(res, 200, { records, improvements:await improvements.list(), drafts: records.filter(r => r.state !== 'published').map(r => r.content.pill), candidates: incidents.flatMap(i => i.learningCandidates || []), pendingLearningProposals: incidents.flatMap(i => (i.learningRuns || []).flatMap(r => r.proposals)).filter(p => !p.decision).length }); }
  if (path === '/api/studio' && req.method === 'POST') return sendJson(res, 201, { record: await studio.create(await readBody(req)) });
  const documentMatch = path.match(/^\/api\/studio\/([^/]+)\/documents(?:\/([^/]+)(?:\/(analyze|merge|file|draft))?)?$/);
  if (documentMatch) {
    const [, pillId, documentId, operation] = documentMatch;
    if (req.method === 'POST' && !documentId) {
      let filename;
      try { filename = decodeURIComponent(req.headers['x-filename'] || ''); } catch { return sendJson(res, 400, { error: 'Invalid filename encoding.' }); }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > uploadLimit) return sendJson(res, 413, { error: 'Files must be no larger than 10 MB.' }); chunks.push(Buffer.from(chunk)); }
      return sendJson(res, 201, { record: await studio.upload(pillId, Number(req.headers['x-revision']), filename, Buffer.concat(chunks), req.authenticatedActor) });
    }
    if (req.method === 'GET' && operation === 'file') {
      const { document, bytes } = await studio.original(pillId, documentId);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.name).replace(/'/g, '%27')}` }); return res.end(bytes);
    }
    if (req.method === 'POST' && operation === 'analyze') { const body = await readBody(req); return sendJson(res, 200, { record: await studio.analyze(pillId, documentId, body?.revision, body?.reextract === true) }); }
    if (req.method === 'POST' && operation === 'draft') { const body=await readBody(req);return sendJson(res,200,{record:await studio.saveCaptureDraft(pillId,documentId,{...body,authenticatedActor:req.authenticatedActor})}); }
    if (req.method === 'POST' && operation === 'merge') return sendJson(res, 200, { record: await studio.merge(pillId, documentId, await readBody(req)) });
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const expertMatch=path.match(/^\/api\/studio\/([^/]+)\/expert\/(message|confirm|example|feedback|validate)$/);
  if(expertMatch){
    if(req.method!=='POST')return sendJson(res,405,{error:'Method not allowed.'});
    const methods={message:'expertTurn',confirm:'expertConfirm',example:'expertTrial',feedback:'expertFeedback',validate:'expertValidate'};
    return sendJson(res,200,{record:await studio[methods[expertMatch[2]]](expertMatch[1],await readBody(req))});
  }
  const evaluationMatch = path.match(/^\/api\/studio\/([^/]+)\/evaluate$/);
  if (evaluationMatch && req.method === 'POST') return sendJson(res, 200, { record: await studio.evaluate(evaluationMatch[1], await readBody(req)) });
  const evaluationReview = path.match(/^\/api\/studio\/([^/]+)\/review-evaluation$/);
  if (evaluationReview && req.method === 'POST') return sendJson(res, 200, { record: await studio.reviewEvaluation(evaluationReview[1], await readBody(req)) });
  const studioDeleteMatch = path.match(/^\/api\/studio\/([^/]+)\/delete$/);
  if (studioDeleteMatch && req.method === 'POST') {
    if (!req.authenticatedRoles?.some(role => ['admin', 'expert'].includes(role))) return sendJson(res, 403, { error: 'Only administrators or experts can delete a draft.' });
    return sendJson(res, 200, await studio.delete(studioDeleteMatch[1], await readBody(req)));
  }
  const studioMatch = path.match(/^\/api\/studio\/([^/]+)(?:\/(save|prepare-draft|validate|submit|publish|return|fork|incorporate-learning|save-evaluations))?$/);
  if (studioMatch) {
    if (req.method === 'GET' && !studioMatch[2]) return sendJson(res, 200, { record: await studio.get(studioMatch[1]) });
    if (req.method === 'POST' && studioMatch[2]) return sendJson(res, 200, { record: await studio.change(studioMatch[1], studioMatch[2], await readBody(req)) });
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (path === '/api/review' && req.method === 'GET') return sendJson(res, 200, { cases: await review.list() });
  if (path === '/api/learning' && req.method === 'GET') return sendJson(res, 200, { runs: await learning.list(), candidates: (await store.list()).flatMap(i => i.learningCandidates || []) });
  const reviewMatch = path.match(/^\/api\/review\/([^/]+)$/);
  if (reviewMatch) {
    if (req.method === 'GET') return sendJson(res, 200, await review.get(reviewMatch[1]));
    if (req.method === 'POST') { const body = await readBody(req); return sendJson(res, 201, { review: await atomic(() => review.submit(reviewMatch[1], body)) }); }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (path === '/api/triage' && req.method === 'GET') return sendJson(res, 200, { cases: await triage.list() });
  const triageMatch = path.match(/^\/api\/triage\/([^/]+)(\/runs)?$/);
  if (triageMatch) {
    if (req.method === 'GET' && !triageMatch[2]) return sendJson(res, 200, await triage.get(triageMatch[1]));
    if (req.method === 'POST' && triageMatch[2]) {
      const body = await readBody(req);
      const run = () => triage.run(triageMatch[1], body?.revision);
      return sendJson(res, 200, { report: await (store.withLease ? store.withLease(`triage:${triageMatch[1]}`, run) : run()) });
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const chatMatch = path.match(/^\/api\/triage\/([^/]+)\/reports\/([^/]+)\/chat$/);
  if (chatMatch && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { report: await triage.chat(chatMatch[1], chatMatch[2], body?.question) });
  }
  if (path === '/api/intake/analyze' && req.method === 'POST') {
    return sendJson(res, 200, await extractionAgent(await readBody(req)));
  }
  if (path === '/api/incidents' && req.method === 'GET') {
    const incidents = (await store.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sendJson(res, 200, { incidents });
  }
  if (path === '/api/incidents' && req.method === 'POST') {
    const data = validateFields(await readBody(req));
    if (!data.description) return sendJson(res, 422, { error: 'A description is required to save a draft.' });
    const analysis = assessIntake({ ...data, title: data.title || data.description.slice(0, 100) });
    return sendJson(res, 201, { incident: await store.create({ ...analysis.fields, status: 'draft', manualFields: Object.keys(data), messages: [], conflicts: [], revision: 0 }) });
  }
  const match = path.match(/^\/api\/incidents\/([^/]+)(\/(?:finalize|messages))?$/);
  if (match) {
    const incident = (await store.list()).find(item => item.id === match[1]);
    if (!incident) return sendJson(res, 404, { error: 'Incident not found.' });
    if (req.method === 'GET' && !match[2]) return sendJson(res, 200, { incident });
    if (busyCases.has(incident.id)) return sendJson(res, 409, { error: 'This case is being updated. Try again shortly.' });
    if (req.method === 'POST' && match[2] === '/messages') {
      busyCases.add(incident.id);
      try { return sendJson(res, 200, { incident: await sendMessage(store, incident, await readBody(req), conversationAgent) }); }
      finally { busyCases.delete(incident.id); }
    }
    if ((req.method === 'PATCH' && !match[2]) || (req.method === 'POST' && match[2] === '/finalize')) {
      const body = await readBody(req);
      const data = validateFields(body);
      const conflicts = (incident.conflicts || []).filter(item => !Object.hasOwn(data, item.field));
      const analysis = assessIntake({ ...incident, ...data });
      if (!analysis.fields.description) return sendJson(res, 422, { error: 'A description is required.' });
      if (match[2] && !analysis.readyForTriage) return sendJson(res, 422, { error: 'Complete the required information before submitting.', ...analysis });
      if (match[2] && incident.messages?.some(message => message.role === 'user' && message.state !== 'complete')) return sendJson(res, 422, { error: 'Resolve pending messages before submitting.' });
      const status = match[2] ? 'ready_for_triage' : (analysis.readyForTriage ? 'draft' : 'needs_info');
      return sendJson(res, 200, { incident: await store.update(incident.id, { ...analysis.fields, status, conflicts, manualFields: [...new Set([...manualFieldsFor(incident), ...Object.keys(data)])] }, body.revision ?? (incident.revision || 0)) });
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (url.pathname.startsWith("/api/")) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
    const payload = apiRoutes[url.pathname];
    if (!payload) {
      sendJson(res, 404, { error: "API route not found" });
      return;
    }
    sendJson(res, 200, payload);
    return;
  }

  await serveStatic(req, res);
 } catch (error) {
   if (!error.status) console.error(error);
   sendJson(res, error.status || 500, { error: error.status ? error.message : 'Unable to complete the request.' });
 }
 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadLocalEnv();
  const port = process.env.PORT || 5173, host = process.env.HOST || '127.0.0.1';
  const directory = join(__dirname, 'data'), databaseFile = join(directory, 'assetops.sqlite');
  const mode = process.env.STORAGE_DRIVER || 'json';
  if (!['json', 'sqlite'].includes(mode)) throw new Error('STORAGE_DRIVER must be json or sqlite.');
  let exists = false; try { await access(databaseFile); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if ((mode === 'sqlite') !== exists) throw new Error(exists ? 'Migrated database found. Set STORAGE_DRIVER=sqlite; do not restart against stale JSON files.' : 'Run npm run admin -- migrate-sqlite with the server stopped first.');
  if (mode === 'sqlite' && (process.env.DATA_FILE || process.env.PILL_DATA_FILE)) throw new Error('SQLite mode requires the default data directory.');
  const schedule = { intervalMinutes: Number(process.env.BACKUP_INTERVAL_MINUTES || 360), keep: Number(process.env.BACKUP_KEEP || 7) };
  if (mode === 'sqlite' && (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1 || !Number.isInteger(schedule.keep) || schedule.keep < 1 || schedule.keep > 100)) throw new Error('Invalid backup schedule.');
  const releaseInstance = await registerInstance(__dirname, mode);
  let persistence = null;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    persistence = mode === 'sqlite' ? openDatabase(databaseFile) : null;
    if (persistence && !persistence.initialized()) throw new Error('Database migration is incomplete. Inspect it before starting.');
  } catch (error) { persistence?.close(); await releaseInstance(); throw error; }
  const auth = createAuth(join(directory, 'users.json'), { persistence });
  const store = persistence ? createIncidentStore(join(directory, 'incidents.json'), { persistence }) : undefined;
  const studio = persistence ? createPillStudio(join(directory, 'pills.json'), { persistence }) : undefined;
  const backups = persistence ? startBackupScheduler(persistence, directory, join(__dirname, 'backups'), schedule) : null;
  const application = secureApplication(createHandler(store, undefined, undefined, studio, undefined, createCoordinationAgent()), {
    auth, audit: createAudit(join(directory, 'audit')),
    storage: persistence ? { status: () => ({ ...persistence.status(), backups: backups.status() }), backup: () => createDatabaseBackup(persistence, directory, join(__dirname, 'backups'), { keep: Number(process.env.BACKUP_KEEP || 7) }) } : null,
    readiness: async () => { await access(directory); return { storage: 'accessible', users: (await auth.list()).length, modelConfigured: Boolean(process.env.SOCLAAS_BASE_URL && process.env.SOCLAAS_API_KEY), modelRuntime: modelFetch.status(), ocrEnabled: process.env.OCR_ENABLED === 'true', storageMode: mode, backups: backups?.status() || 'offline-manual' }; }
  });
  const server = createServer(application);
  server.requestTimeout = 120000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => { await backups?.stop(); try { persistence?.close(); } finally { await releaseInstance(); } })();
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true; application.stop();
    server.close(async () => { await application.whenIdle(); await cleanup(); process.exit(0); });
    setTimeout(() => { console.error('Shutdown timed out; lock retained for inspection.'); process.exit(1); }, 120000).unref();
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try: PORT=5174 npm run dev` : error.message);
    cleanup().catch(() => {});
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`AssetOps Intelligence Pill running at http://${host}:${port}`));
}
