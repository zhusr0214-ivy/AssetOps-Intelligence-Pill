# AssetOps Intelligence Pill

Asset Operations workspace organized around cases and reusable domain knowledge.

## Sections

1. Operations Overview: case counts, operational metrics, task reminders and version outcomes.
2. Case Workspace: intake, multi-Pill analysis, human review, tasks, actual actions and outcomes.
3. Pill Studio: domain knowledge capture, reviewed drafts and governed improvement candidates.
4. Pill Library: approved capabilities only.

Pill Studio supports expert sources, structured drafts, reference/example validation,
expert review, publication, immutable version history and rollback. Case handling and
outcomes are recorded by people, not inferred from approval. The seeded demo remains unpublished until a user
completes its expert sources/examples and approves it through Studio.

## Run

```bash
npm install
npm run dev
```

Then open `http://localhost:5173`.

## Pages

- `/overview`
- `/cases`, `/cases/new`, `/cases/:id`, `/cases/:id/edit`
- `/cases/:id/triage`, `/cases/:id/review`
- `/cases/triage`, `/cases/review`: cross-case queues
- `/studio`, `/studio/improvements`
- `/library`

Existing `/dashboard`, `/incidents`, `/triage`, `/review`, `/learning` and
`/governance` links continue to resolve to the new navigation. Existing backend
incident, triage and review APIs are retained; `/api/studio` and `/api/library`
expose draft/candidate and approved-knowledge views respectively.

## API Skeleton

- `GET /api/modules`
- `GET /api/dashboard`
- `GET /api/incidents`
- `GET /api/triage`
- `GET /api/review`
- `GET /api/learning`
- `GET /api/governance`

## Incident Workspace MVP

- `/incidents`: five columns (ID, title, asset/location, priority, status), search, filters, sorting and pagination.
- `/incidents/new`: conversational intake with a synchronized case summary. The first sent message creates a persistent draft.
- `/incidents/:id`: details; `/incidents/:id/edit`: continue intake or edit.
- Priority is user-selected: low, medium, high or urgent. Intake never infers or overwrites it.
- Drafts require a description. Confirmation also requires location, priority, start time and impact. Unknown is accepted for start time and impact. Asset and readings are optional.
- Saving edits returns a case to draft/needs-information. Confirm again to mark it ready for triage.

The backend Intake Agent connects to SOCLAAS through its OpenAI-compatible Chat Completions endpoint. `intake-agent.js` contains the prompts, provider call, validation and field merge. Users answer questions in the case conversation; each request includes saved conversation context and current fields. Extracted facts must occur in user messages. Explicit corrections can update AI-extracted fields; disagreements and changes to manually edited fields require confirmation in the summary. Priority remains user-selected. `intake.js` owns required-field checks; `conversation.js` handles saved messages, follow-up wording and retry behavior. Confirming intake exposes the AI Triage entry point; analysis starts only when requested. Human review and the other unfinished sections remain scaffolds.

The summary stays editable through Edit summary. Sending a message or saving a field persists changes. A failed model call retains the user message and offers Retry analysis; the same request ID cannot append the message twice. Unsent text and unsaved summary edits are not persisted across a page reload. Existing cases without conversation history remain readable and can start a conversation. Older nonempty fields are treated as manually supplied. Case details include saved conversation history.

## AI Triage MVP

- `/triage`: confirmed cases and analysis history, with search and report-status filtering.
- `/triage/:id`: run analysis, inspect hypotheses with quoted case evidence, view catalog-based checks, Pill references, priority suggestions and operating boundaries.
- The current report also includes an `Ask about this analysis` conversation. It explains evidence and rules using the saved report context; it cannot edit the Case, change Priority or execute actions.
- `triage-agent.js`: Domain Triage prompt and SOCLAAS model adapter. It uses the existing backend environment variables.
- `triage.js`: scope matching, case snapshots, deterministic validation and report orchestration.
- `pills/ahu-cooling.json`: versioned, illustrative AHU cooling knowledge. It is explicitly **demo-only**, project-authored and not approved engineering advice. Review it with a domain expert before operational use.

