import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assessIntake, validateFields } from './intake.js';
import { createIncidentStore } from './incident-store.js';
import { createIntakeAgent } from './intake-agent.js';
import { loadLocalEnv } from './config.js';
import { sendMessage, manualFieldsFor } from './conversation.js';
import { createTriageService, ahuPill } from './triage.js';
import { createReviewService } from './review.js';
import { createPillStudio } from './pill-studio.js';
import { uploadLimit } from './document-parser.js';
import { createLearningService } from './learning.js';

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = process.env.PORT || 5173;
const host = process.env.HOST || "127.0.0.1";

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
    if (size > 100000) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    body += chunk;
  }
  try { return JSON.parse(body); }
  catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}

export function createHandler(store = createIncidentStore(process.env.DATA_FILE || join(__dirname, 'data/incidents.json')), intakeAgent = createIntakeAgent(), triageAgent, studio = createPillStudio(process.env.PILL_DATA_FILE || join(__dirname, 'data/pills.json')), learningAgent) {
 const busyCases = new Set();
 const triage = createTriageService(store, triageAgent, undefined, undefined, () => studio.active());
 const review = createReviewService(store, () => studio.active());
 const learning = createLearningService(store, studio, learningAgent);
 return async (req, res) => {
 try {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
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
    return sendJson(res, 200, operation === 'review' ? { proposal: await learning.decide(id, runId, proposalId, body) } : { record: await learning.apply(id, runId, proposalId, body) });
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
  if (path === '/api/studio' && req.method === 'GET') { const records = await studio.list(), incidents = await store.list(); return sendJson(res, 200, { records, drafts: records.filter(r => r.state !== 'published').map(r => r.content.pill), candidates: incidents.flatMap(i => i.learningCandidates || []), pendingLearningProposals: incidents.flatMap(i => (i.learningRuns || []).flatMap(r => r.proposals)).filter(p => !p.decision).length }); }
  if (path === '/api/studio' && req.method === 'POST') return sendJson(res, 201, { record: await studio.create(await readBody(req)) });
  const documentMatch = path.match(/^\/api\/studio\/([^/]+)\/documents(?:\/([^/]+)(?:\/(analyze|merge|file))?)?$/);
  if (documentMatch) {
    const [, pillId, documentId, operation] = documentMatch;
    if (req.method === 'POST' && !documentId) {
      let filename;
      try { filename = decodeURIComponent(req.headers['x-filename'] || ''); } catch { return sendJson(res, 400, { error: 'Invalid filename encoding.' }); }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > uploadLimit) return sendJson(res, 413, { error: 'Files must be no larger than 10 MB.' }); chunks.push(Buffer.from(chunk)); }
      return sendJson(res, 201, { record: await studio.upload(pillId, Number(req.headers['x-revision']), filename, Buffer.concat(chunks)) });
    }
    if (req.method === 'GET' && operation === 'file') {
      const { document, bytes } = await studio.original(pillId, documentId);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.name).replace(/'/g, '%27')}` }); return res.end(bytes);
    }
    if (req.method === 'POST' && operation === 'analyze') { const body = await readBody(req); return sendJson(res, 200, { record: await studio.analyze(pillId, documentId, body?.revision) }); }
    if (req.method === 'POST' && operation === 'merge') return sendJson(res, 200, { record: await studio.merge(pillId, documentId, await readBody(req)) });
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const studioMatch = path.match(/^\/api\/studio\/([^/]+)(?:\/(save|validate|submit|publish|return|fork|incorporate-learning))?$/);
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
    if (req.method === 'POST') return sendJson(res, 201, { review: await review.submit(reviewMatch[1], await readBody(req)) });
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (path === '/api/triage' && req.method === 'GET') return sendJson(res, 200, { cases: await triage.list() });
  const triageMatch = path.match(/^\/api\/triage\/([^/]+)(\/runs)?$/);
  if (triageMatch) {
    if (req.method === 'GET' && !triageMatch[2]) return sendJson(res, 200, await triage.get(triageMatch[1]));
    if (req.method === 'POST' && triageMatch[2]) {
      const body = await readBody(req);
      return sendJson(res, 200, { report: await triage.run(triageMatch[1], body?.revision) });
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const chatMatch = path.match(/^\/api\/triage\/([^/]+)\/reports\/([^/]+)\/chat$/);
  if (chatMatch && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { report: await triage.chat(chatMatch[1], chatMatch[2], body?.question) });
  }
  if (path === '/api/intake/analyze' && req.method === 'POST') {
    return sendJson(res, 200, await intakeAgent(await readBody(req)));
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
      try { return sendJson(res, 200, { incident: await sendMessage(store, incident, await readBody(req), intakeAgent) }); }
      finally { busyCases.delete(incident.id); }
    }
    if ((req.method === 'PATCH' && !match[2]) || (req.method === 'POST' && match[2] === '/finalize')) {
      const body = await readBody(req);
      const data = validateFields(body);
      const conflicts = (incident.conflicts || []).filter(item => !Object.hasOwn(data, item.field));
      const analysis = assessIntake({ ...incident, ...data });
      if (!analysis.fields.description) return sendJson(res, 422, { error: 'A description is required.' });
      if (match[2] && !analysis.readyForTriage) return sendJson(res, 422, { error: 'Complete the required information before submitting.', ...analysis });
      if (match[2] && (conflicts.length || incident.messages?.some(message => message.role === 'user' && message.state !== 'complete'))) return sendJson(res, 422, { error: 'Resolve pending messages and conflicting information before submitting.' });
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
  const server = createServer(createHandler());
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try: PORT=5174 npm run dev` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`AssetOps Intelligence Pill running at http://${host}:${port}`));
}
