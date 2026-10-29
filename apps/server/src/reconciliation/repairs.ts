import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { createBalancedJournal } from "@money-trace/domain";
import { refreshBatchStatus } from "../payouts/store";

interface RepairEvidenceRow {
	attempt_id: string;
	batch_id: string;
	obligation_id: string;
	attempt_status: string;
	amount_minor: string;
	report_amount_minor: string;
	transaction_type: string;
	transfer_id: string;
	bank_account_id: string;
}

export async function repairSettledPayoutLedger(
	pool: Pool,
	reportId: string,
	rowNumber: number,
	expectedBankAccountId?: string | undefined,
): Promise<
	| { repaired: true; transferId: string }
	| { repaired: false; alreadyRepaired: true; transferId: string }
> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const evidence = await client.query<RepairEvidenceRow>(
			`SELECT pa.id AS attempt_id, pa.batch_id, pa.obligation_id,
			        pa.status AS attempt_status, pa.amount_minor::text,
			        sr.amount_minor::text AS report_amount_minor,
			        sr.transaction_type, sr.transfer_id, sr.bank_account_id
			 FROM settlement_reports sr
			 JOIN payout_attempts pa ON pa.provider_transfer_id = sr.transfer_id
			 JOIN obligations o ON o.id = pa.obligation_id
			 WHERE sr.report_id = $1 AND sr.row_number = $2
			 FOR UPDATE OF sr, pa, o`,
			[reportId, rowNumber],
		);
		const row = evidence.rows[0];
		if (!row) {
			throw new Error("Report row does not match a known payout attempt.");
		}

		const duplicateRows = await client.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM settlement_reports
			 WHERE report_id = $1 AND transfer_id = $2`,
			[reportId, row.transfer_id],
		);
		if (duplicateRows.rows[0]?.count !== "1") {
			throw new Error("Duplicate report rows cannot authorize ledger repair.");
		}
		if (row.transaction_type !== "ach.outgoing_transfer.settled") {
			throw new Error(
				"Only a settled outgoing ACH report row can repair the ledger.",
			);
		}
		if (!new Set(["submitted", "settled"]).has(row.attempt_status)) {
			throw new Error("Payout attempt must be submitted or settled to repair.");
		}
		if (
			expectedBankAccountId &&
			row.bank_account_id !== expectedBankAccountId
		) {
			throw new Error(
				"Report row does not match the configured Column bank account.",
			);
		}
		if (BigInt(row.report_amount_minor) !== -BigInt(row.amount_minor)) {
			throw new Error(
				"Report amount does not match the settled payout amount.",
			);
		}

		const settledJournal = await client.query<{ id: string }>(
			`SELECT id FROM ledger_journals
			 WHERE source_type = 'payout_settled' AND source_id = $1`,
			[row.attempt_id],
		);
		if (settledJournal.rowCount) {
			await markPayoutSettled(client, row.attempt_id, row.obligation_id);
			await client.query("COMMIT");
			await refreshBatchStatus(pool, row.batch_id);
			return {
				repaired: false,
				alreadyRepaired: true,
				transferId: row.transfer_id,
			};
		}

		const amount = BigInt(row.amount_minor);
		const submittedJournal = await client.query<{ id: string }>(
			`SELECT id FROM ledger_journals
			 WHERE source_type = 'payout_submitted' AND source_id = $1`,
			[row.attempt_id],
		);
		if (!submittedJournal.rowCount) {
			await insertJournal(client, row.attempt_id, row.obligation_id, {
				sourceType: "payout_submitted",
				lines: [
					{ account: "contractor_payable", debit: amount, credit: 0n },
					{ account: "money_in_transit", debit: 0n, credit: amount },
				],
			});
		}
		await insertJournal(client, row.attempt_id, row.obligation_id, {
			sourceType: "payout_settled",
			lines: [
				{ account: "money_in_transit", debit: amount, credit: 0n },
				{ account: "bank_cash", debit: 0n, credit: amount },
			],
		});
		await markPayoutSettled(client, row.attempt_id, row.obligation_id);
		await client.query("COMMIT");
		await refreshBatchStatus(pool, row.batch_id);
		return { repaired: true, transferId: row.transfer_id };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function markPayoutSettled(
	client: PoolClient,
	attemptId: string,
	obligationId: string,
): Promise<void> {
	await client.query(
		"UPDATE payout_attempts SET status = 'settled' WHERE id = $1",
		[attemptId],
	);
	await client.query("UPDATE obligations SET status = 'paid' WHERE id = $1", [
		obligationId,
	]);
}

async function insertJournal(
	client: PoolClient,
	sourceId: string,
	obligationId: string,
	journal: {
		sourceType: string;
		lines: {
			account: "bank_cash" | "contractor_payable" | "money_in_transit";
			debit: bigint;
			credit: bigint;
		}[];
	},
): Promise<void> {
	const balanced = createBalancedJournal({ ...journal, sourceId });
	const journalId = randomUUID();
	await client.query(
		`INSERT INTO ledger_journals (id, source_type, source_id)
		 VALUES ($1, $2, $3)`,
		[journalId, balanced.sourceType, balanced.sourceId],
	);
	for (const line of balanced.lines) {
		await client.query(
			`INSERT INTO ledger_entries
			   (journal_id, account, debit_minor, credit_minor, obligation_id)
			 VALUES ($1, $2, $3, $4, $5)`,
			[
				journalId,
				line.account,
				line.debit.toString(),
				line.credit.toString(),
				line.account === "contractor_payable" ? obligationId : null,
			],
		);
	}
}
