# Data Infrastructure and Evaluation

## Enable SQLite Explicitly

Use Node.js 24 or later (tested with 24.14.1). Native SQLite can print an experimental
warning. Existing deployments remain on JSON until explicitly migrated. This code
update does not edit `.env`, migrate actual records or start a server.

Stop every application process, then run from the project directory:

```bash
npm run admin -- migrate-sqlite
STORAGE_DRIVER=sqlite npm run dev
```

For subsequent starts, set `STORAGE_DRIVER=sqlite` in the existing local environment.
Do not replace the rest of `.env`. The migration accepts only the default `data/`
layout, first backs it up, imports cases/Pills/accounts into a staging database,
checks integrity and then installs `data/assetops.sqlite`. Original JSON and source
files remain unchanged. Repeated migration refuses to overwrite a database. Once
the database exists, the server rejects JSON mode to prevent stale-data writes.

JSON mode still uses its original single-process queue and lock. SQLite uses WAL,
FULL synchronization, collection revision checks and short commit transactions.
Learning import updates a Pill and its Case receipt together, or rolls both back.
Review and task transactions also check the Pill snapshot used for their decision.
Long model calls do not hold SQLite write transactions. A conflicting operation
returns HTTP 409; reload current data before retrying rather than blindly replaying.

## Same-Host Instances

Processes may use different ports in the same checkout, sharing the same local
database and upload directory. They share login sessions, login throttling and
renewable leases for triage, source analysis, evaluation and backup. Expired lease
holders cannot commit business writes. Sessions last up to eight hours and account
changes revoke access across instances. HTTP/model concurrency and circuit breakers
are still per process, not globally coordinated quotas.

Do not place the WAL database on a network filesystem. This is not multi-host HA,
tenant isolation or a distributed job queue. Entities are JSON records inside SQL
tables; writes currently replace a collection under revision checks, not a fully
normalized high-throughput SQL schema. Upload files and audit logs do not participate
in database transactions. Crash leftovers may require storage cleanup.

Servers register under `.assetops-instances`; maintenance requires all instances
stopped. After a crash, inspect the marker and process before manually removing it.
Never delete a live instance's registration to bypass a maintenance refusal.

## Backups and Restore

In SQLite mode the application checks the backup schedule every minute. The first
backup is due on the first check if no previous backup exists. Defaults:

```dotenv
BACKUP_INTERVAL_MINUTES=360
BACKUP_KEEP=7
```

The scheduler runs only while an application process is alive. Shared leases and
last-run state prevent concurrent scheduled snapshots. A failed attempt records a
sanitized status and retries when the next configured interval is due. Settings
shows database integrity and backup status; administrators can trigger an online
backup there, or via `POST /api/admin/storage/backup` with authentication and CSRF.

Snapshots include the database and exactly the immutable source documents referenced
by it, plus the existing SHA-256 manifest. They exclude active sessions, leases,
login-attempt counters, `.env` and audit logs. Old successful `sqlite-*` backups are
pruned according to retention; pre-migration backups are not automatically pruned.
A retention cleanup failure is reported without deleting the new valid backup.

The administration CLI remains offline, including its manual backup command:

```bash
npm run admin -- backup
npm run admin -- restore /absolute/path/to/backup --confirm
```

Restore checks paths, sizes and hashes before replacement and retains the old data
directory. Accounts and password hashes are restored too; all sessions are cleared.
Restoring a pre-migration JSON backup requires returning to `STORAGE_DRIVER=json`.
Never switch to the retained original JSON while the database contains newer work.
Backups are local and unencrypted. Arrange separate protected offsite copies and
restore drills; a hash manifest detects corruption, not malicious replacement.

## Repeatable Evaluation and Independent Review

Pill Studio's evaluation controls support 2-8 unique cases, 1-5 trials per case and
an 80-100% per-case pass threshold. New UI defaults suggest three trials and expert
review, but the policy takes effect only after saving it. Legacy records keep one
trial and their existing gate unless explicitly changed. Lowering the pass threshold
requires expert review. Evaluation consumes provider quota; with a baseline the
maximum is 80 agent trials, plus any bounded evidence-repair requests.

Every trial stores expected/actual structured outputs, validation errors and duration.
Candidate and baseline order alternates. Reports show per-case pass rates, output
variability, category/status coverage, aggregate and model-only statistics, and a
descriptive 95% Wilson interval. Deterministic routing checks are excluded from the
model-only summary. `modelCalls` counts agent trials, not transport repair attempts.
Any provider/validation error, unavailable baseline result or observed per-case
regression blocks passing, even under a relaxed threshold. This comparison is an
observed regression check, not a test of statistical significance.

A reviewer/admin who neither contributed to the draft nor initiated the evaluation
records scope, exclusions, relevant expertise, supporting reference and rationale.
Decisions are immutable per run. A rejected run requires a new evaluation before
another review. Acceptance cannot override failed evaluation checks. A required
expert review must be accepted before publication, and is included in the release
snapshot. Changes to content, suite, policy, active baseline, model or prompt version
invalidate the prior gate. Existing published snapshots remain historical evidence.

Role-authenticated review is not independently verified professional accreditation.
Repeated model outputs may be dependent; pooled cases are not a representative
operational sample, and output variability concerns structured decisions, not every
word of model prose. Small-suite statistics do not establish engineering safety,
generalization across all assets, or a full-domain safety proof. Legacy Pills with
evaluation disabled still follow their earlier manual publication policy.

## Verification

Run `npm test`. Tests use isolated temporary stores and mock model services. Database
coverage includes cross-collection rollback, independent-process updates, stale
leases, shared authentication, migration, snapshot restore and scheduled retention.
Evaluation coverage includes repeated failures, unreliable baselines, scoped expert
review, freshness checks and UI policy saving. No real model quality claim follows
from these software tests.