Without published knowledge, the legacy demo supports `hvac_cooling`, or general `hvac` with an AHU asset identifier. Published Pills use their approved applicability criteria (see Multi-Pill Operations below). Unmatched cases return an explicit out-of-scope report without calling a model. An unconfirmed asset or missing observations produces information requests. All cases must have confirmed intake, with no unresolved conflicts or messages.

The model proposes hypotheses and selects rule/action IDs. The backend verifies that rule IDs exist, quoted evidence occurs in the case, and actions belong to cited rules. Action instructions and approval requirements come from the Pill catalog, never model-supplied text. These checks do not verify the semantic correctness of a diagnosis. No equipment commands, work orders, approval actions, human-review endpoints or autonomous execution are implemented. Priority suggestions never modify the user's priority.

Each completed attempt (including failures) is appended to `triageReports` on the incident in the existing local data file. Reports retain the input snapshot, Pill contents/version, configured model name, prompt version, timestamps and rule-check results. Changed case facts or unconfirmed intake make old reports stale. Concurrent case edits are preserved. Only one run per case is permitted per server process. Running requests survive browser navigation but are not durable jobs: restarting the server interrupts an in-flight run; retry afterward. Earlier saved reports remain intact.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/triage` | Cases with triage eligibility and latest report |
| GET | `/api/triage/:id` | Current case, reports and running state |
| POST | `/api/triage/:id/runs` | Analyze the case; body is `{ "revision": 3 }` using its current revision |
| POST | `/api/triage/:id/reports/:reportId/chat` | Ask a question about a saved, non-stale report |

Run requests return a saved `report` with status `complete`, `needs_information`, `out_of_scope` or `failed`. Model failures are recorded as failed reports rather than erasing earlier results. Precondition errors return 409. The request may take up to 30 seconds for the model. No model request is silently replaced with a mock response.

Optional live test (sends only a synthetic case and consumes provider quota):

```bash
npm run check:triage
```

If the provider still omits intermediate certificates, use the previously verified local chain for both the server and live check:

```bash
NODE_EXTRA_CA_CERTS="/Users/ivychu/Documents/Codex/soclaas-ca-chain.pem" npm run dev
NODE_EXTRA_CA_CERTS="/Users/ivychu/Documents/Codex/soclaas-ca-chain.pem" npm run check:triage
```

That path is local to this machine; other developers must obtain a verified certificate chain or wait for the provider's certificate configuration to be corrected. Normal tests are offline and use mocked provider responses. `.env` and saved case data are not changed by the tests.

## Model Configuration

Node.js 20.12 or newer is required. The server automatically reads the project-root `.env` at startup. Existing shell environment variables take precedence. Restart the server after configuration changes.

```dotenv
SOCLAAS_BASE_URL=https://soclaas-api.comp.nus.edu.sg/v1
SOCLAAS_API_KEY=your-key-here
SOCLAAS_MODEL=default
```

Use a plain URL, not Markdown link syntax. `.env` is ignored by Git and is outside the public directory. `.env.example` contains no credentials. Never place the key in frontend code.

The legacy single-input analysis endpoint uses local rules when both key and base URL are absent. Conversational intake requires model configuration; editing and saving summary fields remains available without a model. Partial configuration, model errors, invalid responses and timeouts return an explicit error. Analysis has a 30-second timeout. The model proposes structured field changes; the server constructs follow-up questions and controls readiness and submission.

```bash
npm run check:llm
```

This optional live check lists models and submits one synthetic incident to the configured provider (may consume API quota). It does not send saved incidents, print secrets, start the web server or open a browser. Normal `npm test` uses mocked model responses and makes no external requests.

Request format reference: [OpenAI Chat Completions documentation](https://platform.openai.com/docs/api-reference/chat/create). Provider compatibility is checked against SOCLAAS directly.

The live check accepts both the general `hvac` and specific `hvac_cooling` classifications for its synthetic cooling incident. A TLS certificate error is distinct from an invalid API key: verify the provider certificate chain or use an approved organizational CA. Do not disable TLS verification.

## Contextual Follow-ups

Intake distinguishes cooling performance, local thermal comfort, water leaks, electrical distribution and lift faults. It accumulates observations, completed actions and affected scope across turns; conflicting evidence remains subject to human confirmation. Short readings such as `50%, 120 m3/h` and scope replies such as `One room` are recognized when answering the matching question, without treating unrelated replies as diagnostic evidence.

## Incident API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/incidents` | List incidents |
| POST | `/api/incidents` | Create draft |
| GET | `/api/incidents/:id` | Read case |
| PATCH | `/api/incidents/:id` | Save edited intake |
| POST | `/api/incidents/:id/messages` | Send a message or retry its analysis |
| POST | `/api/intake/analyze` | Extract fields and identify missing information |
| POST | `/api/incidents/:id/finalize` | Validate and mark ready for triage |

