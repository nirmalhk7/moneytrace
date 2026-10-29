import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { migrate } from "../src/database/migrate";
import { approveJob, createDraftJob } from "../src/jobs/store";
import { createPayoutBatch, resolvePayoutAttempt } from "../src/payouts/store";
import {
	retryUnknownPayoutAttempt,
	submitPayoutBatch,
	syncPayoutBatch,
} from "../src/payouts/submissions";
import { createIsolatedTestPool } from "./test-pool";

let pool: Pool;
let cleanup: () => Promise<void>;

describe("payout batch creation", () => {
	beforeAll(async () => {
		const isolated = await createIsolatedTestPool();
		pool = isolated.pool;
		cleanup = isolated.cleanup;
		await migrate(pool);
	});

	afterAll(async () => {
		await cleanup();
	});

	async function createDueObligation(
		amount = 2500n,
		platformFee = 0n,
		titlePrefix = "Payout test",
		connectionPool = pool,
	): Promise<string> {
		const job = await createDraftJob(connectionPool, {
			title: `${titlePrefix} ${randomUUID()}`,
			gross: amount + platformFee,
			platformFee,
			allocations: [{ contractorId: "contractor_mara", amount }],
		});
		await approveJob(connectionPool, job.id);
		const result = await connectionPool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);

		return result.rows[0]?.id ?? "missing-obligation";
	}

	it("queues one full obligation and marks it in progress", async () => {
		const obligationId = await createDueObligation();
		const batch = await createPayoutBatch(pool, [obligationId]);
		const state = await pool.query<{ status: string }>(
			"SELECT status FROM obligations WHERE id = $1",
			[obligationId],
		);

		expect(batch.status).toBe("queued");
		expect(batch.attempts).toHaveLength(1);
		expect(batch.attempts[0]?.amount).toBe(2500n);
		expect(state.rows[0]?.status).toBe("in_progress");
	});

	it("does not create a second active payout for the same obligation", async () => {
		const obligationId = await createDueObligation();
		await createPayoutBatch(pool, [obligationId]);

		await expect(createPayoutBatch(pool, [obligationId])).rejects.toThrow(
			"Every selected obligation must be due.",
		);

		const attempts = await pool.query(
			"SELECT id FROM payout_attempts WHERE obligation_id = $1",
			[obligationId],
		);
		expect(attempts.rowCount).toBe(1);
	});

	it("leaves all obligations due if any selected obligation is not payable", async () => {
		const firstId = await createDueObligation();
		const secondId = randomUUID();

		await expect(createPayoutBatch(pool, [firstId, secondId])).rejects.toThrow(
			"Every selected obligation must be due.",
		);

		const state = await pool.query<{ status: string }>(
			"SELECT status FROM obligations WHERE id = $1",
			[firstId],
		);
		expect(state.rows[0]?.status).toBe("due");
	});

	it("reserves cash across concurrently submitted batches", async () => {
		const jobs = await Promise.all(
			Array.from({ length: 2 }, () =>
				createDueObligation(400_000n, 0n, "Cash reservation"),
			),
		);

		const withdrawalJournalId = randomUUID();
		const client = await pool.connect();

		try {
			await client.query("BEGIN");
			await client.query(
				`INSERT INTO ledger_journals (id, source_type, source_id)
         VALUES ($1, 'test_cash_withdrawal', $2)`,
				[withdrawalJournalId, withdrawalJournalId],
			);
			await client.query(
				`INSERT INTO ledger_entries
           (journal_id, account, debit_minor, credit_minor)
         VALUES ($1, 'money_in_transit', 300000, 0),
                ($1, 'bank_cash', 0, 300000)`,
				[withdrawalJournalId],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}

		const results = await Promise.allSettled(
			jobs.map((obligationId) => createPayoutBatch(pool, [obligationId])),
		);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
	});

	it("returns an obligation to due without reversing the earned platform fee", async () => {
		const job = await createDraftJob(pool, {
			title: `Returned payout ${randomUUID()}`,
			gross: 3000n,
			platformFee: 500n,
			allocations: [{ contractorId: "contractor_mara", amount: 2500n }],
		});
		await approveJob(pool, job.id);
		const obligation = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const obligationId = obligation.rows[0]?.id ?? "missing-obligation";
		const batch = await createPayoutBatch(pool, [obligationId]);

		await submitPayoutBatch(pool, batch.id, {
			mode: "replay",
			outcome: "returned",
		});

		const result = await pool.query<{
			obligation_status: string;
			attempt_status: string;
			fee_revenue: string;
		}>(
			`SELECT o.status AS obligation_status, pa.status AS attempt_status,
              (SELECT sum(credit_minor - debit_minor) FROM ledger_entries
               WHERE account = 'fee_revenue' AND journal_id IN (
                 SELECT id FROM ledger_journals
                 WHERE source_type = 'job_approved' AND source_id = $2
               ))::text AS fee_revenue
       FROM obligations o JOIN payout_attempts pa ON pa.obligation_id = o.id
       WHERE o.id = $1`,
			[obligationId, job.id],
		);

		expect(result.rows[0]).toMatchObject({
			obligation_status: "due",
			attempt_status: "returned",
			fee_revenue: "500",
		});

		const retryBatch = await createPayoutBatch(pool, [obligationId]);
		expect(retryBatch.attempts).toHaveLength(1);
		const attempts = await pool.query<{
			attempt_number: number;
			status: string;
		}>(
			`SELECT attempt_number, status FROM payout_attempts
       WHERE obligation_id = $1 ORDER BY attempt_number`,
			[obligationId],
		);
		expect(attempts.rows).toEqual([
			{ attempt_number: 1, status: "returned" },
			{ attempt_number: 2, status: "queued" },
		]);
	});

	it("settles a replay payout and permits a new attempt only after a return", async () => {
		const obligationId = await createDueObligation();
		const firstBatch = await createPayoutBatch(pool, [obligationId]);

		await submitPayoutBatch(pool, firstBatch.id, {
			mode: "replay",
			outcome: "settled",
		});

		const state = await pool.query<{ status: string }>(
			"SELECT status FROM obligations WHERE id = $1",
			[obligationId],
		);

		expect(state.rows[0]?.status).toBe("paid");
		await expect(createPayoutBatch(pool, [obligationId])).rejects.toThrow(
			"Every selected obligation must be due.",
		);
	});

	it("settles and completes a payout batch with a single database connection", async () => {
		const isolated = await createIsolatedTestPool({ max: 1 });
		try {
			await migrate(isolated.pool);
			const obligationId = await createDueObligation(
				2500n,
				0n,
				"One connection settlement",
				isolated.pool,
			);
			const batch = await createPayoutBatch(isolated.pool, [obligationId]);
			await submitPayoutBatch(isolated.pool, batch.id, {
				mode: "replay",
				outcome: "settled",
			});

			const state = await isolated.pool.query<{ status: string }>(
				"SELECT status FROM payout_batches WHERE id = $1",
				[batch.id],
			);
			expect(state.rows[0]?.status).toBe("completed");
		} finally {
			await isolated.cleanup();
		}
	}, 5000);

	it("syncs a Column return and exposes the obligation for manual retry", async () => {
		await pool.query(
			"UPDATE contractors SET column_counterparty_id = 'cpty_demo' WHERE id = 'contractor_mara'",
		);
		const obligationId = await createDueObligation();
		const batch = await createPayoutBatch(pool, [obligationId]);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "acht_demo", status: "initiated" }), {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: "acht_demo",
						status: "returned",
						return_code: "R02",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

		await submitPayoutBatch(pool, batch.id, {
			mode: "column",
			columnApiKey: "test_column_key",
			columnBankAccountId: "bacc_demo",
			fetcher,
		});
		const synced = await syncPayoutBatch(pool, batch.id, {
			apiKey: "test_column_key",
			fetcher,
		});

		const state = await pool.query<{
			obligation_status: string;
			attempt_status: string;
			return_code: string;
		}>(
			`SELECT o.status AS obligation_status, pa.status AS attempt_status, pa.return_code
			 FROM obligations o JOIN payout_attempts pa ON pa.obligation_id = o.id
			 WHERE o.id = $1`,
			[obligationId],
		);
		expect(synced).toEqual({ settled: 0, returned: 1, pending: 0 });
		expect(state.rows[0]).toEqual({
			obligation_status: "due",
			attempt_status: "returned",
			return_code: "R02",
		});
	});

	it("posts a later return after settlement and ignores repeated return evidence", async () => {
		const cashBefore = await pool.query<{ balance: string }>(
			"SELECT sum(debit_minor - credit_minor)::text AS balance FROM ledger_entries WHERE account = 'bank_cash'",
		);
		const job = await createDraftJob(pool, {
			title: `Late return ${randomUUID()}`,
			gross: 10000n,
			platformFee: 1000n,
			allocations: [{ contractorId: "contractor_mara", amount: 9000n }],
		});
		await approveJob(pool, job.id);
		const obligation = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const obligationId = obligation.rows[0]?.id ?? "missing-obligation";
		const batch = await createPayoutBatch(pool, [obligationId]);
		await submitPayoutBatch(pool, batch.id, {
			mode: "replay",
			outcome: "settled",
		});
		const attemptId = batch.attempts[0]?.id ?? "missing-attempt";

		await resolvePayoutAttempt(pool, attemptId, "returned", "R29");
		await resolvePayoutAttempt(pool, attemptId, "returned", "R29");

		const result = await pool.query<{
			attempt_status: string;
			obligation_status: string;
			cash_debit: string;
			payable_credit: string;
			fee_revenue: string;
			return_journals: string;
		}>(
			`SELECT pa.status AS attempt_status, o.status AS obligation_status,
			        (SELECT COALESCE(sum(debit_minor - credit_minor), 0)::text
			         FROM ledger_entries WHERE account = 'bank_cash') AS cash_debit,
			        (SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text
			         FROM ledger_entries WHERE account = 'contractor_payable'
			           AND obligation_id = o.id) AS payable_credit,
			        (SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text
			         FROM ledger_entries WHERE account = 'fee_revenue'
			           AND journal_id IN (SELECT id FROM ledger_journals
			             WHERE source_type = 'job_approved' AND source_id = $2)) AS fee_revenue,
			        (SELECT count(*)::text FROM ledger_journals
			         WHERE source_type = 'payout_returned' AND source_id = pa.id::text) AS return_journals
			 FROM payout_attempts pa JOIN obligations o ON o.id = pa.obligation_id
			 WHERE pa.id = $1`,
			[attemptId, job.id],
		);
		expect(result.rows[0]).toMatchObject({
			attempt_status: "returned",
			obligation_status: "due",
			cash_debit: cashBefore.rows[0]?.balance,
			payable_credit: "9000",
			fee_revenue: "1000",
			return_journals: "1",
		});
	});

	it("continues syncing settled transfers so later returns can be observed", async () => {
		await pool.query(
			"UPDATE contractors SET column_counterparty_id = 'cpty_demo' WHERE id = 'contractor_mara'",
		);
		const obligationId = await createDueObligation();
		const batch = await createPayoutBatch(pool, [obligationId]);
		const attemptId = batch.attempts[0]?.id ?? "missing-attempt";
		await pool.query(
			"UPDATE payout_attempts SET status = 'settled', provider_transfer_id = 'acht_late_return' WHERE id = $1",
			[attemptId],
		);
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: "acht_late_return",
					status: "returned",
					return_code: "R29",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const synced = await syncPayoutBatch(pool, batch.id, {
			apiKey: "test_column_key",
			fetcher,
		});
		const attempt = await pool.query<{ status: string }>(
			"SELECT status FROM payout_attempts WHERE id = $1",
			[attemptId],
		);

		expect(fetcher).toHaveBeenCalledOnce();
		expect(synced).toEqual({ settled: 0, returned: 1, pending: 0 });
		expect(attempt.rows[0]?.status).toBe("returned");
	});

	it("uses original Column transfer details when recovering an unknown request", async () => {
		await pool.query(
			"UPDATE contractors SET column_counterparty_id = 'cpty_original' WHERE id = 'contractor_mara'",
		);
		const obligationId = await createDueObligation(2500n, 0n, "Original title");
		const batch = await createPayoutBatch(pool, [obligationId]);
		const requests: URLSearchParams[] = [];
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			requests.push(new URLSearchParams(String(init?.body)));
			if (requests.length === 1) throw new Error("socket reset after send");
			return new Response(
				JSON.stringify({ id: "acht_snapshot", status: "initiated" }),
				{ status: 201, headers: { "content-type": "application/json" } },
			);
		});
		const options = {
			mode: "column" as const,
			columnApiKey: "test_column_key",
			columnBankAccountId: "bacc_demo",
			fetcher,
		};
		await submitPayoutBatch(pool, batch.id, options);
		await pool.query(
			"UPDATE contractors SET column_counterparty_id = 'cpty_changed' WHERE id = 'contractor_mara'",
		);
		await pool.query(
			"UPDATE jobs SET title = 'Changed title' WHERE id = (SELECT job_id FROM obligations WHERE id = $1)",
			[obligationId],
		);
		await retryUnknownPayoutAttempt(pool, batch.attempts[0]?.id ?? "", options);

		expect(requests).toHaveLength(2);
		expect([...(requests[1]?.entries() ?? [])].sort()).toEqual(
			[...(requests[0]?.entries() ?? [])].sort(),
		);
		expect(requests[1]?.get("counterparty_id")).toBe("cpty_original");
		expect(requests[1]?.get("description")).toBe(
			requests[0]?.get("description"),
		);
	});

	it("prevents parallel submitters from sending a transfer twice", async () => {
		const obligationId = await createDueObligation();
		const batch = await createPayoutBatch(pool, [obligationId]);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ id: "acht_claimed", status: "initiated" }),
					{ status: 201, headers: { "content-type": "application/json" } },
				),
			);
		const options = {
			mode: "column" as const,
			columnApiKey: "test_column_key",
			columnBankAccountId: "bacc_demo",
			fetcher,
		};

		await Promise.all([
			submitPayoutBatch(pool, batch.id, options),
			submitPayoutBatch(pool, batch.id, options),
		]);

		expect(fetcher).toHaveBeenCalledOnce();
		expect(
			(
				await pool.query(
					"SELECT id FROM ledger_journals WHERE source_type = 'payout_submitted' AND source_id = $1",
					[batch.attempts[0]?.id],
				)
			).rowCount,
		).toBe(1);
	});

	it("recovers an unknown response with the same attempt and idempotency key", async () => {
		await pool.query(
			"UPDATE contractors SET column_counterparty_id = 'cpty_demo' WHERE id = 'contractor_mara'",
		);
		const obligationId = await createDueObligation();
		const batch = await createPayoutBatch(pool, [obligationId]);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error("socket reset after send"))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ id: "acht_recovered", status: "initiated" }),
					{
						status: 201,
						headers: { "content-type": "application/json" },
					},
				),
			);
		const options = {
			mode: "column" as const,
			columnApiKey: "test_column_key",
			columnBankAccountId: "bacc_demo",
			fetcher,
		};
		await submitPayoutBatch(pool, batch.id, options);
		await retryUnknownPayoutAttempt(pool, batch.attempts[0]?.id ?? "", options);

		const attempt = await pool.query<{
			id: string;
			status: string;
			provider_transfer_id: string;
			idempotency_key: string;
		}>(
			"SELECT id, status, provider_transfer_id, idempotency_key FROM payout_attempts WHERE id = $1",
			[batch.attempts[0]?.id],
		);
		const attemptKey = fetcher.mock.calls.map((call) =>
			new Headers(call[1]?.headers).get("Idempotency-Key"),
		);
		const count = await pool.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM payout_attempts WHERE obligation_id = $1",
			[obligationId],
		);

		expect(attempt.rows[0]).toMatchObject({
			id: batch.attempts[0]?.id,
			status: "submitted",
			provider_transfer_id: "acht_recovered",
		});
		expect(attemptKey).toEqual([
			attempt.rows[0]?.idempotency_key,
			attempt.rows[0]?.idempotency_key,
		]);
		expect(count.rows[0]?.count).toBe("1");
	});

	it("blocks automatic recovery when Column's idempotency window may have expired", async () => {
		await pool.query(
			"UPDATE contractors SET column_counterparty_id = 'cpty_demo' WHERE id = 'contractor_mara'",
		);
		const obligationId = await createDueObligation();
		const batch = await createPayoutBatch(pool, [obligationId]);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("socket reset after send"));
		const options = {
			mode: "column" as const,
			columnApiKey: "test_column_key",
			columnBankAccountId: "bacc_demo",
			fetcher,
		};
		await submitPayoutBatch(pool, batch.id, options);
		await pool.query(
			"UPDATE payout_attempts SET unknown_since = now() - interval '31 days' WHERE id = $1",
			[batch.attempts[0]?.id],
		);

		await expect(
			retryUnknownPayoutAttempt(pool, batch.attempts[0]?.id ?? "", options),
		).rejects.toThrow("Column's idempotency safety window may have expired");
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("blocks Column recovery when old unknown attempt has no request snapshot", async () => {
		const obligationId = await createDueObligation();
		const batch = await createPayoutBatch(pool, [obligationId]);
		const attemptId = batch.attempts[0]?.id ?? "";
		await pool.query(
			"UPDATE payout_attempts SET status = 'unknown', unknown_since = now() WHERE id = $1",
			[attemptId],
		);
		const fetcher = vi.fn<typeof fetch>();

		await expect(
			retryUnknownPayoutAttempt(pool, attemptId, {
				mode: "column",
				columnApiKey: "test_column_key",
				columnBankAccountId: "bacc_demo",
				fetcher,
			}),
		).rejects.toThrow("no immutable provider request evidence");
		expect(fetcher).not.toHaveBeenCalled();
	});
});
