import type { Pool } from "pg";

import {
	reconcileSettlement,
	type ExpectedTransfer,
	type ReportTransaction,
} from "@money-trace/domain";

export interface ColumnReportRow {
	effective_at: string;
	bank_account_id: string;
	transaction_id: string;
	transaction_type: string;
	currency: "USD";
	available_amount: string;
}

export async function importSettlementReport(
	pool: Pool,
	reportId: string,
	rows: readonly ColumnReportRow[],
): Promise<number> {
	const client = await pool.connect();
	let importedRows = 0;
	try {
		await client.query("BEGIN");
		for (const [index, row] of rows.entries()) {
			const rowNumber = index + 1;
			const payload = JSON.stringify(row);
			const inserted = await client.query(
				`INSERT INTO settlement_reports
				   (report_id, row_number, bank_account_id, transfer_id,
				    transaction_type, effective_at, amount_minor, payload)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
				 ON CONFLICT (report_id, row_number) DO NOTHING
				 RETURNING row_number`,
				[
					reportId,
					rowNumber,
					row.bank_account_id,
					row.transaction_id,
					row.transaction_type,
					row.effective_at,
					row.available_amount,
					payload,
				],
			);
			if (inserted.rowCount) {
				importedRows += 1;
				continue;
			}
			const existing = await client.query<{ matches: boolean }>(
				`SELECT payload = $3::jsonb AS matches FROM settlement_reports
				 WHERE report_id = $1 AND row_number = $2`,
				[reportId, rowNumber, payload],
			);
			if (!existing.rows[0]?.matches) {
				throw new Error(
					"Settlement report ID already exists with different row data.",
				);
			}
		}
		await client.query("COMMIT");
		return importedRows;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function getReconciliation(
	pool: Pool,
	reportId?: string,
): Promise<{
	reports: { reportId: string; rowCount: number }[];
	rows: {
		reportId: string;
		rowNumber: number;
		transactionId: string | null;
		transactionType: string;
		amountMinor: string;
		bankAccountId: string;
		effectiveAt: string;
	}[];
	findings: ReturnType<typeof reconcileSettlement>;
}> {
	const [reports, rows, expected, transactions] = await Promise.all([
		pool.query<{ report_id: string; row_count: number }>(
			`SELECT report_id, count(*)::int AS row_count FROM settlement_reports
			 WHERE ($1::text IS NULL OR report_id = $1)
			 GROUP BY report_id ORDER BY min(imported_at), report_id`,
			[reportId ?? null],
		),
		pool.query<{
			report_id: string;
			row_number: number;
			transfer_id: string | null;
			transaction_type: string;
			amount_minor: string;
			bank_account_id: string;
			effective_at: string;
		}>(
			`SELECT report_id, row_number, transfer_id, transaction_type,
			        amount_minor::text, bank_account_id, effective_at::text
			 FROM settlement_reports
			 WHERE ($1::text IS NULL OR report_id = $1)
			 ORDER BY report_id, row_number`,
			[reportId ?? null],
		),
		pool.query<{
			transfer_id: string;
			amount_minor: string;
			status: string;
			settlement_ledger_entry_present: boolean;
			return_ledger_entry_present: boolean;
		}>(
			`SELECT pa.provider_transfer_id AS transfer_id,
			        pa.amount_minor::text,
			        pa.status,
			        EXISTS (
			          SELECT 1 FROM ledger_journals lj
			          WHERE lj.source_id = pa.id::text
			            AND lj.source_type = 'payout_settled'
		        ) AS settlement_ledger_entry_present,
		        EXISTS (
		          SELECT 1 FROM ledger_journals lj
		          WHERE lj.source_id = pa.id::text
		            AND lj.source_type = 'payout_returned'
		        ) AS return_ledger_entry_present
			 FROM payout_attempts pa
			 WHERE pa.provider_transfer_id IS NOT NULL
			   AND pa.status IN ('initiated', 'submitted', 'settled', 'completed', 'returned')`,
		),
		pool.query<{
			transfer_id: string | null;
			transaction_type: string;
			amount_minor: string;
		}>(
			`SELECT transfer_id, transaction_type, amount_minor::text
			 FROM settlement_reports
			 WHERE ($1::text IS NULL OR report_id = $1)
			 ORDER BY report_id, row_number`,
			[reportId ?? null],
		),
	]);

	const expectedTransfers: ExpectedTransfer[] = expected.rows.map((row) => ({
		transferId: row.transfer_id,
		amountMinor: row.amount_minor,
		status:
			row.status === "returned"
				? "returned"
				: row.status === "settled" || row.status === "completed"
					? "settled"
					: "submitted",
		settlementLedgerEntryPresent: row.settlement_ledger_entry_present,
		returnLedgerEntryPresent: row.return_ledger_entry_present,
	}));
	const reportTransactions: ReportTransaction[] = transactions.rows
		.filter(
			(row): row is typeof row & { transfer_id: string } =>
				typeof row.transfer_id === "string",
		)
		.map((row) => ({
			transactionId: row.transfer_id,
			transactionType: row.transaction_type,
			amountMinor: row.amount_minor,
		}));

	return {
		reports: reports.rows.map((row) => ({
			reportId: row.report_id,
			rowCount: row.row_count,
		})),
		rows: rows.rows.map((row) => ({
			reportId: row.report_id,
			rowNumber: row.row_number,
			transactionId: row.transfer_id,
			transactionType: row.transaction_type,
			amountMinor: row.amount_minor,
			bankAccountId: row.bank_account_id,
			effectiveAt: row.effective_at,
		})),
		findings: reconcileSettlement(expectedTransfers, reportTransactions),
	};
}
