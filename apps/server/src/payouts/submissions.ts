import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { createBalancedJournal } from "@money-trace/domain";
import {
	ColumnApiError,
	createAchTransfer,
	getAchTransfer,
	type ColumnAchTransferRequest,
} from "../providers/column";
import {
	createPayoutBatch,
	refreshBatchStatus,
	resolvePayoutAttempt,
} from "./store";

interface QueuedAttempt {
	id: string;
	obligation_id: string;
	amount_minor: string;
	idempotency_key: string;
	contractor_name: string;
	column_counterparty_id: string | null;
	job_title: string;
	provider_request: StoredColumnRequest | null;
	unknown_since: string | null;
}

interface StoredColumnRequest extends Omit<ColumnAchTransferRequest, "amount"> {
	amount: string;
}

export interface SubmitPayoutOptions {
	mode: "replay" | "column";
	outcome?: "settled" | "returned" | undefined;
	columnApiKey?: string | undefined;
	columnBankAccountId?: string | undefined;
	fetcher?: typeof fetch | undefined;
}

export interface SyncPayoutOptions {
	apiKey: string;
	fetcher?: typeof fetch | undefined;
}

export async function submitPayoutBatch(
	pool: Pool,
	batchId: string,
	options: SubmitPayoutOptions,
): Promise<void> {
	const queued = await pool.query<QueuedAttempt>(
		`SELECT pa.id, pa.obligation_id, pa.amount_minor, pa.idempotency_key,
		        pa.provider_request, pa.unknown_since,
		        c.name AS contractor_name, c.column_counterparty_id, j.title AS job_title
		 FROM payout_attempts pa
		 JOIN obligations o ON o.id = pa.obligation_id
		 JOIN contractors c ON c.id = o.contractor_id
		 JOIN jobs j ON j.id = o.job_id
		 WHERE pa.batch_id = $1 AND pa.status = 'queued'
		 ORDER BY pa.created_at, pa.id`,
		[batchId],
	);
	for (const attempt of queued.rows) {
		await submitAttempt(pool, attempt, options);
	}
	await refreshBatchStatus(pool, batchId);
}

async function submitAttempt(
	pool: Pool,
	attempt: QueuedAttempt,
	options: SubmitPayoutOptions,
	claimed = false,
): Promise<void> {
	const requestStatus = claimed ? "unknown" : "queued";
	let providerRequest: StoredColumnRequest | null = null;
	try {
		if (options.mode === "column") {
			providerRequest =
				attempt.provider_request ??
				toStoredRequest(buildProviderRequest(attempt, options));
		}
	} catch (error) {
		await recordSubmissionFailure(pool, attempt, error, false);
		return;
	}
	const claim = await pool.query<{
		provider_request: StoredColumnRequest | null;
	}>(
		`UPDATE payout_attempts
		 SET status = 'submitting', provider_request = COALESCE(provider_request, $3::jsonb),
		     updated_at = now()
		 WHERE id = $1 AND status = $2
		 RETURNING provider_request`,
		[
			attempt.id,
			requestStatus,
			providerRequest ? JSON.stringify(providerRequest) : null,
		],
	);
	if (claim.rowCount !== 1) return;
	const claimedAttempt = {
		...attempt,
		provider_request: claim.rows[0]?.provider_request ?? providerRequest,
	};
	let providerRequestStarted = false;
	try {
		const transfer = await createTransfer(claimedAttempt, options, () => {
			providerRequestStarted = true;
		});
		await recordPayoutSubmission(
			pool,
			claimedAttempt,
			transfer.id,
			transfer.status,
		);
		if (options.mode === "replay" && options.outcome) {
			await resolvePayoutAttempt(pool, claimedAttempt.id, options.outcome);
		}
	} catch (error) {
		await recordSubmissionFailure(
			pool,
			claimedAttempt,
			error,
			providerRequestStarted,
		);
	}
}