Request bodies are flat JSON objects with `title`, `description`, `location`, `asset`, `category`, `occurredAt`, `impact`, `observations`, `actionsTaken`, `priority`. Categories: `hvac`, `water_leak`, `energy`, `other`. Status, ID and timestamps are server-owned.

The messages endpoint accepts `{ "content": "...", "requestId": "client-generated-uuid" }`; retry with `{ "requestId": "same-id", "retry": true }`. Responses return the incident including `messages`, `manualFields`, `conflicts` and `revision`. PATCH accepts only the changed fields plus the current `revision`; this marks fields as manually supplied and resolves conflicts for those fields. Finalize accepts the current `revision` and checks missing fields, unresolved conflicts and incomplete messages. Concurrent or stale edits return 409. Conversations are limited to 50 user turns and 6,000 characters per message.

## Storage and Checks

Incidents persist to `data/incidents.json`, created on first save using serialized atomic writes. Set `DATA_FILE` to use another file. Use one server process per data file. This local demo has no authentication or multi-process database.

```bash
npm test
```

Tests cover extraction, priority preservation, validation, API lifecycle, persistence and concurrent writes without starting a browser or binding a port.

If port 5173 is occupied:

```bash
PORT=5174 npm run dev
```
# Human Review MVP

Human Review Center is available at `/review`, with case detail at `/review/:id`.
The latest triage report is checked against the current case fingerprint, Pill
definition, scope, evidence references, missing information and action catalog.
The review package is generated on read and rechecked on submit, then saved with
the decision. Existing reports can be reviewed without a data migration.

Reviewers record their assessment separately from the action plan, accept or omit
catalog actions, and approve, approve with changes, request information, request
re-analysis, refer to a specialist or reject. Omitted actions need reasons.
Approval requires verified facts, supported analysis, an owner and a current
complete report without governance blockers. User priority is retained.
Free-text revised or additional actions are proposals pending expert validation;
they never become approved catalog actions through the review form.

Information requests return the incident to intake with the review questions.
New facts require confirmation and a new triage report before another review.
Decisions use revision checks to reject concurrent or duplicate submissions.
History preserves report/Pill versions, governance findings and decision rationale.
Each review also creates a pending feedback candidate visible in `/learning`.
Candidates remain pending until an expert incorporates and validates their knowledge
in a Studio draft. Candidate resolution status and equipment execution are not implemented.

Endpoints: `GET /api/review`, `GET /api/review/:id`,
`POST /api/review/:id`, `GET /api/learning`.

This local MVP records a self-declared reviewer name, not an authenticated identity.
It does not enforce reviewer roles. Current demo knowledge supports advisory plan
review only; no equipment commands or work orders are issued. Rule checks validate
references and known patterns, not general engineering correctness or every possible
semantic contradiction. Experts must assess source quality and operating context.

## Pill Studio MVP

Open `/studio` to create a domain capability or edit the seeded AHU demo. Add expert
sources (contributor, reference and captured experience), decision rules, an action
catalog, boundaries, escalation conditions and example cases. Save, validate, submit
for expert review, then return for changes or approve and publish. Unsaved edits cannot
be validated or published. Every saved edit invalidates prior validation.

