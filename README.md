# Money Trace

Money Trace is a local payout-operations console for a small contractor
marketplace. It records a job’s gross amount, contractor allocations, and
platform fee; approval creates payable obligations and a balanced journal.
Operators can submit ACH payouts in replay mode or through a Column sandbox
account, inspect each attempt, and manually retry returned payouts.

The reconciliation workspace imports Column `bank_account_transaction` JSON
reports, compares provider transactions with payout attempts and ledger
journals, and displays missing, duplicate, returned, mismatched, and untracked
activity with the original report row. Column reports are available as CSV,
JSON, and Parquet; this first release accepts JSON exports. For one exact
settled transfer whose local settlement journal is missing, an operator can
rebuild the local ledger from that report row. The repair is idempotent and
does not submit or retry a payout. See [Column's
reporting guide](https://docs.column.com/guides/reporting) for report fields and
download instructions.

## Run locally

Requirements: Node.js 22.12+, pnpm 11, and Docker Compose.

```sh
pnpm install
docker compose up -d postgres
cp .env.example .env
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API listens on
port `3001`; it applies database migrations on startup. The included database
starts with three sample contractors and $10,000 of prefunded cash and
unallocated customer funds.

The default `BANK_MODE=replay` uses no provider credentials. Create a draft job,
review the contractor split and platform fee, approve it, select the resulting
obligations, then submit them. Choose “Return this payout” to see a returned
attempt restore the payable while keeping the platform fee earned. Select the
returned obligation and submit it again to create a new payout attempt.

## Demo walkthroughs

Recorded walkthroughs: [payout operations](output/playwright/demo/money-trace-demo.webm)
and [report reconciliation](output/playwright/demo/money-trace-reconciliation.webm).
The [Column JSON report](output/playwright/demo/column-report.json) contains
the generated replay IDs shown in the reconciliation clip. Replay IDs are
created per run; for a fresh workspace, build a report from the transfer IDs
shown in its payout activity. The [ledger repair report](output/playwright/demo/column-repair-report.json)
contains the single settled transfer used to demonstrate local repair in this
workspace; its replay ID is also run-specific.

1. Create a job, review the fee and contractor allocation, save it, then approve
   it.
2. In the payout queue, choose “Lost response” for a due obligation.
   The attempt becomes unknown without a ledger posting. Choose “Recover same
   attempt”; the original attempt receives its provider reference and one
   balanced submission journal.
3. In “Can you break this payout?”, run each isolated scenario. Download the
   evidence JSON and check it with `pnpm evidence:verify <file>`. Runs use a
   temporary PostgreSQL schema, then preserve only the replay-labeled evidence
   record. They make no Column requests.
4. Choose “Return this payout” on a due obligation to show a returned payment
   reopening only that payable. Submit the returned obligation again to
   demonstrate a deliberate retry.
5. In “Settlement reconciliation,” upload a Column JSON transaction report.
   Findings include the source transaction ID, event type, signed amount,
   account, and effective time. Importing identical data with the same report
   ID produces no extra rows. To repair a missing settlement posting, use a
   report with exactly one `ach.outgoing_transfer.settled` row, the expected
   bank account, and the exact negative payout amount, then choose “Repair
   ledger (no payout).” The finding becomes matched without another provider
   request. See [the repair report](output/playwright/demo/column-repair-report.json)
   for the current replay row format.

For a reproducible reviewer setup, use replay mode and no Column credentials:
follow “Run locally,” then run `CI=true pnpm verify`. The automated suite uses
an isolated `money_trace_test` database and never clears the local app database.

### Incident evidence

Each Failure Lab run uses the real job, payout, reconciliation, and ledger
services in a disposable PostgreSQL schema. Run schemas are dropped after
evidence capture; one immutable JSON bundle is retained in `incident_runs`.
Exported evidence identifies replay as its source and includes the request key,
provider observation sequence, attempt, and balanced ledger journals. It proves
that the supplied records are internally consistent; it does not authenticate
Column observations.

Run the verifier without database access or credentials:

```sh
pnpm evidence:verify output/incident-evidence.json
```

For consistent comparisons between reruns, use
`normalizeIncidentEvidence()` to replace run-specific IDs. Scenario assertions
cover one $90 contractor payout from a $100 job with a $10 earned fee.

## Reconcile a report

Open “Settlement reconciliation,” enter a stable report ID, choose a Column
`bank_account_transaction` JSON file, and import it. Re-importing identical
rows with the same ID is safe; reusing an ID for different row data is rejected.
The table includes provider transaction ID and type, expected and observed
amounts, bank account, and effective time so each classification can be traced
back to its source evidence. A “Repair ledger (no payout)” action appears only
for one exact settled report row with no matching settlement journal. It
rejects duplicate report rows, returned payouts, wrong amounts, and unexpected
bank accounts. The repair appends the missing balanced journal entries and
marks the existing attempt settled; repeated requests are safe and do not call
the payout provider.

## Column sandbox

The sandbox mode sends ACH credits through Column. Use a sandbox API key
(`test_…`), a Column bank account ID, and a counterparty ID for each contractor.
Set the values in `.env`:

```dotenv
BANK_MODE=column
COLUMN_API_KEY=test_your_sandbox_key
COLUMN_BANK_ACCOUNT_ID=bacc_your_sandbox_account
COLUMN_SMOKE_COUNTERPARTY_ID=cpty_your_sandbox_counterparty
```

Restart the server, add each contractor’s `cpty_…` ID in “Contractor
connections,” then submit a payout. The app stores a per-attempt idempotency key
before submission. Click “Sync Column” on a processing batch to read the latest
ACH transfer state; settled transfers close the payable, while returned
transfers restore it for manual retry. No production keys or real-money mode
are configured by this project.

To verify sandbox authentication and ACH create/read access without moving
funds, set `COLUMN_SMOKE_COUNTERPARTY_ID` to a sandbox counterparty and run
`pnpm column:sandbox:smoke`. The command refuses keys without the `test_`
prefix, creates a zero-dollar ACH prenote with a fresh idempotency key, then
retrieves that transfer by ID. Column must have ACH prenotes enabled for the
sandbox platform. Sandbox transfers persist in Column; the check does not
settle or delete its prenote. Column documents zero-dollar prenotes in its
[ACH transfer API](https://docs.column.com/api/ach-transfer/create-an-ach-transfer/)
and sandbox behavior in its [testing guide](https://docs.column.com/guides/sandbox-and-testing).

If a request was sent but its response was lost, the attempt stays “unknown.”
Choose “Recover same attempt” to submit again with its original
`Idempotency-Key` and saved request details. Recovery is blocked when those
details are absent or the attempt is 30 days old, because Column may expire
idempotency keys after that period. Column documents this request key for ACH
creation in its [idempotency guide](https://docs.column.com/working-with-the-api/idempotency/).

## Tests and checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm qlty
```

`pnpm test` resets only the dedicated `money_trace_test` database, then runs
domain, API, provider, and UI request, parser, and money tests. Keep `TEST_DATABASE_URL`
pointed at a disposable test database; the reset step drops and recreates its
`public` schema. The app’s normal database is `money_trace` and is not touched
by the test reset.

`pnpm qlty` runs full-repository Qlty smell and check scans. `.qlty/qlty.toml`
stays checked in with the repository.
