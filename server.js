import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { assessIntake, validateFields } from './intake.js';
import { createIncidentStore } from './incident-store.js';
import { createIntakeAgent } from './intake-agent.js';
import { loadLocalEnv } from './config.js';
import { sendMessage, manualFieldsFor } from './conversation.js';

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = process.env.PORT || 5173;
const host = process.env.HOST || "127.0.0.1";

const modules = [
  {
    id: "dashboard",
    title: "Operations Dashboard",
    summary: "Portfolio overview, open incidents, high-risk alerts, and Pill status."
  },
  {
    id: "incidents",
    title: "Incident Workspace",
    summary: "The shared workspace where new and existing operational cases live."
  },
  {
    id: "triage",
    title: "AI Triage Workspace",
    summary: "A placeholder for Pill-powered incident interpretation and recommendation."
  },
  {
    id: "review",
    title: "Human Review Center",
    summary: "A placeholder for manager review, approval, editing, and escalation."
  },
  {
    id: "learning",
    title: "Feedback & Learning Queue",
    summary: "A placeholder for outcome capture and expert-reviewed learning items."
  },
  {
    id: "governance",
    title: "Pill Governance Library",
    summary: "A placeholder for Pill versions, owners, rules, approvals, and audit history."
  }
];

const apiRoutes = {
  "/api/modules": { modules },
  "/api/dashboard": { module: modules[0] },
  "/api/incidents": { module: modules[1] },
  "/api/triage": { module: modules[2] },
  "/api/review": { module: modules[3] },
  "/api/learning": { module: modules[4] },
  "/api/governance": { module: modules[5] }
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

export function createHandler(store = createIncidentStore(process.env.DATA_FILE || join(__dirname, 'data/incidents.json')), intakeAgent = createIntakeAgent()) {
 const busyCases = new Set();
 return async (req, res) => {
 try {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
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