Structural validation checks required content, unique IDs, reciprocal rule/action links
and example references. The separate Model evaluation panel runs authored test cases
through the configured Triage model. Neither establishes engineering correctness.
The reviewer must explicitly confirm the knowledge before publication.
Reviewer identity is self-declared; authentication/role enforcement remains future work.

Published snapshots retain sources, examples, validation and approval notes. Editing
requires a new draft; releases receive monotonically increasing versions per Pill.
Publication activates that version for its Pill, replacing only that Pill's previously
active release. Multiple Pills may be active together. Drafts never affect runtime knowledge.
With no publication the application continues to use its original demo Pill. Library
shows published versions and marks the active one. Historical reports retain their
original Pill snapshot; review of a report with a superseded definition is blocked.
Automatic equipment execution remains disabled for published knowledge as well.

Storage: `data/pills.json` (ignored by Git), configurable with `PILL_DATA_FILE`.
Run only one server process per data file. Writes are serialized and atomic, with
revision checks for conflicting edits and duplicate publication requests.

API: `GET/POST /api/studio`, `GET /api/studio/:id`, and
`POST /api/studio/:id/{save,validate,submit,publish,return,fork}`.
Published versions: `GET /api/library`.

## Knowledge Capture Agent

Studio now starts with **Upload documents** (`/studio/new/upload`) or **Capture
expert experience** (`/studio/new/expert`). Both create a draft and a retained source.
Existing editable drafts also accept additional uploads. Click **Analyze with Knowledge
Capture Agent** to send extracted text to the configured SOCLAAS model. Upload/parsing
alone does not call the model. The same server-side credentials used by Triage apply.

PDF, DOCX, UTF-8 TXT and Markdown are supported. Limits: 10 MB per file, 100 PDF pages,
60,000 extracted characters and 10 source files per Pill. Larger sources must be split.
The parser runs in a worker with a 30-second timeout and a bounded JavaScript heap.
PDF references retain page numbers; DOCX/text references retain paragraph numbers.
Scanned PDFs require OCR before upload; no OCR or faithful table-layout extraction is
implemented. Empty pages and DOCX parsing limitations are surfaced for source review.

The agent extracts scope, evidence, rules, actions, boundaries, escalation and examples,
plus missing information and conflicts. Large sources are analyzed in bounded sections;
cross-section consistency remains an expert review task. Every candidate must cite
exact source text; invalid citations reject the extraction. Exact matching checks
provenance, not semantic correctness. Model calls treat uploaded content as untrusted
source data and cannot publish or execute actions. No silent rules fallback is used.

Review candidates, edit their wording, select the items to keep, and confirm the source
review. Unselected items are recorded as rejected. Merging appends to the draft and
invalidates its previous validation; existing knowledge is not overwritten. Linked
actions/examples require their selected rule candidates. Action owners and example
rationales absent from source remain blank for expert completion, and imported actions
default to requiring approval. The draft still requires validation and publication.

Source files are retained under `data/pills.json.uploads/` (or next to `PILL_DATA_FILE`),
and extracted blocks, SHA-256 hashes, model/prompt versions, citations and candidate
decisions are stored with the Pill. Original files can be downloaded from the editor.
Published versions snapshot capture decisions alongside their knowledge sources.
Failed extractions can retry; successful or reviewed extractions cannot be overwritten.
Revision checks prevent stale or duplicate merges. After a server restart an interrupted
extraction can be retried. Reviewer identity remains self-declared in this local MVP.

API: binary `POST /api/studio/:id/documents` with `X-Filename` (URI-encoded) and
`X-Revision`; `POST /api/studio/:id/documents/:documentId/analyze`;
`POST /api/studio/:id/documents/:documentId/merge`;
`GET /api/studio/:id/documents/:documentId/file`.

Run `npm run check:knowledge` for a live synthetic-source connectivity check without
changing Pill data. `npm test` covers parsers, citation validation, merging, retry,
concurrency and DOM interactions without starting a browser. Node 22.13+ is required
by the PDF parser; this project is tested on Node 24.

