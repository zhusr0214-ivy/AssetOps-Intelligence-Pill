# Security, Coordination, Document Understanding and Operations

## Initial Setup

Stop the existing server before upgrading. The production entry point now requires
authentication for all business APIs. There is no anonymous registration or default password.

```bash
npm run admin -- bootstrap admin "Administrator"
npm run dev
```

Bootstrap securely prompts for a 12-128-character password and only works with an
empty user store. For unattended provisioning, supply `ASSETOPS_ADMIN_PASSWORD`
through the deployment secret mechanism, never a committed file or CLI argument.
The CLI only supports the default `data/` layout and refuses custom `DATA_FILE` or
`PILL_DATA_FILE` configurations. Preserve the existing `.env`; this update does not
change provider credentials.

## Users and Roles

`/settings` provides sign-out and password changes for all users. Administrators
can add users, edit names/roles, disable accounts, or reset passwords. Any account
change revokes that user's active sessions; changing your own password requires a
new login. The last active administrator cannot be disabled or demoted.

| Role | Allowed mutations |
|---|---|
| operator | Intake, case facts, triage/chat, handling, learning analysis, task execution |
| expert | Drafts, source uploads/capture, evaluation, learning import and submission |
| reviewer | Case/learning approval, publication/return, version activation, task verification |
| viewer | Read-only business information |
| admin | All role capabilities and user/health/audit administration |

Roles can be combined. A two-person team can give the author `operator` + `expert`
and the other person `operator` + `reviewer`; retain an administrator for account
administration. Everyone in this single workspace can read business information.
This is not tenant isolation or per-building access control. Assignee/owner names
remain business labels, not enforced user ownership.

New audit and review records use the authenticated account, not a submitted reviewer
name. Legacy records remain explicitly unverified. Draft contributions are tracked
from creation, upload, merge, import and edits; a contributor cannot publish the
same draft, even with the admin role. Legacy drafts lack a complete historical
contributor list. This is application identity, not engineering accreditation.

Passwords use per-user salted scrypt hashes. Sessions are opaque, server-side,
expire after 8 hours. JSON sessions are revoked on restart; SQLite sessions are
shared between instances and survive restart, but backups and restoration clear them.
Cookies use HttpOnly/SameSite=Strict;
set `COOKIE_SECURE=true` behind HTTPS. Mutations require a session CSRF token, and
cross-origin mutations are rejected. Login has a per-connection-IP attempt limit.
Forwarded IP headers are not trusted; behind a proxy the shared proxy IP can hit
the limit. Configure rate limiting and HTTPS at the deployment boundary as well.

`createHandler()` is the internal, dependency-injected business handler used by
tests. Do not expose it directly. `server.js` wraps it in `secureApplication()`;
there is no runtime environment switch that disables authentication.

## Bounded Multi-Agent Coordination

An explicitly requested triage run routes to at most five applicable, active Pills.
Specialists run sequentially and each output must pass evidence/catalog checks.
For a successful multi-Pill run, the Cross-Pill Coordinator automatically examines
the validated reports and selected actions once, returning potential conflicts,
prerequisite relationships, questions and a proposed order.

The server rejects unknown action IDs and dependency cycles. Coordination failures
preserve specialist outputs but block approval. Human review must reconcile the
plan; conflicting actions cannot be accepted together and a dependent action cannot
be accepted while its proposed prerequisite is omitted. Task start requires those
prerequisite tasks to be completed with current verification evidence.

This is bounded analysis orchestration, not open-ended negotiation. A coordinator's
semantic judgement can be wrong; humans can escalate or rerun analysis, but cannot
silently bypass a flagged conflict. No agent publishes knowledge, approves work,
creates arbitrary tools, or controls equipment. Historical reports are not rewritten
or retroactively coordinated. Reports store coordinator status, prompt version,
timestamps and structured results.

## Document Understanding

