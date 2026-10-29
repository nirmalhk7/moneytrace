# Money Trace build plan

## Product target

Build a local, inspectable payment-reconciliation product for a contractor
marketplace. Keep the approved job-to-payout workflow. Add an independent Column
settlement-report comparison that explains missing, duplicate, mismatched,
returned, and untracked money movements. Add a small deterministic failure lab
for replaying the important recovery cases without sending money.

## Milestone 1: local payout workflow — implemented

- `packages/domain`: exact-cent money handling and balanced journal validation.
- `apps/server`: Fastify API, PostgreSQL migrations, job approval, cash
  reservation, payout attempts, settlement, return, manual retry, Column ACH
  sandbox adapter, and transfer sync.
- `apps/web`: operator UI for job entry and approval, payout submission,
  returned-payment retry, activity, and Column counterparty setup.
- `docker-compose.yml`, `.env.example`, workspace configuration, and `README.md`
  provide local setup. `.qlty/qlty.toml` defines full-repository Qlty scans.
- Acceptance: `CI=true pnpm verify`; `docker compose config --quiet`.

## Milestone 2: settlement reconciliation — implemented

- `packages/domain/src/reconciliation.ts` compares imported Column
  bank-account transaction rows with payout attempts and the application
  ledger. It classifies matched, pending, returned, untracked, missing-ledger,
  missing-bank, duplicate-row, and amount-mismatch cases.
- `apps/server/src/reconciliation/` stores imports and exposes report history
  and computed findings. Imports are idempotent by report ID and row number.
- `apps/web/src/components/ReconciliationPanel.tsx` imports reports and shows
  transaction ID, provider event type, amount, expected payout, ledger status,
  and classification.
- Domain and API tests use hand-derived rows to cover each classification and
  prove re-imports do not duplicate rows or findings.
- An operator can rebuild a missing settled-payout ledger posting from one
  exact, non-duplicate Column report row. The repair is append-only,
  idempotent, and performs no provider payout call.
- Acceptance: a report with one matched payout, one absent ledger posting, one
  amount mismatch, one unknown transaction, one duplicate event, and one return
  renders each discrepancy with the source row that proves it.

Current evidence: domain tests cover every classification. API tests prove
idempotent report import, conflicting-ID rejection, missing-ledger detection,
and matched, returned, mismatch, duplicate-row, and untracked findings. Web
tests cover exact minor-unit parsing, malformed JSON, bodyless approval
requests, and duplicate event payloads. Failure Lab tests prove replay inbox
deduplication and lost-response recovery without a second payout; sandbox
recovery reuses the same idempotency key. Ledger repair requires exact
settlement evidence and never creates a second payout attempt. A recorded
report-import clip and its matching generated report rows are in
`output/playwright/demo/`.

## Milestone 3: small Failure Lab and recruiter demo — implemented

- Add a replay-only scenario runner that can simulate a lost provider response,
  duplicate event delivery, and a returned payout. Replays must reuse the same
  idempotency key; event delivery must be deduplicated; a returned payout must
  reopen only its own obligation and keep the platform fee earned.
- Add a visible replay workspace for missing-ledger, duplicate-event, returned,
  and lost-response scenarios. Keep simulated evidence labeled as replay data.
- Add recovery tests that prove no duplicate payout is created and ledger
  entries stay balanced. Document a three-minute demo and reproducible setup in
  `README.md`.
- Acceptance: one local command resets only the disposable test database and
  runs the full test, build, and Qlty gates; the replay demo reproduces its
  findings without real provider credentials or money movement.

Recorded demo artifacts are in `output/playwright/demo/`. The UI import clip
uses `column-report.json` and shows matched, returned, missing-ledger,
duplicate, and untracked findings. The operations clip shows approval, return
and retry, same-attempt recovery, and duplicate webhook delivery.

## Conditional Column sandbox verification

When valid sandbox credentials and contractor counterparty IDs are configured
in the user's local `.env`, verify ACH submission and transfer lookup against
Column with `pnpm column:sandbox:smoke`. It refuses non-sandbox keys, creates a
zero-dollar ACH prenote, and verifies transfer lookup. Automated tests use
injected fetch responses and never require or expose real credentials.
Production payment mode is outside this project scope.

## Milestone 4: isolated incident lab and evidence verifier — implemented

- Failure Lab runs lost-response recovery, missing-ledger repair, and
  post-settlement return through existing job, payout, reconciliation, and
  ledger services in disposable PostgreSQL schemas. A run cannot change the
  operator ledger.
- Preserve only an immutable, replay-labeled evidence bundle in
  `incident_runs`. `packages/domain/src/incident-evidence.ts` validates journal
  balance, scenario transitions, and single-attempt recovery/repair claims;
  normalized evidence supports deterministic comparison across run IDs.
- `pnpm evidence:verify <file>` checks exported JSON without database access or
  provider credentials. The UI shows the observation timeline and downloads
  evidence.
- Acceptance: all three scenario APIs return verifier-approved evidence, and
  integration tests prove operator opening cash remains unchanged.
- Actual sandbox walkthrough remains conditional on sandbox key, account, and
  counterparty configuration. Replay evidence never represents live sandbox
  observations.