Dependency audit: Mammoth's CLI dependency chain (`argparse` / `sprintf-js`) currently
has a moderate denial-of-service advisory with no patched upstream release available.
The application calls Mammoth's raw-text library API, not its CLI or format-string
parser. Parser work remains bounded by the worker timeout; recheck this dependency
before a production deployment.

## Governed Learning and Operational Records

Each case now has **Handling & Outcome** at `/cases/:id/handling`. Record actual
actions (who, when, rationale and deviations), then outcomes (verification evidence,
remaining issues and resolved/unresolved status). Records are append-only; corrections
reference an earlier record without removing it. This is a record of human activity,
not an equipment command, work order or execution authorization. User priority and
the original intake/triage history remain unchanged. Recording a new action reopens
the handling status without changing intake readiness.

**Analyze case learning** sends a fixed evidence snapshot to the existing server-side
SOCLAAS configuration. No additional key is required and `.env` is not changed. The
Learning & Improvement Agent separates input gaps, agent errors, Pill gaps/errors,
execution deviations and asset-specific findings. It can propose no change, more
evidence, agent follow-up, a Pill update or a new Pill. It cannot publish or execute.
The snapshot retains original Pill version, AI analysis, expert review and operational
records, plus model/prompt metadata. At most five proposals per run and 65,000 input
characters are accepted; oversized evidence is rejected rather than silently omitted.
Provider errors allow retry and do not create partial proposals. Concurrent case edits
reject the result, requiring a new analysis of the latest records.

Knowledge proposals require exact citations to the current action and verified outcome,
applicability/limitations and at least two proposed validation scenarios. Superseded
records cannot be cited as current evidence. Quote validation verifies provenance, not
engineering correctness or causal proof. Verification is explicitly self-declared by
the human author, not independently measured by the application.

Review proposals in **Pill Studio > Improvement queue**. Accept with reviewed text,
reject, or request more information. Decisions are retained; updated evidence requires
a new analysis. An accepted knowledge proposal can be imported once into a draft as
an expert source and tracked implementation task. It does NOT automatically patch rules.
The expert edits rules/actions/examples in Studio, saves, then confirms incorporation
with rule references and rationale. Draft edits invalidate unreleased incorporation
confirmations. Existing structural validation, expert approval and publication still
apply. Releases snapshot the learning evidence, decisions and incorporation records.
Import receipts live atomically in the Pill store; retries cannot duplicate sources.
Importing an update requires the original Pill release version and an editable draft.

Cases with no applicable Pill can still record expert handling and outcomes. A Triage
result with adequate facts but no applicable rule is now `knowledge_gap`, not an invented
request for more observations. Coverage distinguishes no Pill, no matched rule, missing
facts, partial evidence and matched rules; matched rules are not a full-coverage guarantee.
Reviewed non-AHU experience can create a scoped draft; it must still pass source,
rule, example and expert review requirements before publication. Agent/process proposals
remain review records, not automatic code changes. Multi-Pill learning requires selecting
the original specialist Pill to update; the runtime bundle is never itself published.

APIs: `GET/POST /api/cases/:id/handling`, `POST /api/cases/:id/learning`,
`GET /api/learning`, `POST /api/learning/:caseId/:runId/:proposalId/{review,apply}`,
and `POST /api/studio/:id/incorporate-learning`. Mutations require revisions except
idempotent import (which checks the target draft revision on first application).
The local MVP has self-declared reviewers, not authentication or role-based access control.
Tests use temporary stores and mocked providers; they do not alter saved cases or call
the live model. Run `npm test` for backend and DOM interaction coverage.

## Pill Library Version Management

`/library` groups published versions by Pill, showing the active version separately
from the latest release. Search includes historical content. `/library/:id` shows
the current active version for that Pill (or its latest release if inactive), complete
release history, immutable knowledge/source/example snapshots and approval provenance.
Use `/library/:id/versions/:version` for a specific release and `/library/:id/compare`
to compare two versions. Rules/actions align by ID; field changes show before/after
values. Safety lists, sources, examples and capture/learning provenance are compared
as complete values. Reordering rule/action records alone is not a content change.

