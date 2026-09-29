# AssetOps Intelligence Pill

Lightweight full-stack scaffold for the six major sections of the Asset Operations hackathon project.

## Sections

1. Operations Dashboard
2. Incident Workspace
3. AI Triage Workspace
4. Human Review Center
5. Feedback & Learning Queue
6. Pill Governance Library

## Run

```bash
npm run dev
```

Then open `http://localhost:5173`.

## Pages

- `/dashboard`
- `/incidents`
- `/triage`
- `/review`
- `/learning`
- `/governance`

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

Supported: `hvac_cooling`, or general `hvac` with an AHU asset identifier. Other categories return an explicit out-of-scope report without calling a model. An unconfirmed AHU or missing observations produces information requests. All cases must have confirmed intake, with no unresolved conflicts or messages.

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
