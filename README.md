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

The backend Intake Agent connects to SOCLAAS through its OpenAI-compatible Chat Completions endpoint. `intake-agent.js` contains the prompts, provider call, validation and field merge. Users answer questions in the case conversation; each request includes saved conversation context and current fields. Extracted facts must occur in user messages. Explicit corrections can update AI-extracted fields; disagreements and changes to manually edited fields require confirmation in the summary. Priority remains user-selected. `intake.js` owns required-field checks; `conversation.js` handles saved messages, follow-up wording and retry behavior. Other sections remain scaffolds; confirming intake does not run triage.

The summary stays editable through Edit summary. Sending a message or saving a field persists changes. A failed model call retains the user message and offers Retry analysis; the same request ID cannot append the message twice. Unsent text and unsaved summary edits are not persisted across a page reload. Existing cases without conversation history remain readable and can start a conversation. Older nonempty fields are treated as manually supplied. Case details include saved conversation history.

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