Published snapshots, active flags, disabled flags and audit events persist in the
existing `PILL_DATA_FILE` (default `data/pills.json`) with atomic file replacement.
New releases include a SHA-256 content checksum excluding mutable activation metadata;
a stored checksum mismatch blocks reactivation. Legacy releases remain compatible,
with a calculated checksum when no saved checksum exists. Checksums detect accidental
changes, not malicious tampering by someone with write access to the storage file.
Use one application process per data file; multi-process locking is not implemented.

Version management requires an operator, reason, confirmation, the Pill revision and
a global library state token. A concurrent publication, draft update or version switch
invalidates old requests. **Activate this version / roll back** switches this Pill's
active version to an available published release without switching other Pills. It does not create a new
version, delete later releases, alter drafts or rewrite existing Case reports. New
Triage runs use the selected release; review checks use the current active version.
Publishing after rollback still allocates the next version, never reuses an old number.

Only inactive versions can be disabled. Disabled releases remain inspectable and
comparable but cannot activate. Restore makes a disabled release available without
activating it; activation is a separate confirmed operation. No permanent deletion or
automatic rollback is provided. Publication and activation history includes target,
previous active release, timestamp, operator and reason. Reviewers/operators are still
self-declared: authentication and role-based authorization remain outside this local MVP.

APIs: `GET /api/library`, `GET /api/library/:id`,
`GET /api/library/:id/compare?from=1.0.0&to=2.0.0`, and
`POST /api/library/:id/versions/:version/{activate,disable,restore}`.
Mutation body: `{revision, libraryToken, reviewer, notes, confirmed: true}`.
Backend and DOM tests cover persistence/restart, legacy files, draft preservation,
concurrent switches, source comparisons, error retries and Triage behavior after rollback.

## Multi-Pill Operations

In a Studio draft, set the domain and applicability: incident categories are mandatory
for non-legacy Pills; asset prefixes and issue keywords are optional. Each populated
dimension must match, with OR within each list. Matching is deterministic and case-insensitive
for prefixes/keywords; keywords are literal substring matches, not semantic diagnosis.
Save before document extraction so the Knowledge Capture Agent receives the selected domain.
Never use broad keyword matches as a safety or engineering validation substitute.

Each Pill has one active, non-disabled release. Legacy published snapshots retain their
existing active/inactive flags: upgrading does not silently reactivate old knowledge.
At runtime up to five matching Pills analyze the same immutable case independently.
Rule/action IDs are namespaced in the combined report; original snapshots, routing
reasons and specialist results remain available. More than five matches requires
narrowing the approved criteria rather than silently dropping capabilities.

Actions can declare a shared `coordinationKey` and proposed `coordinationValue`.
Different values for the same key are flagged as conflicts. This is not a semantic
conflict detector. All multi-Pill approvals require a named owner, reconciliation
notes and explicit confirmation; incompatible accepted actions are rejected. A failed
specialist blocks approval of the combined plan and can be referred to a specialist.
Changed case facts, selected Pills or versions require renewed analysis/review.

## Tasks and Operational Metrics

Open the **Tasks** tab on a case or `/cases/tasks` for the cross-case queue.
Dispatch accepted actions from a current, human-reviewed published plan, or assign
a specialist escalation. Demo advisory approval cannot dispatch operational action tasks.
Assignments include an owner and due date. Statuses are assigned, in progress, blocked,
awaiting verification, completed and cancelled. Starting requires current authorization.
Submitting requires a current actual-action record; completion requires a verified
outcome after that action. Corrections invalidate referenced evidence for verification.
Updates use case revisions, persist event history and retain evidence snapshots.
Completion records task verification, not necessarily case resolution.

Reminders are derived in-app on page load (overdue, due soon within 24 hours, blocked,
awaiting verification). No scheduled email or push service is installed. External
work orders support a manually linked HTTPS URL and ID only: no third-party creation,
synchronization or equipment commands. Operators/assignees are self-declared text,
not authenticated directory users; this remains a single-process MVP.