export async function retryUnknownPayoutAttempt(
	pool: Pool,
	attemptId: string,
	options: SubmitPayoutOptions,
): Promise<string> {
	const selected = await pool.query<QueuedAttempt & { status: string }>(
		`SELECT pa.id, pa.obligation_id, pa.amount_minor, pa.idempotency_key,
		        pa.status, pa.provider_request, pa.unknown_since,
	        c.name AS contractor_name, c.column_counterparty_id,
		        j.title AS job_title
		 FROM payout_attempts pa
		 JOIN obligations o ON o.id = pa.obligation_id
		 JOIN contractors c ON c.id = o.contractor_id
		 JOIN jobs j ON j.id = o.job_id
		 WHERE pa.id = $1`,
		[attemptId],
	);
	const attempt = selected.rows[0];
	if (!attempt) throw new Error("Payout attempt not found.");
	if (attempt.status !== "unknown") {
		throw new Error(
			"Only payouts with an unknown provider response can recover.",
		);
	}
	const unknownSince = attempt.unknown_since;
	if (
		options.mode === "column" &&
		(!attempt.provider_request || !unknownSince)
	) {
		throw new Error(
			"This attempt has no immutable provider request evidence; inspect it manually.",
		);
	}
	if (
		options.mode === "column" &&
		Date.now() - Date.parse(unknownSince ?? "") >= 30 * 24 * 60 * 60 * 1000
	) {
		throw new Error(
			"Column's idempotency safety window may have expired; inspect the transfer manually.",
		);
	}
	await submitAttempt(pool, attempt, options, true);
	const latest = await pool.query<{ status: string; batch_id: string }>(
		"SELECT status, batch_id FROM payout_attempts WHERE id = $1",
		[attemptId],
	);
	const row = latest.rows[0];
	if (row) await refreshBatchStatus(pool, row.batch_id);
	return row?.status ?? "unknown";
}

export async function simulateLostProviderResponse(
	pool: Pool,
	obligationId: string,
): Promise<{ batchId: string; attemptId: string; providerTransferId: string }> {
	const batch = await createPayoutBatch(pool, [obligationId]);
	const attempt = batch.attempts[0];
	if (!attempt) throw new Error("Could not create the simulated payout.");
	const providerTransferId = `replay_${attempt.id}`;
	await pool.query(
		`UPDATE payout_attempts SET status = 'unknown', provider_status = 'initiated',
		 provider_transfer_id = $2,
		 error_message = 'Simulated provider response was lost.' WHERE id = $1`,
		[attempt.id, providerTransferId],
	);
	await refreshBatchStatus(pool, batch.id);
	return { batchId: batch.id, attemptId: attempt.id, providerTransferId };
}

export async function simulateMissingLedgerEntry(
	pool: Pool,
	obligationId: string,
): Promise<{ batchId: string; attemptId: string; providerTransferId: string }> {
	const batch = await createPayoutBatch(pool, [obligationId]);
	const attempt = batch.attempts[0];
	if (!attempt) throw new Error("Could not create the simulated payout.");
	const providerTransferId = `replay_missing_ledger_${attempt.id}`;
	await pool.query(
		`UPDATE payout_attempts SET status = 'settled', provider_transfer_id = $2,
		 error_message = 'Replay scenario: provider settled without a ledger posting.'
		 WHERE id = $1`,
		[attempt.id, providerTransferId],
	);
	await pool.query("UPDATE obligations SET status = 'paid' WHERE id = $1", [
		obligationId,
	]);
	await refreshBatchStatus(pool, batch.id);
	return { batchId: batch.id, attemptId: attempt.id, providerTransferId };
}

async function createTransfer(
	attempt: QueuedAttempt,
	options: SubmitPayoutOptions,
	markProviderRequestStarted: () => void,
): Promise<{ id: string; status: string }> {
	if (options.mode === "replay") {
		return { id: `replay_${attempt.id}`, status: "initiated" };
	}
	if (!options.columnApiKey || !options.columnBankAccountId) {
		throw new Error("Column sandbox API key and bank account ID are required.");
	}
	if (!attempt.provider_request) {
		throw new Error("This payout has no immutable Column request to submit.");
	}
	markProviderRequestStarted();
	return createAchTransfer(
		{
			...attempt.provider_request,
			amount: BigInt(attempt.provider_request.amount),
			apiKey: options.columnApiKey,
		},
		options.fetcher,
	);
}

function buildProviderRequest(
	attempt: QueuedAttempt,
	options: SubmitPayoutOptions,
): ColumnAchTransferRequest {
	if (!options.columnBankAccountId) {
		throw new Error("Column sandbox bank account ID is required.");
	}
	if (!attempt.column_counterparty_id) {
		throw new Error(
			`${attempt.contractor_name} needs a Column counterparty ID.`,
		);
	}
	return {
		bankAccountId: options.columnBankAccountId,
		counterpartyId: attempt.column_counterparty_id,
		amount: BigInt(attempt.amount_minor),
		description: `Payout: ${attempt.job_title}`.slice(0, 255),
		idempotencyKey: attempt.idempotency_key,
	};
}

