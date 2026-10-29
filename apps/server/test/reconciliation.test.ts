import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { approveJob, createDraftJob } from "../src/jobs/store";
import { createPayoutBatch } from "../src/payouts/store";
import { submitPayoutBatch } from "../src/payouts/submissions";
import { migrate } from "../src/database/migrate";
import { createIsolatedTestPool } from "./test-pool";

let pool: Pool;
let app: FastifyInstance;
let cleanup: () => Promise<void>;
let providerCalls = 0;

describe("settlement reconciliation API", () => {
	beforeAll(async () => {
		const isolated = await createIsolatedTestPool();
		pool = isolated.pool;
		cleanup = isolated.cleanup;
		await migrate(pool);
		app = buildApp(pool, {
			bankMode: "replay",
			columnFetcher: async () => {
				providerCalls += 1;
				return new Response("{}", { status: 200 });
			},
		});
		await app.ready();
	});

	async function prepareMissingLedgerReport(
		reportId: string,
		rows: readonly {
			transaction_type: string;
			available_amount: number;
		}[],
	): Promise<{ attemptId: string; transferId: string; obligationId: string }> {
		const job = await createDraftJob(pool, {
			title: `Ledger repair fixture ${reportId}`,
			gross: 2750n,
			platformFee: 250n,
			allocations: [{ contractorId: "contractor_mara", amount: 2500n }],
		});
		await approveJob(pool, job.id);
		const obligation = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const simulated = await app.inject({
			method: "POST",
			url: "/api/replay/missing-ledger",
			payload: { obligationId: obligation.rows[0]?.id },
		});
		const { attemptId, providerTransferId: transferId } = simulated.json() as {
			attemptId: string;
			providerTransferId: string;
		};
		await app.inject({
			method: "POST",
			url: "/api/reconciliation/reports",
			payload: {
				reportId,
				rows: rows.map((row, index) => ({
					effective_at: `2026-10-27T16:1${index}:00Z`,
					bank_account_id: "bacc_demo",
					transaction_id: transferId,
					currency: "USD",
					...row,
				})),
			},
		});
		return {
			attemptId,
			transferId,
			obligationId: obligation.rows[0]?.id ?? "",
		};
	}

	async function expectRejectedLedgerRepair(
		reportId: string,
		rows: readonly {
			transaction_type: string;
			available_amount: number;
		}[],
	): Promise<void> {
		const { attemptId } = await prepareMissingLedgerReport(reportId, rows);
		const repair = await app.inject({
			method: "POST",
			url: "/api/reconciliation/repairs",
			payload: { reportId, rowNumber: 1 },
		});
		const journals = await pool.query(
			"SELECT id FROM ledger_journals WHERE source_id = $1",
			[attemptId],
		);

		expect(repair.statusCode).toBe(400);
		expect(journals.rowCount).toBe(0);
	}

	afterAll(async () => {
		await app.close();
		await cleanup();
	});

	it("imports a Column report once and links known and untracked transactions", async () => {
		const job = await createDraftJob(pool, {
			title: "Report match fixture",
			gross: 30000n,
			platformFee: 3000n,
			allocations: [{ contractorId: "contractor_mara", amount: 27000n }],
		});
		await approveJob(pool, job.id);
		const obligation = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const batch = await createPayoutBatch(pool, [obligation.rows[0]?.id ?? ""]);
		await pool.query(
			`UPDATE payout_attempts SET status = 'settled', provider_transfer_id = $2
			 WHERE id = $1`,
			[batch.attempts[0]?.id, `acht_${batch.attempts[0]?.id}`],
		);
		const transferId = `acht_${batch.attempts[0]?.id}`;
		const rows = [
			{
				effective_at: "2026-10-27T16:10:00Z",
				bank_account_id: "bacc_demo",
				transaction_id: transferId,
				transaction_type: "ach.outgoing_transfer.settled",
				currency: "USD",
				available_amount: -27000,
			},
			{
				effective_at: "2026-10-27T16:11:00Z",
				bank_account_id: "bacc_demo",
				transaction_id: "acht_external_1",
				transaction_type: "ach.incoming_transfer.settled",
				currency: "USD",
				available_amount: 9000,
			},
		];
		const payload = { reportId: "report_demo_1", rows };

		const imported = await app.inject({
			method: "POST",
			url: "/api/reconciliation/reports",
			payload,
		});
		const repeated = await app.inject({
			method: "POST",
			url: "/api/reconciliation/reports",
			payload,
		});
		const reconciliation = await app.inject({
			method: "GET",
			url: "/api/reconciliation?reportId=report_demo_1",
		});

		expect(imported.statusCode).toBe(201);
		expect(imported.json().importedRows).toBe(2);
		expect(repeated.statusCode).toBe(200);
		expect(repeated.json().importedRows).toBe(0);
		expect(reconciliation.statusCode).toBe(200);
		expect(reconciliation.json().findings).toEqual(
			expect.arrayContaining([
				{
					transactionId: "acht_external_1",
					classification: "untracked_transaction",
					observedAmountMinor: "9000",
				},
				expect.objectContaining({
					transactionId: transferId,
					classification: "missing_ledger_entry",
					expectedAmountMinor: "27000",
					observedAmountMinor: "-27000",
				}),
			]),
		);
		expect(reconciliation.json().reports).toEqual([
			{ reportId: "report_demo_1", rowCount: 2 },
		]);
	});

	it("rejects reuse of one report row number with different evidence", async () => {
		const first = await app.inject({
			method: "POST",
			url: "/api/reconciliation/reports",
			payload: {
				reportId: "report_conflict",
				rows: [
					{
						effective_at: "2026-10-27T16:10:00Z",
						bank_account_id: "bacc_demo",
						transaction_id: "acht_one",
						transaction_type: "ach.outgoing_transfer.settled",
						currency: "USD",
						available_amount: -1000,
					},
				],
			},
		});
		const conflicting = await app.inject({
			method: "POST",
			url: "/api/reconciliation/reports",
			payload: {
				reportId: "report_conflict",
				rows: [
					{
						effective_at: "2026-10-27T16:10:00Z",
						bank_account_id: "bacc_demo",
						transaction_id: "acht_one",
						transaction_type: "ach.outgoing_transfer.settled",
						currency: "USD",
						available_amount: -2000,
					},
				],
			},
		});

		expect(first.statusCode).toBe(201);
		expect(conflicting.statusCode).toBe(400);
		expect(conflicting.json().error).toContain(
			"Settlement report ID already exists with different row data.",
		);
	});

	it("deduplicates replay webhook deliveries by event ID", async () => {
		const event = {
			eventId: "evt_replay_duplicate_1",
			eventType: "ach.outgoing_transfer.settled",
			transferId: "acht_replay_demo_1",
			payload: { status: "settled" },
		};
		const first = await app.inject({
			method: "POST",
			url: "/api/replay/events",
			payload: event,
		});
		const duplicate = await app.inject({
			method: "POST",
			url: "/api/replay/events",
			payload: event,
		});
		const stored = await pool.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM event_inbox WHERE event_id = $1",
			[event.eventId],
		);

		expect(first.statusCode).toBe(202);
		expect(first.json()).toEqual({ received: true, duplicate: false });
		expect(duplicate.statusCode).toBe(200);
		expect(duplicate.json()).toEqual({ received: false, duplicate: true });
		expect(stored.rows[0]?.count).toBe("1");
	});

	it("recovers a simulated lost response on the original payout attempt", async () => {
		const job = await createDraftJob(pool, {
			title: "Lost response recovery fixture",
			gross: 2750n,
			platformFee: 250n,
			allocations: [{ contractorId: "contractor_mara", amount: 2500n }],
		});
		await approveJob(pool, job.id);
		const obligation = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const simulated = await app.inject({
			method: "POST",
			url: "/api/replay/lost-response",
			payload: { obligationId: obligation.rows[0]?.id },
		});
		const recovered = await app.inject({
			method: "POST",
			url: `/api/payout-attempts/${simulated.json().attemptId}/recover`,
		});
		const attempt = await pool.query<{
			status: string;
			provider_transfer_id: string;
			idempotency_key: string;
		}>(
			"SELECT status, provider_transfer_id, idempotency_key FROM payout_attempts WHERE id = $1",
			[simulated.json().attemptId],
		);
		const journals = await pool.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM ledger_journals WHERE source_type = 'payout_submitted' AND source_id = $1",
			[simulated.json().attemptId],
		);

		expect(simulated.statusCode).toBe(201);
		expect(recovered.statusCode).toBe(200);
		expect(recovered.json().status).toBe("submitted");
		expect(attempt.rows[0]).toMatchObject({
			status: "submitted",
			provider_transfer_id: `replay_${simulated.json().attemptId}`,
		});
		expect(attempt.rows[0]?.idempotency_key).toBeTruthy();
		expect(journals.rows[0]?.count).toBe("1");
	});

	it("classifies matched, returned, mismatched, and duplicate report rows", async () => {
		async function createReplayPayout(
			title: string,
			amount: bigint,
			outcome: "settled" | "returned",
		): Promise<string> {
			const job = await createDraftJob(pool, {
				title,
				gross: amount + 100n,
				platformFee: 100n,
				allocations: [{ contractorId: "contractor_mara", amount }],
			});
			await approveJob(pool, job.id);
			const obligation = await pool.query<{ id: string }>(
				"SELECT id FROM obligations WHERE job_id = $1",
				[job.id],
			);
			const batch = await createPayoutBatch(pool, [
				obligation.rows[0]?.id ?? "",
			]);
			await submitPayoutBatch(pool, batch.id, { mode: "replay", outcome });
			return `replay_${batch.attempts[0]?.id}`;
		}

		const matchedId = await createReplayPayout(
			"Report matched payout",
			2500n,
			"settled",
		);
		const returnedId = await createReplayPayout(
			"Report returned payout",
			1500n,
			"returned",
		);
		const mismatchId = await createReplayPayout(
			"Report mismatch payout",
			2000n,
			"settled",
		);
		const reportRows = [
			{
				effective_at: "2026-10-27T16:10:00Z",
				bank_account_id: "bacc_demo",
				transaction_id: matchedId,
				transaction_type: "ach.outgoing_transfer.settled",
				currency: "USD",
				available_amount: -2500,
			},
			{
				effective_at: "2026-10-27T16:11:00Z",
				bank_account_id: "bacc_demo",
				transaction_id: returnedId,
				transaction_type: "ach.outgoing_transfer.returned",
				currency: "USD",
				available_amount: -1500,
			},
			{
				effective_at: "2026-10-27T16:12:00Z",
				bank_account_id: "bacc_demo",
				transaction_id: mismatchId,
				transaction_type: "ach.outgoing_transfer.settled",
				currency: "USD",
				available_amount: -1999,
			},
			{
				effective_at: "2026-10-27T16:13:00Z",
				bank_account_id: "bacc_demo",
				transaction_id: "acht_duplicate_1",
				transaction_type: "ach.incoming_transfer.settled",
				currency: "USD",
				available_amount: 500,
			},
			{
				effective_at: "2026-10-27T16:13:00Z",
				bank_account_id: "bacc_demo",
				transaction_id: "acht_duplicate_1",
				transaction_type: "ach.incoming_transfer.settled",
				currency: "USD",
				available_amount: 500,
			},
		];
		await app.inject({
			method: "POST",
			url: "/api/reconciliation/reports",
			payload: { reportId: "report_classifications", rows: reportRows },
		});
		const result = await app.inject({
			method: "GET",
			url: "/api/reconciliation?reportId=report_classifications",
		});
		const classifications = result
			.json()
			.findings.map(
				(finding: { classification: string }) => finding.classification,
			);

		expect(classifications).toEqual(
			expect.arrayContaining([
				"matched",
				"returned",
				"amount_mismatch",
				"duplicate_report_transaction",
				"untracked_transaction",
			]),
		);
	});

	it("simulates a provider settlement without a ledger journal for reconciliation", async () => {
		const job = await createDraftJob(pool, {
			title: "Missing ledger fixture",
			gross: 2750n,
			platformFee: 250n,
			allocations: [{ contractorId: "contractor_mara", amount: 2500n }],
		});
		await approveJob(pool, job.id);
		const obligation = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const simulated = await app.inject({
			method: "POST",
			url: "/api/replay/missing-ledger",
			payload: { obligationId: obligation.rows[0]?.id },
		});
		const attemptId = simulated.json().attemptId as string;
		const transferId = simulated.json().providerTransferId as string;
		const journal = await pool.query(
			"SELECT id FROM ledger_journals WHERE source_id = $1",
			[attemptId],
		);
		await app.inject({
			method: "POST",
			url: "/api/reconciliation/reports",
			payload: {
				reportId: "report_missing_ledger_scenario",
				rows: [
					{
						effective_at: "2026-10-27T16:10:00Z",
						bank_account_id: "bacc_demo",
						transaction_id: transferId,
						transaction_type: "ach.outgoing_transfer.settled",
						currency: "USD",
						available_amount: -2500,
					},
				],
			},
		});
		const result = await app.inject({
			method: "GET",
			url: "/api/reconciliation?reportId=report_missing_ledger_scenario",
		});

		expect(simulated.statusCode).toBe(201);
		expect(journal.rowCount).toBe(0);
		expect(result.json().findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					transactionId: transferId,
					classification: "missing_ledger_entry",
				}),
			]),
		);
	});

	it("rebuilds a missing settlement ledger posting once without another payout", async () => {
		const { attemptId, transferId, obligationId } =
			await prepareMissingLedgerReport("report_repair_success", [
				{
					transaction_type: "ach.outgoing_transfer.settled",
					available_amount: -2500,
				},
			]);
		const bankCashBefore = await pool.query<{ balance: string }>(
			"SELECT sum(debit_minor - credit_minor)::text AS balance FROM ledger_entries WHERE account = 'bank_cash'",
		);
		const repairs = await Promise.all([
			app.inject({
				method: "POST",
				url: "/api/reconciliation/repairs",
				payload: { reportId: "report_repair_success", rowNumber: 1 },
			}),
			app.inject({
				method: "POST",
				url: "/api/reconciliation/repairs",
				payload: { reportId: "report_repair_success", rowNumber: 1 },
			}),
		]);
		const journals = await pool.query<{ source_type: string; count: string }>(
			`SELECT source_type, count(*)::text AS count FROM ledger_journals
			 WHERE source_id = $1 GROUP BY source_type ORDER BY source_type`,
			[attemptId],
		);
		const bankCashAfter = await pool.query<{ balance: string }>(
			"SELECT sum(debit_minor - credit_minor)::text AS balance FROM ledger_entries WHERE account = 'bank_cash'",
		);
		const attemptCount = await pool.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM payout_attempts WHERE obligation_id = $1",
			[obligationId],
		);
		const reconciliation = await app.inject({
			method: "GET",
			url: "/api/reconciliation?reportId=report_repair_success",
		});

		expect(repairs.map((repair) => repair.statusCode)).toEqual([200, 200]);
		expect(repairs.map((repair) => repair.json().repaired).sort()).toEqual([
			false,
			true,
		]);
		expect(repairs.find((repair) => repair.json().repaired)?.json()).toEqual({
			repaired: true,
			transferId,
		});
		expect(repairs.find((repair) => !repair.json().repaired)?.json()).toEqual({
			repaired: false,
			alreadyRepaired: true,
			transferId,
		});
		expect(journals.rows).toEqual([
			{ source_type: "payout_settled", count: "1" },
			{ source_type: "payout_submitted", count: "1" },
		]);
		expect(
			BigInt(bankCashBefore.rows[0]?.balance ?? "0") -
				BigInt(bankCashAfter.rows[0]?.balance ?? "0"),
		).toBe(2500n);
		expect(attemptCount.rows[0]?.count).toBe("1");
		expect(providerCalls).toBe(0);
		expect(reconciliation.json().findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					transactionId: transferId,
					classification: "matched",
				}),
			]),
		);
	});

	it("rejects ledger repair when report amount differs from payout", async () => {
		await expectRejectedLedgerRepair("report_repair_wrong_amount", [
			{
				transaction_type: "ach.outgoing_transfer.settled",
				available_amount: -2499,
			},
		]);
	});

	it("rebuilds the settlement posting when the app still marks the payout submitted", async () => {
		const job = await createDraftJob(pool, {
			title: "Stale settlement state fixture",
			gross: 2750n,
			platformFee: 250n,
			allocations: [{ contractorId: "contractor_mara", amount: 2500n }],
		});
		await approveJob(pool, job.id);
		const obligation = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const obligationId = obligation.rows[0]?.id ?? "";
		const batch = await createPayoutBatch(pool, [obligationId]);
		const attemptId = batch.attempts[0]?.id ?? "";
		const transferId = `replay_${attemptId}`;
		await submitPayoutBatch(pool, batch.id, { mode: "replay" });
		await app.inject({
			method: "POST",
			url: "/api/reconciliation/reports",
			payload: {
				reportId: "report_stale_settlement_state",
				rows: [
					{
						effective_at: "2026-10-27T16:10:00Z",
						bank_account_id: "bacc_demo",
						transaction_id: transferId,
						transaction_type: "ach.outgoing_transfer.settled",
						currency: "USD",
						available_amount: -2500,
					},
				],
			},
		});
		const before = await pool.query<{ balance: string }>(
			"SELECT sum(debit_minor - credit_minor)::text AS balance FROM ledger_entries WHERE account = 'bank_cash'",
		);
		const findings = await app.inject({
			method: "GET",
			url: "/api/reconciliation?reportId=report_stale_settlement_state",
		});
		const repair = await app.inject({
			method: "POST",
			url: "/api/reconciliation/repairs",
			payload: {
				reportId: "report_stale_settlement_state",
				rowNumber: 1,
			},
		});
		const attempt = await pool.query<{ status: string }>(
			"SELECT status FROM payout_attempts WHERE id = $1",
			[attemptId],
		);
		const settlementJournal = await pool.query(
			`SELECT id FROM ledger_journals
			 WHERE source_type = 'payout_settled' AND source_id = $1`,
			[attemptId],
		);
		const after = await pool.query<{ balance: string }>(
			"SELECT sum(debit_minor - credit_minor)::text AS balance FROM ledger_entries WHERE account = 'bank_cash'",
		);
		const attempts = await pool.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM payout_attempts WHERE obligation_id = $1",
			[obligationId],
		);

		expect(
			findings
				.json()
				.findings.find(
					(finding: { transactionId: string }) =>
						finding.transactionId === transferId,
				).classification,
		).toBe("missing_ledger_entry");
		expect(repair.statusCode).toBe(200);
		expect(attempt.rows[0]?.status).toBe("settled");
		expect(settlementJournal.rowCount).toBe(1);
		expect(
			BigInt(before.rows[0]?.balance ?? "0") -
				BigInt(after.rows[0]?.balance ?? "0"),
		).toBe(2500n);
		expect(attempts.rows[0]?.count).toBe("1");
	});

	it("rejects ledger repair when the report contains duplicate transfer rows", async () => {
		await expectRejectedLedgerRepair("report_repair_duplicate", [
			{
				transaction_type: "ach.outgoing_transfer.settled",
				available_amount: -2500,
			},
			{
				transaction_type: "ach.outgoing_transfer.settled",
				available_amount: -2500,
			},
		]);
	});

	it("rejects ledger repair for a returned transfer", async () => {
		await expectRejectedLedgerRepair("report_repair_returned", [
			{
				transaction_type: "ach.outgoing_transfer.returned",
				available_amount: -2500,
			},
		]);
	});
});