Overview measures distinct-case Pill reuse, latest-review correction rate, latest
knowledge-gap rate and verified median resolution time. Each metric exposes its
denominator/definition, and empty samples show No data. Per-version comparisons show
case counts, specialist completion rates, human correction and observed resolution.
Multi-Pill outcomes and review corrections are shared observations, not causal
attribution. Sample sizes and case differences prevent claiming measured improvement
from a simple before/after version comparison. No illustrative impact is reported as fact.

APIs: `GET /api/operations`, `GET /api/tasks`, `GET/POST /api/cases/:id/tasks`,
`POST /api/cases/:id/tasks/:taskId`. Task updates require revision, actor, operation
and notes, plus operation-specific evidence/confirmation. Automated tests use synthetic
knowledge and mocked agents, not a live provider or validated engineering SOP.

## Pill Model Evaluation

Studio includes a separate editable test suite with 2-8 cases, including a supported
case and a negative or missing-information case. Enter actual test facts and exact
expected status, rule IDs, action IDs and missing fields. Expected answers are never
sent to the model. Running evaluation uses the configured provider and consumes quota;
it does not create operational Cases or execute actions. Nonmatching scope and missing
asset/observations are handled deterministically, just as in Triage.

Each suite is replayed against the saved candidate and the currently active release.
The normal evidence/catalog validator runs on model outputs. A provider or validation
failure is a failed case, never a mock success. The report retains both results, exact
checks, regressions, model/prompt identity, candidate content and baseline snapshot.
One run per Pill may run at a time; history persists across restarts. Edited content,
test suites or changed active baselines invalidate prior results without deleting them.

Saving a suite enables its mandatory release gate; the suite cannot then be emptied
to bypass the gate. Every candidate case must pass before publication, in addition to
structural validation, learning incorporation and explicit expert review. Suite and
draft edits can be saved together. Existing Pills without an enabled suite retain their
legacy publication flow and are explicitly labeled not evaluated; this is not a blanket
mandatory gate across all legacy content. Released evaluation evidence is included in
the version checksum and can be inspected in Library.

This is one observed model run per case/version, not a statistical reliability estimate,
semantic safety proof or independent expert certification. Baseline/candidate comparison
uses the same current suite; changes to expected answers still need expert scrutiny.

APIs: `POST /api/studio/:id/save-evaluations` with `{revision, suite}` (optional
`content` for simultaneous draft edits), and `POST /api/studio/:id/evaluate` with
`{revision}`. `GET /api/studio/:id` includes gate state, running status and run history.

## Operational Follow-up and Reporting

Tasks accept audited progress updates from 0-99 percent while in progress or blocked.
Only evidence-backed verification sets completion to 100 percent. Open tasks may be
escalated to a named owner, then explicitly acknowledged. This is an in-app,
human-initiated escalation, not a scheduled notification or authenticated sign-off.
The original assignee remains responsible unless the task is separately reassigned.
Cancelled tasks may be reopened, but starting again still requires current approval.
Completed tasks retain historical completion and evidence snapshots; corrected or
missing referenced evidence generates an evidence-corrected reminder for review and
reopening. Unacknowledged escalations also appear in reminders.

Overview supports inclusive UTC creation-date ranges, asset substring and category
filters. Outcome metrics, monthly cohorts and reminders use the selected cases.
Monthly cohorts show current outcomes for cases created in that month; they are not
historical dashboard snapshots. CSV exports use the applied filters and include
definitions, sample sizes, version metrics and gap cases. Cells escape quotes and
neutralize spreadsheet formula prefixes. Export endpoint:
`GET /api/operations/export?from=YYYY-MM-DD&to=YYYY-MM-DD&asset=...&category=...`.

Learning knowledge proposals recheck their source facts, latest report, action,
verified outcome and cited evidence before acceptance or draft import. Corrections
or new handling invalidate old proposals for these operations while retaining history.
The improvement queue marks stale evidence. Updated evidence must be analyzed again;
ordinary task/revision changes alone do not invalidate uncited operational evidence.