function toStoredRequest(
	request: ColumnAchTransferRequest,
): StoredColumnRequest {
	return { ...request, amount: request.amount.toString() };
}

async function recordSubmissionFailure(
	pool: Pool,
	attempt: QueuedAttempt,
	error: unknown,
	providerRequestStarted: boolean,
): Promise<void> {
	const message =
		error instanceof Error ? error.message : "Provider outcome is unknown.";
	const unknown = providerRequestStarted && !(error instanceof ColumnApiError);
	await pool.query(
		`UPDATE payout_attempts SET status = $2, error_message = $3,
		 unknown_since = CASE WHEN $2 = 'unknown' THEN COALESCE(unknown_since, now()) ELSE unknown_since END,
		 updated_at = now()
		 WHERE id = $1`,
		[attempt.id, unknown ? "unknown" : "failed", message],
	);
	if (!unknown) {
		await pool.query("UPDATE obligations SET status = 'due' WHERE id = $1", [
			attempt.obligation_id,
		]);
	}
}

async function recordPayoutSubmission(
	pool: Pool,
	attempt: Pick<QueuedAttempt, "id" | "obligation_id" | "amount_minor">,
	transferId: string,
	providerStatus: string,
): Promise<void> {
	const client = await pool.connect();
	const amount = BigInt(attempt.amount_minor);
	const journalId = randomUUID();
	const journal = createBalancedJournal({
		sourceType: "payout_submitted",
		sourceId: attempt.id,
		lines: [
			{ account: "contractor_payable", debit: amount, credit: 0n },
			{ account: "money_in_transit", debit: 0n, credit: amount },
		],
	});

	try {
		await client.query("BEGIN");
		await client.query(
			`INSERT INTO ledger_journals (id, source_type, source_id)
			 VALUES ($1, $2, $3)`,
			[journalId, journal.sourceType, journal.sourceId],
		);
		await client.query(
			`INSERT INTO ledger_entries
			   (journal_id, account, debit_minor, credit_minor, obligation_id)
			 VALUES ($1, 'contractor_payable', $2, 0, $3),
			        ($1, 'money_in_transit', 0, $2, NULL)`,
			[journalId, amount.toString(), attempt.obligation_id],
		);
		await client.query(
			`UPDATE payout_attempts
			 SET status = 'submitted', provider_status = $3,
			     provider_transfer_id = $2, updated_at = now()
			 WHERE id = $1 AND status = 'submitting'`,
			[attempt.id, transferId, providerStatus],
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function syncPayoutBatch(
	pool: Pool,
	batchId: string,
	options: SyncPayoutOptions,
): Promise<{ settled: number; returned: number; pending: number }> {
	const attempts = await pool.query<{
		id: string;
		provider_transfer_id: string | null;
	}>(
		`SELECT id, provider_transfer_id FROM payout_attempts
		 WHERE batch_id = $1 AND status IN ('initiated', 'submitted', 'settled')
		   AND provider_status IS DISTINCT FROM 'completed'
		 ORDER BY created_at, id`,
		[batchId],
	);
	const result = { settled: 0, returned: 0, pending: 0 };
	for (const attempt of attempts.rows) {
		if (!attempt.provider_transfer_id) {
			result.pending += 1;
			continue;
		}
		const transfer = await getAchTransfer(
			options.apiKey,
			attempt.provider_transfer_id,
			options.fetcher,
		);
		const status = transfer.status.toLowerCase();
		await pool.query(
			"UPDATE payout_attempts SET provider_status = $2, updated_at = now() WHERE id = $1",
			[attempt.id, status],
		);
		if (status === "settled" || status === "completed") {
			await resolvePayoutAttempt(pool, attempt.id, "settled");
			result.settled += 1;
		} else if (status === "returned" || status === "canceled") {
			await resolvePayoutAttempt(
				pool,
				attempt.id,
				"returned",
				transfer.returnCode ?? (status === "canceled" ? "CANCELED" : undefined),
			);
			result.returned += 1;
		} else {
			result.pending += 1;
		}
	}
	await refreshBatchStatus(pool, batchId);
	return result;
}
