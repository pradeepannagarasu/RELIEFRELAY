# ReliefRelay

ReliefRelay helps aid organisations investigate and resolve failed, returned, held, blocked and unclaimed payments, with human-authorised recovery actions and a complete payment audit trail.

> Do not just send emergency aid. Resolve the payment problems that prevent aid from reaching its intended recipient.

Built for the PayPal AI Hackathon 2026. All data in this repository is synthetic. No real organisation, programme or person is represented, and no real money is used.

- **Live Judge Demo:** <https://reliefrelay.nostologia.com> (synthetic data; payouts go to a local PayPal stub, see [Public Judge Demo](#public-judge-demo-cloudflare))
- **Source:** <https://github.com/pradeepannagarasu/RELIEFRELAY>
- **Genuine PayPal Sandbox payout:** one human-approved GBP 12.50 recovery payout completed in PayPal Sandbox on 12 November 2026 (see [What has and has not been tested against PayPal Sandbox](#what-has-and-has-not-been-tested-against-paypal-sandbox))

## Status

The project is being built in phases. **Phase 1 (application shell and Overview), Phase 2 (SQLite persistence, CSV import, reconciliation and payment cases), Phase 3 (AI-assisted investigation) and Phase 4 (human-approved PayPal Sandbox recovery actions) are complete.** Phases 5 and 6 have not been started.

| Area | Status |
| --- | --- |
| Design tokens, typography, accessible component primitives | Complete |
| Responsive app shell (desktop sidebar, mobile drawer), skip link, focus management | Complete |
| Overview page computed from payment records on the server | Complete |
| SQLite persistence with versioned migrations, constraints and append-only triggers | Complete |
| Tamper-evident audit log (SHA-256 hash chain, verification command) | Complete |
| CSV import: upload, column mapping, validation, preview, explicit commit, discard | Complete |
| Deterministic reconciliation findings and automatic case opening | Complete |
| Payment cases list (filters, search, sort, pagination) and case detail | Complete |
| Case actions: assign to me (start investigating), permanent notes | Complete |
| Demo authentication with server-side role checks | Complete (fixed demo identity; a development-only role demonstration switcher, not a sign-in) |
| AI-assisted investigation on the case page (OpenAI Responses API, strict schema, independent validation) | Complete. Requires `OPENAI_API_KEY`; run against the live OpenAI API on the public Judge Demo (see [Live verification](#live-verification)) |
| Public Judge Demo on Cloudflare (synthetic data, local PayPal stub) | Deployed at <https://reliefrelay.nostologia.com> (see [Public Judge Demo](#public-judge-demo-cloudflare)) |
| Payment actions on the case page: reissue to the original receiver, cancel an unclaimed recovery payout | Complete (PayPal Sandbox only; proposed by one person, approved by another) |
| Approval centre, proposal review with typed confirmation, audit history page, settings | Complete |
| PayPal Payouts Sandbox client, status checks, polling, webhook listener with signature verification | Complete, tested against a local PayPal stub. **One genuine PayPal Sandbox payout sent and completed** (item and batch `SUCCESS`); genuine webhooks not yet verified (see [What has and has not been tested against PayPal Sandbox](#what-has-and-has-not-been-tested-against-paypal-sandbox)) |
| End-to-end tests and demo preparation | Not built (phase 6) |

## Running locally

Requirements: **Node.js 22.12 or later** (Node 24 recommended) and npm. Ports 4000 and 5173 must be free.

```bash
npm install --ignore-scripts
cp .env.example .env    # optional; defaults run in simulation mode (on Windows: copy .env.example .env)
npm run dev             # API on :4000, web on http://localhost:5173
```

**Why `--ignore-scripts`.** The database driver, `better-sqlite3`, is a native SQLite module. Its npm package already contains ready-made binaries for Windows, macOS and Linux (x64 and arm64), which it loads at runtime. When installing from `package-lock.json`, npm still tries to compile it from source with `node-gyp`. That needs Python and a C++ toolchain (on Windows, Visual Studio with "Desktop development with C++"), and without them the install fails. `--ignore-scripts` skips that unnecessary compile step. The only other packages with install scripts, `esbuild` and (on macOS) `fsevents`, also ship their binaries and work without them. This was verified on Windows with Node 24 from a clean clone; macOS and Linux were not tested: install, type check, tests, build and startup all succeed. A plain `npm install` also works where a C++ toolchain is present. If startup reports that `better-sqlite3` could not be loaded, your platform has no bundled binary: install the toolchain and run `npm rebuild better-sqlite3`.

On first start in development, the server creates `server/data/reliefrelay.db`, applies migrations and seeds the synthetic demo organisation. **Seeding happens only when the database is empty and `NODE_ENV=development`.** In any other environment an empty database is left empty and a warning is logged.

| Command | Purpose |
| --- | --- |
| `npm run dev` | API (tsx watch) and Vite dev server together |
| `npm run typecheck` | Strict TypeScript checks for shared, server, web and tooling configs |
| `npm test` | Unit, database and API tests (Vitest), each on a temporary SQLite database |
| `npm run build` | Type check, then production build of the web app into `dist/web` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Seed the synthetic demo data; refuses if the database is not empty |
| `npm run db:reset` | Delete the database file and its WAL/SHM files, then migrate and seed. Refused when `NODE_ENV=production` |
| `npm run db:verify-audit [seq:hash]` | Verify the audit hash chain and print the chain head; pass a previously recorded head to detect truncation |
| `npm run ai:smoke [-- --show]` | Optional. Sends three **synthetic** investigations to OpenAI using `OPENAI_API_KEY` and reports outcomes, tokens, latency and estimated cost. Never runs during tests, builds or startup |
| `npm run paypal:receivers -- list \| add <email> --label "…" \| deactivate <email> --reason "…"` | Manage the server-side allowlist of PayPal Sandbox receivers (exact email addresses only) |
| `npm run paypal:sandbox-check [-- --negative]` | Checks the Sandbox credentials, the Payouts scope and a read; `--negative` cancels PayPal's documented mock item IDs. Moves no money |
| `npm run sandbox:demo-scenario -- --receiver <email> [--amount 12.50] [--currency GBP]` | Development only. Adds a clearly labelled **simulated** returned payment and case for a Sandbox recovery demonstration |
| `npm run demo:local-stub` | Development only. Demonstrates the payment actions against a **local PayPal stub**, without a PayPal account. Nothing is sent to PayPal (see [Local payment-flow demonstration](#local-payment-flow-demonstration-no-paypal-account-needed)) |
| `npm run paypal:webhook-fixture -- <capture file>` | Turns a captured, verified PayPal Sandbox webhook delivery into the genuine verification test fixture |

Stop `npm run dev` before `db:reset`: Windows will not delete a database file that the running server holds open.

> **Location note.** Install on a local disk. Cloud-synced folders such as Google Drive can reject npm's writes (`EBADF`/`EPERM`) and do not support the junctions and symlinks npm uses.

## Public Judge Demo (Cloudflare)

The public Judge Demo runs at **<https://reliefrelay.nostologia.com>**. It uses synthetic data only, and payouts go to a **local PayPal stub inside the server**: nothing is sent to PayPal, not even PayPal Sandbox, and every simulated result is labelled "Local PayPal stub". All visitors share the same demo data.

- **Lena Hartmann (operator)** is the default identity: investigate a case, optionally run the AI investigation, and propose a recovery.
- **Samuel Mensah (approver)** reviews the proposal in the Approval centre and types the exact confirmation. The proposer can never approve their own proposal.
- **Tomas Novak (viewer)** can look but not change anything. The administrator role is not available.

Identities are chosen with the role demo switcher in the top bar. The server signs them, but this is a demonstration, not authentication.

### How it runs on the Cloudflare free plan

| Part | How |
| --- | --- |
| Web app | Workers Static Assets serve `dist/web`. Security headers (including HSTS) come from `dist/web/_headers`, and plain HTTP is redirected to HTTPS |
| API | One SQLite-backed Durable Object runs the same Express app (`createApp`) through `nodejs_compat`. It first applies the public gateway rules: allowed methods, body limits, refused administrator paths, and rate limits stored in SQLite so they survive restarts and redeploys |
| Database | The Durable Object's SQLite storage, with the same migrations, append-only triggers and audit hash chain. Custom SQL functions are not available there, so the chain hash is computed in application code in the same transaction |
| Payouts | The local PayPal stub runs in the same process, and the PayPal client used there can reach nothing else |
| Status polling | A Cron Trigger every minute, plus a 15-second Durable Object alarm while simulated payouts are still open |
| Secrets | `JUDGE_IDENTITY_SECRET` (signs the identity cookie) and `OPENAI_API_KEY` (optional; AI is off without it), both Worker secrets |

The code is in `cloud/`. The private ReliefRelay application, its database and the genuine PayPal Sandbox integration are not part of this deployment and cannot be reached from it.

### Deploying your own copy

You need a Cloudflare account (the free plan is enough). First edit `cloud/wrangler.jsonc`: change `name`, and remove or replace `routes`, which points at this project's domain.

```bash
npx wrangler login
npx wrangler secret put JUDGE_IDENTITY_SECRET --config cloud/wrangler.jsonc   # 64 hexadecimal characters
npx wrangler secret put OPENAI_API_KEY --config cloud/wrangler.jsonc          # optional
npm run cloud:build      # web build plus the security headers file
npm run cloud:deploy
```

The Durable Object serves the API only after a one-time import of a local Judge Demo database:

1. Create the database with `npm run demo:judge:reset`, then stop it.
2. Set a temporary import token of at least 32 characters with `npx wrangler secret put IMPORT_TOKEN --config cloud/wrangler.jsonc`.
3. Run `npm run cloud:migrate-data -- --target https://<your-worker-host>` with the same token in the `RR_IMPORT_TOKEN` environment variable. The script backs up the local database, checks the schema against the migrations, uploads the rows, and confirms the row counts, foreign keys and audit chain head before the cloud copy goes live. Add `--dry-run` to run the checks without uploading.
4. Delete the token with `npx wrangler secret delete IMPORT_TOKEN --config cloud/wrangler.jsonc`. The import endpoints then return 404, and they refuse a second import in any case.

To preview locally, put `JUDGE_IDENTITY_SECRET` and `IMPORT_TOKEN` in `cloud/.dev.vars` (git-ignored) and run `npm run cloud:build` followed by `npm run cloud:dev` (<http://127.0.0.1:8787>, with HTTPS enforcement off). The local preview has its own storage, so import into it the same way with `--target http://127.0.0.1:8787`.

### Limits

- The free plan allows about 10 ms of CPU per request. Most requests use far less, but the Overview page measured 12–20 ms inside the Durable Object without errors. Heavy simultaneous use could still be refused.
- One Durable Object serves every visitor, which suits demo traffic, not production load.
- The Judge Demo allows 20 approved payouts and 40 AI investigations per day.
- There is no reset endpoint. Resetting the shared data is a deliberate manual procedure for the organiser.

## Architecture

```
shared/src/        Domain logic used by both server and web (no framework code)
  domain/money.ts      Integer minor-unit money, per-currency totals, strict decimal parsing
  domain/paypal.ts     PayPal Payouts batch/item statuses and webhook event names
  domain/status.ts     Provider, imported and reported status, kept separate
  domain/imports.ts    Import fields, row outcomes and issue codes
  domain/findings.ts   Reconciliation finding codes and which ones open a case
  domain/cases.ts      Case states, bases and deterministic next-action rules
  domain/overview.ts   Pure function that derives every Overview figure from records
  domain/investigation.ts        Investigation types, labels, failure codes (no Zod; used by the web app)
  domain/investigationSchema.ts  Zod output schema and the strict JSON Schema derived from it (server only)
  domain/payouts.ts    Payment action currencies, limits, proposal and submission states, confirmation phrase
  api/contracts.ts     API request, response and error contracts
server/db/migrations/  Versioned SQL migrations (0001 to 0011)
server/src/        Express 5 API
  config/env.ts        Zod-validated environment; fails fast on invalid configuration
  db/                  Connection settings, migration runner, bootstrap, seed, db:* CLI
  audit/               Audit writer, hash-chain verification
  imports/             CSV parsing, privacy screening, mapping, row validation, reconciliation
  ai/                  Evidence pack builder, prompt, OpenAI adapter (built-in fetch), validator, ai:smoke
  services/            Import, case and investigation services (transactions, roles, auditing)
  payouts/             Eligibility, proposals, submissions, cancellations, status sync, webhook processing, allowlist
  paypal/              PayPal Sandbox client, request builder, webhook listener and verifier, paypal:* CLI
  repositories/sqlite/ Read model that loads records for the Overview and case views
  routes/              session, overview, imports, cases, investigations, payouts, integrations, demo
  middleware/          Request IDs, demo authentication, role checks, structured errors
  test-support/        Local PayPal stub (tests and the development-only stub demonstration), test signing certificate and Sandbox test harness (tests only)
web/src/           React 19 + Vite + TanStack Query
  pages/               Overview, Import, Import detail, Cases, Case detail, Approvals, Proposal, Audit, Settings
  components/          UI primitives, status badges, layout, overview panels
  hooks/ services/ lib/ styles/
```

The repository is a single npm package with path aliases (`@shared/*`) rather than workspaces, so there is one `node_modules` and no workspace symlinks. Only the Express server and the `db:*` scripts open the database; the browser never touches it.

### Key design decisions

- **Three kinds of status, stored separately.** What the provider reported (`provider_transactions`), what imported files said (`status_observations`) and the internal case workflow (`payment_cases.state`) never overwrite each other. Where both exist, the provider status is authoritative and a disagreement opens a reconciliation case.
- **Imported statuses are labelled as records, not facts.** The UI shows them as "Recorded as delivered", "Recorded as failed" and so on, with the file name and row number, and the Overview counts imported records with no provider record as **Unconfirmed**, never as delivered.
- **Provider status is the source of truth for delivery.** A payment is counted as delivered only when the provider reports `SUCCESS`. A resolved case counts as recovered only if a recovery payment actually reached `SUCCESS`.
- **Each intended payment is counted once.** Recovery attempts are separate items linked by `recoveryOfItemId`.
- **Money is integer minor units.** Totals are grouped per currency and never summed across currencies.
- **Deterministic rules come before AI.** Validation, reconciliation findings, next actions and deadlines are computed by versioned rules. Findings are described as facts to check, not conclusions, and never as fraud.
- **Simulation is labelled everywhere.** Mode badges, event source labels, `SIM-` provider references and a persistent mode indicator.

## Database

SQLite through `better-sqlite3`, stored at `server/data/reliefrelay.db` (configurable with `DATABASE_PATH`). The file, its `-wal`/`-shm`/`-journal` companions and everything else in `server/data/` are ignored by Git.

Every connection enables WAL mode, foreign keys, a 5 second busy timeout and `synchronous = FULL`, and the server verifies these took effect before serving requests. Writes run in `BEGIN IMMEDIATE` transactions; if another writer holds the lock past the timeout, the API returns `503 service_unavailable` rather than a partial result.

### Migrations

Migrations are plain SQL files numbered consecutively. Each runs in its own transaction and is recorded in `schema_migrations` with a SHA-256 checksum. The runner refuses to start if an applied migration file has been edited or if the database was migrated by newer code.

| Migration | Contents |
| --- | --- |
| `0001_core.sql` | `organisations`, `users`, `counters` (case reference numbers; may only increase) |
| `0002_imports_and_payments.sql` | `imports`, `import_rows` (raw cells), `import_row_results` (versioned validation results), `payment_batches`, `payment_items`, `provider_transactions`, `status_observations` |
| `0003_cases_and_events.sql` | `payment_cases` (optimistic version column), `reconciliation_findings`, `case_findings`, `case_notes`, `payment_events` |
| `0004_audit_log.sql` | `audit_events`, `audit_chain` and the hash-chain triggers |
| `0005_case_investigations.sql` | `case_investigations`: one row per AI investigation attempt, with the evidence snapshot, model, versions and validated result or failure code |
| `0006_sandbox_receivers_and_status_checks.sql` | `sandbox_receiver_allowlist` (exact emails; deactivated, never deleted) and `provider_status_checks` (append-only record of every status read from PayPal Sandbox) |
| `0007_payout_proposals.sql` | `payout_proposals`: who proposed what, the provider statuses they saw, the decision; a different decider is enforced by a `CHECK` constraint |
| `0008_payout_submissions.sql` | `payout_submissions`, `payout_submission_items`, `payout_reconciliations`: idempotency keys fixed at approval, attempts, separate batch and item status, admin reconciliation |
| `0009_payout_cancellations.sql` | `payout_cancellations`: approved cancellations of unclaimed Sandbox items, with their own send limits and deadline |
| `0010_paypal_webhooks_and_discrepancies.sql` | `paypal_webhook_transmissions` (every delivery), `paypal_webhook_events` (one row per event ID), `provider_discrepancies` and their resolutions |
| `0011_paypal_target_binding.sql` | `paypal_target_binding`: one row recording whether this database's payment actions go to the real PayPal Sandbox or a local stub; it can never change |

All tables are `STRICT`, with `CHECK` constraints on enumerations, amounts, currencies and JSON columns. Triggers reject deletes everywhere and updates on history tables (rows, results, observations, findings, notes, events, audit). Tables that do change (imports, batches, cases, provider transactions) have triggers that keep their identifying columns fixed. Committed and discarded imports cannot change at all, and every case update must increase the case version by exactly one.

### Status observations

Each imported status becomes a new `status_observations` row holding the import, the source row number, the recorded status, the status date and a database-generated `recorded_at`. A later file with a different status for the same payment adds a new observation; earlier observations and the provider record are never changed. The case detail page shows the full observation history, newest first.

### Duplicates

- A payment reference that already exists with **different** details (amount, currency, receiver, batch or recipient) is rejected.
- A reference repeated **within one file** rejects all of its rows.
- Payments with the same recipient reference, amount and currency in the same batch but **different** references are imported and flagged as possible duplicates, which opens a case for confirmation. Nothing is merged, deleted or paid again.
- Uploading a byte-identical file again stores nothing new and points to the earlier upload. Committing an import twice is a no-op that reports `alreadyCommitted`.
- Commit checks the validation version and recomputes a digest of the planned changes inside the write transaction. If anything changed since the preview, nothing is written, the import is re-validated and the API returns `409 stale_preview`.

## Audit log: tamper-evident, not tamper-proof

Every import, validation, commit, discard, case assignment and note is recorded in `audit_events`, including refused attempts (wrong role, stale version, contact details in a note). The database assigns the sequence number and timestamp. An insert trigger extends a SHA-256 hash chain in `audit_chain`, where each hash covers the previous hash and the full event content. Audit entries record identifiers and counts, never note text or contact values.

What this provides:

- The application cannot update or delete audit entries; triggers reject it.
- Editing any stored event, or inserting a chain row by hand, breaks the chain, and `npm run db:verify-audit` reports the first inconsistent event.
- The hash function is registered by the ReliefRelay server, so generic SQLite tools cannot append audit events without it.

What it does **not** provide:

- **Anyone with write access to the database file can still tamper with it.** They can drop the triggers, rewrite events and recompute every hash, producing a chain that verifies.
- **Deleting the newest events is not detectable from inside the database.** It is only caught by comparing against a chain head recorded elsewhere: `db:verify-audit` prints `seq:hash`, and `npm run db:verify-audit -- <seq:hash>` checks that the chain still contains that exact head.
- There is no external anchoring, signing or replication yet. Stronger guarantees would need the head published to storage the database administrator cannot modify.

## CSV import

1. **Upload** a UTF-8 CSV with a header row (up to 2 MB and 5,000 rows). The file is parsed and screened before anything is stored.
2. **Map columns.** Suggestions come from the headings; required fields are payment reference, batch reference, recipient reference, amount, currency, receiver type and receiver.
3. **Review validation.** Each row is classified as new payment, status observation, already imported or rejected, with issues listed per row. Nothing is recorded yet.
4. **Commit** after ticking the review confirmation, or **discard**. Commit writes batches, payments, observations, findings, cases, events and audit entries in one transaction.

The template and a sample file are available from the Import page. The sample (batch `RR-B-2026-019`) exercises every rule: unclaimed and failed rows, a long-pending row, an error code on a delivered row, a possible duplicate pair, a repeated reference, a malformed amount, and status observations for existing payments, including one that contradicts the provider.

Importing records never submits anything to PayPal and never moves money.

## AI-assisted investigation

The **AI-assisted investigation** panel on the case detail page asks an OpenAI model to review a minimised snapshot of one case and return, in a fixed structure:

- **What the records show.** Single factual statements, each citing evidence IDs and quoting the exact field values relied on.
- **What is not known.** Open questions, including any conflicting records or gaps.
- **Possible explanations.** Labelled as possibilities, each with the evidence that is consistent with it, the evidence that weighs against it and the open questions that would settle it.
- **Suggested next steps.** Picked from a fixed list of investigation steps. Steps that would lead to a payment action (proposing a reissue or cancellation, a compliance review) are marked as needing human authorisation and cannot be started from the panel.
- **Summary and limitations.** Including what the records cannot establish.

The AI never approves, starts, retries, cancels or redirects a payment, never judges whether someone should be paid, and never changes a case. There is no chat, no free-text prompt, no confidence score and no payment button. Operators record their own conclusions in the existing case notes.

### How it works

1. An operator or admin clicks **Run investigation** on an active case (one that is neither resolved nor closed). The request carries the case version, so a stale page is refused.
2. In one `BEGIN IMMEDIATE` transaction the server checks the role, the case state and version, the one-in-progress-per-case rule and the daily organisation limit. It then builds the evidence pack, stores it with its SHA-256 fingerprint as a `pending` attempt and writes an audit entry. Concurrent requests (including from separate processes) cannot exceed the limits.
3. Outside any transaction, the server calls the OpenAI Responses API (`POST /v1/responses`) with Node's built-in `fetch`. The request uses Structured Outputs (`text.format` of type `json_schema` with `strict: true`), `store: false`, the configured reasoning effort and an output token cap.
4. The response is checked: refusals, `incomplete` responses, malformed JSON, schema errors and provider errors each become a specific failure code. The parsed output is then validated independently (below).
5. The attempt is completed exactly once as `succeeded` (with the validated result) or `failed` (with a failure code and the names of any failed checks), and a second audit entry is written.

The browser waits for the result synchronously (45 second timeout by default). If the browser disconnects, the server still finishes and records the attempt. Attempts left `pending` by a stopped server are marked `interrupted` at the next startup, or when they are older than twice the timeout plus one minute.

Model output is stored only in `case_investigations`. It is never written to payments, provider records, observations, findings, cases or notes, and database triggers prevent attempts from being deleted or changed after completion. Tests snapshot every payment and case table before and after failed, hostile and successful investigations and confirm they are identical.

### What is sent to OpenAI

The evidence pack is built from an **explicit allowlist of normalised fields**, not by removing values that look sensitive. For the case being investigated only, it can contain:

| Evidence | Fields |
| --- | --- |
| Case | Case reference, state, why it opened, opened date, whether it is assigned |
| Payment | Payment reference, amount, currency, receiver type (for example `EMAIL`, not the receiver), recorded date, the reference of the original payment for a recovery |
| Batch | Batch reference, kind, origin, provider mode, provider batch status, submitted date |
| Provider record | Payment reference, mode (simulation or sandbox), status, error code, provider item and transaction IDs, status date |
| Imported records | Recorded status, status date, error code, source row number, recorded date, whether it is current, claimed provider IDs |
| Reconciliation findings | Finding code, severity, rule version, recorded date, expected and recorded status, conflicting field *names*, duplicate amount and currency, related payment references |
| Recovery payments | Reference, amount, currency and recorded date of linked recovery payments, plus their provider records |
| Events | Up to the 25 most recent system events: type, date, provider event type, previous and new status or case state |
| Reference rules | Fixed ReliefRelay text explaining status authority, simulation mode, the meaning of the statuses present and, where relevant, the 30-day unclaimed return rule |
| Calculated values | Days since the provider status date, the expected automatic return date, days since the imported status date, days since the case opened |
| Conflicts and gaps | Detected disagreements (for example provider and imported status differ) and missing information (for example no provider record) |

References, IDs and error codes are only included if they match a strict format; anything else is replaced with "withheld".

**Never sent:** receiver email addresses and phone numbers, recipient references, recipient or beneficiary names, programme names, raw CSV rows or unfiltered cells, uploaded file names, operator notes, event summaries written for people, audit internals, user names or IDs, and any medical or personal information. Tests import a synthetic file whose name, rows, receivers and notes contain identifiable-looking values, and check that none of them appears in the request sent to the provider or in the stored snapshot.

The stored snapshot is byte-for-byte the evidence string sent to the model (tested). The case page shows it under **Evidence snapshot sent to the model**, together with the list of withheld categories.

### Data retention and live testing

- `store: false` asks OpenAI not to store the response for later retrieval. **It does not eliminate retention.** Under OpenAI's API data controls, requests and responses may still be retained for up to 30 days for abuse monitoring unless the organisation has been approved for Zero Data Retention.
- **All live testing must use synthetic data.** Never configure an API key on a database that contains real beneficiary information. `npm run ai:smoke` builds its own temporary synthetic database and never reads `server/data`.
- Automated tests can never reach OpenAI: under `NODE_ENV=test` the server refuses to build a provider unless the base URL is a loopback address, and all tests use scripted providers or a local stub server.

### Validation: source grounding, not logical correctness

Every response is validated before anything is shown. The validator checks **source grounding**: that what the model says is tied to evidence it was given. It **cannot check that the model's reasoning is correct**, and the UI says so. A response that cites real evidence accurately can still draw a poor conclusion, so operators must read the cited evidence and make their own judgement.

Checks applied to every response:

- **Schema.** Zod validates the output independently of OpenAI's schema enforcement, with length and count limits OpenAI's strict mode does not support.
- **Citations.** Every evidence ID exists, every quoted value matches the cited field exactly (dates by prefix, numbers numerically), and the declared basis (provider record, imported record, rule, calculated value) matches the cited evidence's actual origin.
- **Factual statements.** Each must make one non-causal, unhedged claim, and every status, error code, identifier, date, amount and day count in it must be covered by its own quoted values. A real status cited to support a different claim fails.
- **Conflicts and gaps.** Every detected conflict must be acknowledged as an open question and in the summary's evidence; every gap must be acknowledged. A conclusion that ignores conflicting evidence fails.
- **Possibilities.** Must be hedged, must not use certainty language, and need supporting evidence compatible with the category (for example a duplicate explanation requires a duplicate finding).
- **Next steps.** Proposing a reissue requires a cited provider-origin `FAILED` or `RETURNED` record; proposing a cancellation requires a provider `UNCLAIMED` record. Steps phrased as presuming facts that are not in the evidence, or that suggest contacting the recipient directly, fail.
- **Policy.** No fraud or wrongdoing language, eligibility or deservingness judgements, confidence percentages, claims that the AI has taken an action, personal circumstances, identity or contact details, echoed instructions, or simulated records presented as PayPal records.
- **Global grounding.** Identifiers, statuses, dates, amounts and durations anywhere in the text must appear in the evidence.

The language checks (hedging, causal wording, certainty, policy and presumption phrases) are English pattern lists. They catch the cases in the test suite but can be evaded by unusual phrasing, and they occasionally reject acceptable wording. They reduce risk; they are not a guarantee.

**Fail closed.** If any check fails, the whole response is rejected. Invalid findings are never removed so that the rest can be shown. A failed attempt stores only the failure code and the codes, paths and messages of the failed checks, never the rejected text, and the panel lists those checks. When the records cannot establish an explanation, the model is required to say so, and a response with no supported explanation is valid.

The validator tests include a real status cited for an incorrect explanation, a possibility presented as confirmed, contradictory provider and imported records, a conclusion that ignores conflicting evidence, a statement with several claims of which one is supported, a recommendation that assumes missing information, an unsupported causal claim that uses real evidence IDs, and an instruction-shaped error code in the data. There is also a test documenting a response that passes every check while drawing a weak inference, to show the limit of grounding.

**PayPal Sandbox records (added in Phase 4).** When a case includes a PayPal Sandbox record, the evidence pack adds a `sandbox_mode` rule and the prompt (`investigation-prompt-v2`) asks for Sandbox results to be described as test results. `investigation-prompt-v3` adds one instruction: every quoted value must be 120 characters or fewer, so for longer text the model quotes a short exact excerpt, which the validator already accepts. The 120-character limit is unchanged. The validator rejects a claim that relies on Sandbox evidence without saying it is Sandbox (`sandbox_not_qualified`), that presents a Sandbox result as real-world delivery (`sandbox_presented_as_real_delivery`), or that presents simulated evidence as a PayPal result (`simulation_presented_as_paypal`). The evidence pack version is unchanged. A test pins the evidence fingerprints of all 17 seeded cases, so investigations made before Phase 4 still show as current, not as "evidence changed".

### Roles and limits

| Rule | Value |
| --- | --- |
| Who can run an investigation | Operators and admins |
| Who can read investigations | All roles, including approvers and viewers |
| Eligible cases | Active cases only (open, investigating, awaiting approval, recovery submitted); never resolved or closed |
| In progress per case | One |
| Per organisation per day (UTC) | 50 attempts, including failed ones (`AI_DAILY_INVESTIGATION_LIMIT`) |
| Timeout | 45 seconds for the whole call, including any retry (`AI_TIMEOUT_MS`) |
| Automatic retries | One, for network errors and 5xx responses only. 429 responses are not retried |

Refused requests (wrong role, inactive case, stale version, in progress, daily limit, not configured) return a stable error code and are audited.

### What the case page shows

- Model, run time, number of evidence items, who requested it, and whether the case evidence has **changed since the analysis** (by comparing fingerprints; time-relative values and notes do not count as changes).
- A persistent **AI-generated analysis** label, kept visually distinct from imported records, provider records (labelled *Simulated provider record* in simulation mode), ReliefRelay rules and calculated values, and *Operator note* tags on notes.
- An inspectable evidence reference for every statement. Opening it shows the evidence fields with the quoted ones highlighted, plus a link to the matching record on the page.
- The most recent failed attempt and its failed checks, and a history of all attempts.

### Costs

The default model is `gpt-6.1-sol` at USD 2 per million input tokens and USD 10 per million output tokens (reasoning tokens are billed as output). Measured request sizes are about 3.8K characters of instructions, 3.8K characters of schema and 3.2K to 5.1K characters of evidence, which is roughly 3,000 to 4,000 input tokens. Output, including reasoning at medium effort, is expected to be 2,000 to 6,000 tokens and is capped at 8,000.

**Estimate, not a measurement:** about USD 0.03 to 0.07 per investigation, with a ceiling of about USD 0.09 per attempt at the output cap (twice that if a 5xx retry is billed). At the default limit of 50 per day, an organisation's ceiling is about USD 4.50 per day. `npm run ai:smoke` prints actual token counts and the cost they imply.

### Live verification

**Live OpenAI requests have been run on the public Judge Demo (12 November 2026).** Four investigations passed validation and one was rejected by the validator (`failed_validation`); both outcomes are shown on the case pages. That is a small sample, so pass rates and real costs for `gpt-6.1-sol` are still not measured; `npm run ai:smoke` reports them. Every provider behaviour (success, refusal, incomplete, malformed output, schema rejection, 400, 401, 429, 5xx with retry, dropped connection and timeout) is also tested against a scripted provider and a local HTTP stub of the Responses API.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Enables the feature. Read only by the server |
| `OPENAI_MODEL` | `gpt-6.1-sol` | Model name |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Must be HTTPS (plain HTTP is accepted only for loopback addresses) |
| `OPENAI_REASONING_EFFORT` | `medium` | `low`, `medium` or `high` |
| `AI_TIMEOUT_MS` | `45000` | 5,000 to 120,000 |
| `AI_MAX_OUTPUT_TOKENS` | `8000` | 1,000 to 32,000 |
| `AI_DAILY_INVESTIGATION_LIMIT` | `50` | Attempts per organisation per UTC day |

## PayPal Sandbox payment actions

Phase 4 adds two recovery actions to the case page. **Both run against PayPal Sandbox only, with test money.** Live PayPal hosts are refused at startup in every environment, and simulation mode disables payment actions entirely. Sandbox results show what the PayPal Sandbox API returned; they do not show real-world delivery.

| Action | Allowed when |
| --- | --- |
| **Reissue to the original receiver** | The provider reports the original payment as `FAILED` or `RETURNED` (or the latest recovery attempt failed or was returned), the case is open or under investigation, the receiver is an active entry on the Sandbox allowlist, and fewer than 3 recovery attempts have been made. The same amount goes to the same receiver; there is no way to change either |
| **Cancel an unclaimed recovery payout** | The latest recovery payout is a PayPal Sandbox payout whose status is `UNCLAIMED` |

AI never proposes, approves, retries, cancels or redirects a payment, and nothing is reissued automatically.

### Local PayPal stub versus genuine PayPal Sandbox

`PAYPAL_API_BASE_URL` decides where PayPal requests go. A PayPal Sandbox host (`api-m.sandbox.paypal.com`) is the **genuine PayPal Sandbox**. A loopback address (allowed only in development and tests) is a **local PayPal stub**: a program on the same computer that imitates the PayPal API. Nothing sent to the stub reaches PayPal, not even PayPal Sandbox.

Only answers from the genuine PayPal Sandbox are labelled as PayPal Sandbox results, for example *Accepted by PayPal Sandbox*. With the stub:

- The top bar shows **Local PayPal stub: not PayPal** in a warning style, and the sidebar and every payment notice say that responses are generated locally for testing.
- Submissions read *Accepted by the local PayPal stub*. Timeline entries, audit reasons, case resolutions and API responses use the same wording, and end with "Local stub test response: nothing was sent to PayPal and no PayPal transaction exists".
- Stub timeline events are stored with the source `simulation`, so they show *Simulated provider*. A stub recovery batch has no provider mode, so the overview never shows a *PayPal Sandbox* badge for it. Its programme is *Local PayPal stub recovery (test only)*. Recovery attempts show a *Local PayPal stub* badge instead of *PayPal Sandbox*.

The wording is decided when records are written, from the target the database is bound to. The first start with payment actions records the target in `paypal_target_binding`, and it can never change. A database holding stub records therefore refuses to start against the real PayPal Sandbox, and the reverse. A database with payment actions recorded before this binding existed also refuses to start in Sandbox mode, because its records cannot be labelled reliably. Use a new `DATABASE_PATH` or `npm run db:reset`.

Two places are not covered:

- Error messages returned for refused requests (for example "PayPal Sandbox is not configured") are not reworded.
- AI investigations (Phase 3) read `provider_transactions.mode`, which stays `sandbox` for stub recoveries. An investigation run on a stub database would therefore call those records *PayPal Sandbox records*. Phase 3 code was left unchanged; run AI investigations only against genuine Sandbox data or simulated data.

### Workflow

1. **Status check.** Anyone except a viewer can ask PayPal Sandbox for an item's current status. Every check is recorded in `provider_status_checks`. An action that depends on a Sandbox status needs a check from the last 15 minutes.
2. **Propose.** An operator or administrator chooses the action and a reason, writes a justification for the approver and confirms they checked the status. A proposal sends nothing. It records the provider statuses the proposer saw and expires after 72 hours.
3. **Approve.** A *different* person with the approver or administrator role reviews the evidence and the server's checks, then types the confirmation phrase: payment reference, amount and currency, for example `RR-P-DEMO-SBX-1 12.50 GBP`. On approval, the server re-runs every check in the same transaction that records the decision. The checks cover: role, not the proposer, not expired, Sandbox mode with payments switched on, nothing else in progress, provider statuses unchanged since the proposal, eligibility, allowlist and limits. If the provider status changed in the meantime, the proposal is **superseded** and nothing is sent.
4. **Submit.** The approval creates one submission with a `sender_batch_id` and `PayPal-Request-Id` generated exactly once. The single-item payout is then sent to PayPal Sandbox.
5. **Track.** Batch status and item status are stored and shown separately. A batch reported as `SUCCESS` says nothing about whether the item was delivered. Item status changes come from polling (every 30 seconds by default) and from verified webhooks. Either way, the status is always fetched from PayPal, never taken from a webhook payload. A recovery reported as `SUCCESS` resolves the case. `FAILED` or `RETURNED` returns the case to *investigating*, so a further reissue needs a new proposal and a new approval.

Rejecting or withdrawing a proposal needs a reason and returns the case to the state it had before. Every step, including refused attempts, is written to the tamper-evident audit log.

| Role | Can do |
| --- | --- |
| Operator | Check status, propose, withdraw own proposal |
| Approver | Check status, approve or reject proposals made by someone else, retry a submission with its original keys |
| Administrator | Everything above (including withdrawing any proposal, but never deciding their own), plus manual reconciliation, discrepancy resolution, cancellation re-checks and the Settings connection check |
| Viewer | Read only |

| Limit | Value |
| --- | --- |
| Currencies | GBP, USD and EUR only, as integer minor units; anything else is refused on the server |
| Maximum per payout | 500.00 |
| Payouts per organisation per day (UTC) | 20 |
| Value per currency per organisation per day (UTC) | 2,000.00 |
| Proposal expiry | 72 hours |
| Recovery attempts per payment | 3 |

### Sandbox receiver allowlist

Payouts can only go to receivers on a server-side allowlist, managed with `npm run paypal:receivers`. Entries are exact, lower-cased email addresses, for example the `…@personal.example.com` addresses PayPal generates for Sandbox personal accounts. Entries are compared by exact match, never by pattern. Only reserved test domains are accepted (`example.com/.org/.net`, `.test`, `.example`, `.invalid`), so a real mailbox cannot be added. Wildcards are refused. Phone numbers are refused because PayPal Sandbox Payouts does not support `PHONE` receivers. Entries can be deactivated with a reason but never deleted.

### Preventing duplicate payouts

- The idempotency keys are fixed at approval, and database triggers stop them changing. A retry, a scheduled replay or a restart after a crash always resends **the same** keys, so PayPal can recognise a repeat. New keys are never generated for an approval.
- If the first answer is unclear (timeout, network error, 5xx), the request is replayed after 1 and 5 seconds. It is then replayed on a schedule: after 5 minutes, 15 minutes, 1 hour, 6 hours and 24 hours, then daily, up to 30 attempts.
- PayPal's duplicate protection lasts 30 days. Replays therefore stop **25 days** after approval. The submission then needs **manual reconciliation** by an administrator, and payment actions on the case stay blocked until it is done. The administrator either links the batch they found in PayPal, or records the payout as not created. "Not created" is only accepted 31 days or more after approval.
- When PayPal's answer does not match what was sent (amount, currency, IDs, request hash, unexpected items, an unknown status), the server records a **discrepancy**. Payment actions on the case are blocked until an administrator resolves it.

### Cancellation

PayPal documents no idempotency key for cancelling a payout item, so cancellations are handled separately from submissions. They never rely on `sender_batch_id` or `PayPal-Request-Id`. Before every send, a new status check must show the item as `UNCLAIMED`. An unclear outcome is resolved by reading the status, never by resending blindly. At most 3 sends are made, all within 24 hours of approval. When a cancellation succeeds, the item is recorded as `RETURNED` and the case returns to *investigating*. A reissue after that needs a fresh status check and its own approval.

### Webhooks

The webhook listener is a separate Express app on `PAYPAL_WEBHOOK_PORT` (default 4001), at `POST /paypal/webhooks`. It starts only in Sandbox mode with `PAYPAL_WEBHOOK_ID` set; otherwise status changes are found by polling.

- **Verification.** ReliefRelay verifies signatures itself on the raw request body. It rebuilds the signed message (`transmission id|transmission time|webhook id|CRC32 of the raw body`) and checks the `SHA256withRSA` signature against PayPal's certificate. The certificate URL must be `https://api.sandbox.paypal.com/v1/notifications/certs/<id>` or the same path on `api-m.sandbox.paypal.com`, with no credentials, other port, query, fragment or encoded characters. Certificates are fetched without following redirects and cached for 24 hours. The certificate must be currently valid. The transmission time may be at most 5 minutes in the future and at most 4 days old, which covers PayPal's 3-day retry period. A one-byte change to the body, a re-serialised body or a different webhook ID all fail verification.
- **Records.** Every delivery is stored in `paypal_webhook_transmissions` with its transmission ID, verification outcome and body hash. Each event ID is stored once in `paypal_webhook_events`, so a retried delivery of the same event is processed once.
- **No trust in payloads.** A verified event only says that something may have changed. The processor fetches the item from PayPal Sandbox and applies that answer. A test sends a payload claiming `SUCCESS` while the API says `UNCLAIMED`, and confirms the case is not resolved.

**PayPal retry behaviour and acknowledgements.** PayPal treats any 2xx response as delivered. For anything else, it retries the delivery up to 25 times over 3 days. The listener responds as follows:

| Response | When | Effect |
| --- | --- | --- |
| `200` | Verified and stored, or a duplicate transmission | PayPal stops retrying. Processing happens after the response |
| `400` | Signature verification failed, headers missing or the event unrecognised | PayPal retries; each retry fails the same way and is recorded |
| `503` | The delivery could not be stored (for example the database was busy) | PayPal retries later |
| `413` | Body larger than 64 KB | Rejected |
| `404` | Any other path | Rejected |

### Local payment-flow demonstration (no PayPal account needed)

Without PayPal Sandbox credentials, payment actions stay disabled: the default simulation mode never offers them. To see the propose, approve and track flow anyway, run it against the **local PayPal stub**. This is the same program the automated tests use, and it imitates the PayPal Payouts API on this computer.

```bash
# stop npm run dev first: the demonstration uses ports 4000 and 5173
npm run demo:local-stub
```

The command:

- runs only with `NODE_ENV=development` (or unset), and the server refuses a stub address in production;
- starts the stub on `127.0.0.1` and points ReliefRelay at it, replacing every PayPal setting from `.env`. No PayPal host is called, not even PayPal Sandbox, and real credentials are never sent to the stub;
- uses its own database, `server/data/local-stub-demo.db`, recreated on every run because the stub keeps its payouts in memory. Your normal database is not touched;
- seeds the synthetic data, adds the synthetic receiver `demo.receiver@personal.example.com` to the allowlist, and creates a simulated returned payment (GBP 12.50) with a case, printed in the terminal;
- switches on the role demonstration and switches off AI investigation, because the AI evidence pack would describe stub records as PayPal Sandbox records.

Then:

1. Open <http://localhost:5173/cases> and open the case printed in the terminal (`RR-P-DEMO-SBX-1`). The top bar shows **Local PayPal stub**, and the payment panel says that nothing is sent to PayPal.
2. As Lena Hartmann (operator), choose **Check status with the local PayPal stub**, then propose a reissue with a justification.
3. In the **Role demo** switcher, choose Samuel Mensah (approver). Open the proposal from the Approval centre, type the confirmation phrase (`RR-P-DEMO-SBX-1 12.50 GBP`) and approve.
4. The case shows *Accepted by the local PayPal stub*, with a *Local PayPal stub* badge. The stub batch reports `SUCCESS` while the item stays `UNCLAIMED`, showing that batch status and item status are separate. You can then demonstrate **Cancel the unclaimed local PayPal stub payout** the same way.
5. Stop with Ctrl+C.

Everything in this demonstration is a local test response. It does not show that PayPal Sandbox, or real PayPal, would behave the same way.

### Setting up PayPal Sandbox

Credentials belong only in your local `.env`. Never paste them into chat, code, issues or commits.

1. In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/), switch to **Sandbox** and create an app with **Payouts** enabled. Note a Sandbox personal account's email address to use as the receiver.
2. In `.env`, set `PAYMENT_PROVIDER_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_PAYOUTS_ENABLED=true`. For the role demonstration, also set `DEMO_ROLE_SWITCHER=true` (development only).
3. Run `npm run paypal:sandbox-check` to confirm the token, the Payouts scope and API access.
4. Run `npm run paypal:receivers -- add <sandbox personal email> --label "Sandbox personal account"`.
5. Run `npm run sandbox:demo-scenario -- --receiver <same email>`, then `npm run dev`. Settings shows the configuration and the masked allowlist.
6. Open the new case. As Lena (operator), propose a reissue. Switch the role demonstration to Samuel (approver), open the proposal from the Approval centre, type the confirmation phrase and approve.

**About `sandbox:demo-scenario`.** No real PayPal transaction exists for ReliefRelay to recover. The command therefore creates a new batch, payment and case, labelled throughout as a simulated original payment with a simulated `RETURNED` record. They use `SIM-` provider IDs, the programme `DEMO_PROGRAMME`, and events stating that no request was ever sent to PayPal for the original. Only receivers already on the allowlist are accepted. The command never modifies existing seeded records and runs only in development. The recovery you then approve is a **genuine PayPal Sandbox payout** when `PAYPAL_API_BASE_URL` is the Sandbox host. The case page keeps the two apart: the original is labelled *Simulated provider*, and the recovery is labelled *PayPal Sandbox*. If `PAYPAL_API_BASE_URL` points at a local stub, the recovery is a stub response and is labelled *Local PayPal stub* instead.

### Genuine webhook verification test

**Genuine webhook verification has not been run.** The two tests in `webhooks.test.ts` under "genuine PayPal Sandbox webhook delivery" are skipped until a real delivery is captured. They check that the original headers, raw body and PayPal certificate verify, and that one changed byte or a different webhook ID does not.

The local tests use a certificate and private key generated for this project (`server/src/test-support/paypalTestCert.ts`). They cover:

- **CRC32 of the exact raw body.** The published CRC-32 test vector (`"123456789"` → `3421780262`, whose high bit is set) and an independent bitwise CRC-32 over non-ASCII text, binary bytes and bodies differing only in line endings. The CRC must be the unsigned decimal: a signature over the signed value (`-873187034`) or hex is refused.
- **The signing string.** A signature over a hand-written string `transmission id|transmission time|webhook id|crc32` verifies. These tests do not reuse the verifier's own formula.
- **Signature verification.** One changed byte, a re-serialised body, a different webhook ID and a signature from a key other than the certificate's all fail.
- **Certificate handling.** The certificate URL rules (host, HTTPS, port, path, no credentials, query, fragment or encoded characters), fetch failures, unparsable certificates, validity dates, the transmission time window and the 24-hour cache.

What cannot be verified until a genuine Sandbox delivery is received:

- that PayPal's real headers have the names and formats assumed here (transmission time format, `SHA256withRSA`, certificate URL path);
- that PayPal signs exactly this string with the certificate it publishes, in particular the webhook ID it uses and the CRC of its real bodies;
- the real certificate's format, validity dates and size;
- the real event payload shapes and event types, and PayPal's retry timing.

**Trust model.** ReliefRelay does not validate the certificate's chain or subject. Trust comes from fetching the certificate over HTTPS, without redirects, from the two pinned PayPal Sandbox hosts only. The production listener never passes its own certificate fetcher, so the local test certificate can never be trusted outside the tests (covered by `testCertificateIsolation.test.ts`).

To create the fixture:

1. Expose port 4001 with an HTTPS tunnel. Register `https://<tunnel>/paypal/webhooks` as a webhook on the Sandbox app, subscribed to `PAYMENT.PAYOUTS-ITEM.*` and `PAYMENT.PAYOUTSBATCH.*`. Put its ID in `PAYPAL_WEBHOOK_ID`.
2. Set `PAYPAL_WEBHOOK_CAPTURE_DIR=server/data/webhook-captures` (inside `server/data/`, so captures are never committed). Restart, then trigger an event, for example by approving a Sandbox reissue.
3. Run `npm run paypal:webhook-fixture -- server/data/webhook-captures/<file>.json`. Only a capture that verified on receipt is accepted. Then run `npm test`.

### What has and has not been tested against PayPal Sandbox

**One genuine PayPal Sandbox payout has been sent and completed, from a private development environment.** It went through the normal workflow, not a script calling PayPal directly:

| Step | Evidence (12 November 2026, UTC) |
| --- | --- |
| Credentials | `npm run paypal:sandbox-check` against `api-m.sandbox.paypal.com`: token accepted, Payouts scope granted, read of a non-existent batch returned `404 INVALID_RESOURCE_ID` |
| Case | RC-1065 in the private database: a **simulated** `RETURNED` GBP 12.50 payment to an allowlisted Sandbox personal account (`s•••1@personal.example.com`) |
| Proposal | Reissue of GBP 12.50, proposed by Lena Hartmann (operator) at 17:17:20. Nothing was sent |
| Approval | Samuel Mensah (approver, a different person) typed `RR-P-DEMO-SBX-1 12.50 GBP` at 17:17:37. All nine server checks passed |
| Submission | One `POST /v1/payments/payouts` answered **HTTP 201**. PayPal batch `FYCRGVXX6YGBJ`, item `G793HKHHYJMZ4`, both `PENDING` |
| Completion | The background poller read the item at 17:27:53 (HTTP 200): **`SUCCESS`**, PayPal transaction `97E50360RV0685251`. The batch read back as `SUCCESS`, and the case was resolved |
| Audit | 9 new audit events (proposal, approval, send, acceptance, resolution). The hash chain verifies across all 36 events |

This is a Sandbox result: test money between PayPal Sandbox accounts, not real-world delivery. The original payment in RC-1065 is simulated; only the recovery payout is a genuine Sandbox transaction. The public Judge Demo does not use PayPal Sandbox.

Everything else is tested against a local stub of the PayPal API, including:

- token, create, batch and item reads, and cancellation;
- timeouts, 5xx, 409, 422 and malformed answers;
- replays, crash recovery, deadlines and reconciliation;
- discrepancies, webhooks and certificate handling.

The UI was exercised end to end against that stub, and every result was labelled as a local stub response. The following have still not been observed against PayPal Sandbox: statuses other than `SUCCESS` (failed, returned, unclaimed, held), cancellation, genuine webhook signature verification (the fixture test above), and how PayPal Sandbox actually responds to replays and cancellations.

**Code review against the approved plan (not a PayPal test).** The request construction, response parsing, idempotency and cancellation paths were reviewed against the Phase 4 plan:

- **Request.** `POST /v1/payments/payouts` with a single `EMAIL` item, a two-decimal amount from integer minor units, and the `sender_batch_id`, `sender_item_id` and `PayPal-Request-Id` fixed at approval. The body is rebuilt and compared with the approved SHA-256 before every send.
- **Parsing.** Batch and item statuses are read separately, amounts must be exact two-decimal strings, and unknown statuses or mismatched IDs become discrepancies.
- **Idempotency.** Every replay resends the same keys and body. Unclear answers (network errors, 5xx, 409, `PREVIOUS_REQUEST_IN_PROGRESS`) are replayed. A duplicate-request link is resolved by reading that batch.
- **Fix from the review.** A definite refusal (4xx) to a *replay* is no longer recorded as "rejected, no payout created". An earlier attempt may have created the payout, so the submission now goes to manual reconciliation (tested). Only a refusal of the first attempt is recorded as rejected.
- **Cancellation.** A status check comes before every send, with at most 3 sends within 24 hours. An unclear answer is confirmed by reading the status, and a refused cancellation of an item that is still `UNCLAIMED` goes to manual reconciliation. A cancellation that never succeeds keeps polling read-only until a status check works; it never resends without one.

Apart from the single successful payout above, none of these behaviours have been observed against PayPal Sandbox.

## Privacy

- The demo organisation holds synthetic data only. Recipients are pseudonymous references (`BEN-XXXXXX`).
- Uploads containing email addresses outside reserved test domains (`example.com/.org/.net`, `.test`, `.example`, `.invalid`) or phone numbers outside fictional ranges (UK 07700 900xxx, US 555-01xx) are refused in full. The response and audit entry list the row and column of each finding, never the value.
- Case notes containing any email address or phone number are refused.
- Receivers are shown masked throughout the UI. Raw imported cells are kept in `import_rows` as the record of what was uploaded, and the mapping preview shows the first rows as uploaded.
- These checks cannot reliably detect names or medical information. The UI asks users not to enter them.
- Logs omit query strings and response bodies, and redact credentials and receiver identifiers.
- AI investigations send only the allowlisted evidence described in [What is sent to OpenAI](#what-is-sent-to-openai). Investigation logs and audit entries contain IDs, status, failure codes, check codes and token counts, never prompts, evidence, model output or provider error text (covered by a test that captures the server logs).

## Accessibility

The target is WCAG 2.2 AA. Status is always shown as icon plus text, never colour alone. There is a skip link, every control is keyboard accessible, focus moves to the page heading after navigation, form errors are announced and linked to their fields, and wide tables scroll inside labelled, focusable regions instead of the page.

An axe-core audit (WCAG 2.0/2.1/2.2 A and AA plus best practices) at 390 px, 879 px and 1440 px reports no violations on the Overview, Import, Import detail (draft, validated, committed and discarded), Cases (including the filtered view) and Case detail pages, and with the mobile drawer open. The only inconclusive contrast results are table cells scrolled out of view inside horizontal scroll regions; the same elements pass when visible.

For Phase 3 the Case detail page was audited at the same widths with the AI panel in four states: not configured, no analysis yet, a validated analysis, and a failed attempt shown above an earlier analysis. Each was audited with every disclosure (evidence references, failed checks, evidence snapshot and history) closed and open, and on a resolved case where running is not allowed. No violations, no inconclusive results and no horizontal page overflow were reported. The configured states were produced with a local stub of the OpenAI API, not a real model. Progress while an investigation runs is announced through a polite live region, and nothing is animated except the standard button spinner.

For Phase 4, the following pages were audited at 390 px, 879 px and 1440 px (WCAG 2.0/2.1/2.2 A and AA rules), in Sandbox mode against the local PayPal stub:

- Case detail, with the payment actions panel showing the propose form, and again after submission;
- the Approval centre;
- a proposal awaiting a decision, with the typed-confirmation form;
- an approved proposal, with its outcome;
- Settings and Audit history.

No violations and no horizontal page overflow were reported. At 390 px, the role demonstration switcher hides the top bar logo and the avatar, which duplicate the switcher, so the top bar fits. The audit was repeated after the local stub labelling was added (Case detail, Approval centre, proposal, Settings, Audit history, Overview and Cases), again with no violations at any width.

**Audit table at 390 px.** The table (665 px wide) scrolls inside a labelled region ("Audit entries table", `tabindex="0"`) that is 357 px wide, so the page itself does not scroll sideways. axe reports some cells as inconclusive because they are clipped by that region or sit under the sticky top bar. The same cells report no contrast violations when scrolled into view. Checked in the browser:

- The region follows the Outcome filter in the tab order.
- Its focus ring (2 px white inside 4 px green) is not clipped by any ancestor and is visible on every edge.
- Scrolling the region brings each column (#, Recorded, Action, Actor, Outcome) fully into view.
- No cell text is truncated, and cell text is 12–13 px.
- Outcomes show an icon and text.

Not checked: real key presses. The browser automation sends synthetic key events, which do not move focus or scroll, so moving focus with Tab and scrolling with the arrow keys in a real browser, and with a screen reader, still needs a manual check.

## Security

- Secrets are read only on the server. The session endpoint reports whether an integration is configured, never its values (covered by a test).
- Every write checks the user's role on the server. Viewers cannot upload, commit, assign or add notes; refused attempts are audited.
- Request bodies are size-limited (JSON 100 KB, CSV 2 MB) and validated with Zod. Errors have a stable code and a request ID and never include a stack trace.
- PayPal credentials are read only by the server, never returned or logged, and the access token is never printed. Only the PayPal Sandbox API host is accepted; live PayPal is refused at startup. Automated tests refuse any PayPal endpoint other than a local stub.
- Payment actions need a proposal by one person and an approval by another. Separation is enforced in the service and by a database `CHECK` constraint, and the approver must type the exact payment reference, amount and currency. Approval re-runs every check in the same transaction. Payment actions are off unless `PAYPAL_PAYOUTS_ENABLED=true`, and they are always disabled in simulation mode.
- Idempotency keys, approvals and provider status checks cannot be changed or deleted (triggers, tested). Webhooks are verified on the raw body with strict certificate URL rules, and payload statuses are never trusted.
- The webhook test certificate and its private key (`server/src/test-support/paypalTestCert.ts`) are imported only by test files. A test walks the imports from the server, the command-line tools and the browser app and confirms none of them can reach the test certificate, and that its key material appears in no other source file. The production web build was searched for the key and certificate contents and PEM markers, with no matches. The server runs from source and has no bundle.
- The role demonstration switcher is refused at startup outside `NODE_ENV=development`. When it is off, its endpoint returns 404 and its cookie is ignored. When it is on, the cookie is `HttpOnly` and `SameSite=Strict`, and every write request must carry a custom header that a cross-site form cannot send.
- The OpenAI API key is used only by the server and is never returned, logged or included in error messages (tested). Provider error bodies are reduced to fixed messages before they are stored or shown.
- AI output is treated as untrusted input: it is parsed, validated and displayed as text only, and it cannot trigger any action.

## Known limitations

- Authentication is a fixed demo identity (Lena Hartmann, operator). In development, `DEMO_ROLE_SWITCHER=true` lets you switch between the seeded demo users to demonstrate separation of duties. It is a role demonstration, not authentication.
- Only one payout has been sent to the real PayPal Sandbox, and it succeeded. Failures, returns, unclaimed payouts, cancellations, replays and webhooks are tested against a local stub only, so differences in how the real Sandbox API handles them have not been observed.
- Sandbox results never show real-world delivery. The demo scenario's original payment is simulated, and only the recovery payout is a genuine Sandbox transaction (or a local stub response, labelled as such).
- With a local PayPal stub, error messages for refused requests still say "PayPal Sandbox", and AI investigations would describe stub recoveries as Sandbox records (see [Local PayPal stub versus genuine PayPal Sandbox](#local-paypal-stub-versus-genuine-paypal-sandbox)).
- The poller and replay schedule run inside the API process. There is no separate worker, so nothing is polled while the server is stopped; state is recovered at the next start.
- Case list filtering and sorting run in memory over the organisation's records. This is fine for demo volumes; a larger deployment would push filters into SQL.
- The cases search box does not resynchronise if the URL is changed by browser back/forward while the page stays mounted.
- Reconciliation finding messages are written at validation time, so a few read in the future tense on the case page ("A case will be opened…").
- AI-assisted investigation has only a small live sample (five investigations on the public Judge Demo). Pass rates, latency and real costs for `gpt-6.1-sol` are not yet measured; `npm run ai:smoke` reports them.
- The validator proves source grounding, not correctness. Its language checks are English pattern lists that can miss unusual phrasing or reject acceptable wording; a strict validator may also reject many real model responses, which would show as `failed_validation` attempts that still count towards the daily limit.
- The daily limit counts attempts, not tokens or spend. There is no per-user limit.
- Investigations run synchronously in the request. A slow model holds the HTTP request open for up to the timeout; there is no background queue.
- The repository layer is SQLite-specific. Services take a database handle rather than a driver-neutral interface, so moving to PostgreSQL would mean porting the read model, services and migrations, although the schema avoids SQLite-only types.
- ReliefRelay is a hackathon prototype. Only the public Judge Demo is deployed, with synthetic data and a local PayPal stub. It has no real users, beneficiaries, partner organisations or measured impact.

## Licence

ReliefRelay is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). If you run a modified version as a network service, the AGPL requires you to offer its users the corresponding source code.

Third-party dependencies keep their own licences (mainly MIT, Apache-2.0, ISC, BSD and MPL-2.0; the Inter font is under the SIL Open Font License 1.1). They are installed from npm and are not included in this repository.
