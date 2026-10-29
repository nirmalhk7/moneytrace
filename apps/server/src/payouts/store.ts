import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { createBalancedJournal } from "@money-trace/domain";

interface ObligationRow {
	id: string;
	amount_minor: string;
	contractor_id: string;
}

interface AttemptRow {
	id: string;
	obligation_id: string;
	amount_minor: string;
	idempotency_key: string;
	status: string;
}

export interface PayoutAttemptRecord {
	id: string;
	obligationId: string;
	amount: bigint;
	idempotencyKey: string;
	status: string;
}

export interface PayoutBatchRecord {
	id: string;
	status: string;
	attempts: PayoutAttemptRecord[];
}

interface PayoutAttemptForResolution {
	batch_id: string;
	obligation_id: string;
	amount_minor: string;
	status: string;
}

function createPayoutResolutionJournal(
	attemptId: string,
	row: PayoutAttemptForResolution,
	result: "settled" | "returned",
) {
	const lateReturn = result === "returned" && row.status === "settled";
	if (row.status !== "submitted" && !lateReturn) {
		throw new Error(
			"Only submitted payouts can be settled or settled payouts returned.",
		);
	}

	const amount = BigInt(row.amount_minor);
	const debitAccount = lateReturn ? "bank_cash" : "money_in_transit";
	const creditAccount =
		result === "settled" ? "bank_cash" : "contractor_payable";
	return createBalancedJournal({
		sourceType: result === "settled" ? "payout_settled" : "payout_returned",
		sourceId: attemptId,
		lines: [
			{ account: debitAccount, debit: amount, credit: 0n },
			{ account: creditAccount, debit: 0n, credit: amount },
		],
	});
}

async function recordPayoutResolution(
	client: PoolClient,
	attemptId: string,
	row: PayoutAttemptForResolution,
	result: "settled" | "returned",
	returnCode?: string,
): Promise<void> {
	const amount = BigInt(row.amount_minor);
	const journalId = randomUUID();
	const journal = createPayoutResolutionJournal(attemptId, row, result);
	await client.query(
		`INSERT INTO ledger_journals (id, source_type, source_id)
		 VALUES ($1, $2, $3)`,
		[journalId, journal.sourceType, journal.sourceId],
	);
	await client.query(
		`INSERT INTO ledger_entries
		   (journal_id, account, debit_minor, credit_minor, obligation_id)
		   VALUES ($1, $3, $2, 0, $5),
		        ($1, $4, 0, $2, $6)`,
		[
			journalId,
			amount.toString(),
			journal.lines[0]?.account,
			journal.lines[1]?.account,
			null,
			result === "settled" ? null : row.obligation_id,
		],
	);
	await client.query(
		`UPDATE payout_attempts SET status = $2, return_code = $3, updated_at = now()
		 WHERE id = $1`,
		[attemptId, result, result === "returned" ? (returnCode ?? "R01") : null],
	);
	await client.query("UPDATE obligations SET status = $2 WHERE id = $1", [
		row.obligation_id,
		result === "settled" ? "paid" : "due",
	]);
}

export async function createPayoutBatch(
	pool: Pool,
	obligationIds: readonly string[],
): Promise<PayoutBatchRecord> {
	if (obligationIds.length === 0) {
		throw new Error("Select at least one contractor obligation.");
	}

	if (new Set(obligationIds).size !== obligationIds.length) {
		throw new Error("An obligation can appear only once in a payout batch.");
	}

	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtext('money-trace:bank-cash'))",
		);

		const obligations = await client.query<ObligationRow>(
			`SELECT id, amount_minor, contractor_id FROM obligations
       WHERE id = ANY($1::uuid[]) AND status = 'due'
       ORDER BY id FOR UPDATE`,
			[obligationIds],
		);

		if (obligations.rowCount !== obligationIds.length) {
			throw new Error("Every selected obligation must be due.");
		}

		const requested = obligations.rows.reduce(
			(sum, obligation) => sum + BigInt(obligation.amount_minor),
			0n,
		);
		const bankCash = await client.query<{ balance: string }>(
			`SELECT COALESCE(sum(debit_minor - credit_minor), 0)::text AS balance
       FROM ledger_entries WHERE account = 'bank_cash'`,
		);
		const reserved = await client.query<{ amount: string }>(
			`SELECT COALESCE(sum(amount_minor), 0)::text AS amount
       FROM payout_attempts WHERE status IN ('queued', 'submitting', 'unknown', 'initiated', 'submitted')`,
		);
		const available =
			BigInt(bankCash.rows[0]?.balance ?? "0") -
			BigInt(reserved.rows[0]?.amount ?? "0");

		if (requested > available) {
			throw new Error("Insufficient available bank cash.");
		}

		const batchId = randomUUID();
		await client.query(
			`INSERT INTO payout_batches (id, status, created_by)
       VALUES ($1, 'queued', 'local-operator')`,
			[batchId],
		);

		const attempts: PayoutAttemptRecord[] = [];

		for (const obligation of obligations.rows) {
			const previousAttempts = await client.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM payout_attempts WHERE obligation_id = $1",
				[obligation.id],
			);
			const attemptNumber = Number(previousAttempts.rows[0]?.count ?? "0") + 1;
			const attempt: AttemptRow = {
				id: randomUUID(),
				obligation_id: obligation.id,
				amount_minor: obligation.amount_minor,
				idempotency_key: randomUUID(),
				status: "queued",
			};

			await client.query(
				`INSERT INTO payout_attempts
           (id, batch_id, obligation_id, attempt_number, amount_minor, idempotency_key, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued')`,
				[
					attempt.id,
					batchId,
					obligation.id,
					attemptNumber,
					obligation.amount_minor,
					attempt.idempotency_key,
				],
			);
			await client.query(
				"UPDATE obligations SET status = 'in_progress' WHERE id = $1",
				[obligation.id],
			);
			attempts.push({
				id: attempt.id,
				obligationId: attempt.obligation_id,
				amount: BigInt(attempt.amount_minor),
				idempotencyKey: attempt.idempotency_key,
				status: attempt.status,
			});
		}

		await client.query("COMMIT");
		return { id: batchId, status: "queued", attempts };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function resolvePayoutAttempt(
	pool: Pool,
	attemptId: string,
	result: "settled" | "returned",
	returnCode?: string | undefined,
): Promise<void> {
	const client = await pool.connect();
	let batchId: string | undefined;
	try {
		await client.query("BEGIN");
		const attempt = await client.query<PayoutAttemptForResolution>(
			`SELECT batch_id, obligation_id, amount_minor, status
			 FROM payout_attempts WHERE id = $1 FOR UPDATE`,
			[attemptId],
		);
		const row = attempt.rows[0];
		if (!row) {
			throw new Error("Payout attempt not found.");
		}
		batchId = row.batch_id;
		if (row.status !== result) {
			await recordPayoutResolution(client, attemptId, row, result, returnCode);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
	if (batchId) await refreshBatchStatus(pool, batchId);
}

export async function refreshBatchStatus(
	pool: Pool,
	batchId: string,
): Promise<void> {
	await pool.query(
		`UPDATE payout_batches SET status = CASE
		   WHEN EXISTS (
		     SELECT 1 FROM payout_attempts
		     WHERE batch_id = $1 AND status IN ('queued', 'submitting', 'unknown', 'initiated', 'submitted')
		   ) THEN 'processing'
		   WHEN NOT EXISTS (
		     SELECT 1 FROM payout_attempts WHERE batch_id = $1 AND status <> 'settled'
		   ) THEN 'completed'
		   ELSE 'partially_failed'
		 END WHERE id = $1`,
		[batchId],
	);
}