Uploads support PDF, DOCX, TXT, Markdown, PNG and JPEG. Existing limits remain:
10 MB per upload, 100 PDF pages, 60,000 extracted characters and 10 sources per Pill.

Local OCR is opt-in:

```bash
OCR_ENABLED=true OCR_LANGUAGE=eng+chi_sim npm run dev
```

Install Tesseract with the selected language packs, and Poppler's `pdftoppm` for
PDF rendering. Configure `TESSERACT_PATH` and `PDFTOPPM_PATH` when they are not on
the server's PATH. `tesseract --list-langs` shows installed languages. Enabling OCR
does not download tools or send source images to an external OCR service.

Textless nonblank PDF pages use OCR (maximum five scanned pages per upload).
Blank pages are skipped with a warning. Images require valid signatures/dimensions,
with a 20-megapixel ceiling. PDF rendering is scaled to 2,000 pixels. Subprocesses
use argument arrays, 20-second command timeouts, bounded output and private temporary
directories that are cleaned afterwards. Missing tools/empty recognition fail the
upload with an actionable error; incomplete sources are not silently accepted.

OCR text retains page/image provenance and a mandatory accuracy warning. DOCX
tables preserve row/cell order as labelled text, but merged headers and relationships
still need expert checking. Embedded DOCX images are flagged, not interpreted. Mixed
PDF pages with existing text are not exhaustively OCRed; this is not general diagram,
chart or engineering-drawing interpretation. Original sources remain downloadable.

## Runtime Safeguards

- Model transport shared within each process: three concurrent calls, 1 MB response ceiling, bounded
  deadlines; three consecutive transport/429/5xx failures open a 30-second circuit.
  No hidden retry loop or duplicate automatic mutations. Existing evidence repair
  remains bounded. Failed domain workflows retain their existing retry paths.
- HTTP concurrency: at most 12 active requests; overload/shutdown returns 503 with
  Retry-After. Security headers and no-store API responses are applied.
- `/healthz` is a minimal public liveness check. Admin `/api/admin/health` reports
  process start, storage accessibility, user count, configuration presence, and model
  transport counters. Configuration presence is not a successful provider probe.
- Daily JSONL audits record request ID, account ID, route, method, status and duration,
  never request bodies/passwords/API keys. Before protected business processing,
  failure to persist the attempt stops processing. Post-action audit failures mark
  health degraded but cannot undo a committed operation. Audit files are not tamper-proof;
  archive/rotate old files externally. The UI reads the last 100 events from a bounded tail.
- JSON mode holds a project-root `.assetops-lock` directory for its lifetime.
  SQLite servers register in `.assetops-instances` and share database leases;
  administration takes the project lock and refuses any registered instances.
  Graceful shutdown drains requests and backups before releasing its registration.
  After a crash, inspect lock/marker ownership and verify the associated process is
  stopped before removing stale registrations. They are never stolen automatically.

## Offline Backup and Restore

Stop the server first. These commands acquire the same process lock:

```bash
npm run admin -- backup
npm run admin -- restore /absolute/path/to/backup --confirm
```

Backups are written to ignored `backups/<timestamp>/` and include cases, Pills,
user password hashes and source files. A manifest records sizes and SHA-256 hashes.
They exclude `.env`, transient files and audit logs; archive `data/audit/` separately
if required. Protect backup directories as sensitive data; they are not encrypted.

Restore validates every manifest path/hash before replacing data, stages the restored
tree, and retains the entire old directory as `data.before-<id>` for recovery. It
refuses symbolic links and traversal paths. Restoration clears all sessions. Restoring
a backup also restores its user accounts, role assignments and password hashes.
The SHA-256 manifest detects corruption, not a maliciously rewritten backup.

SQLite migration, same-host coordination, online snapshots and scheduled backups
are available; see [Data and Evaluation](data-and-evaluation.md). JSON mode retains
its original single-process limits. There is no cross-host cluster, durable job
queue, offsite backup, SSO/MFA, alerting service or high-availability guarantee.
These are MVP controls, not a production certification.
