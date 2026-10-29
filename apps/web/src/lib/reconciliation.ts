export type ColumnReportRow = {
	effective_at: string;
	bank_account_id: string;
	transaction_id: string;
	transaction_type: string;
	currency: "USD";
	available_amount: string;
};

export function isRepairableSettlementFinding(
	finding: { classification: string },
	rows: readonly { transactionType: string }[],
): boolean {
	return (
		finding.classification === "missing_ledger_entry" &&
		rows.length === 1 &&
		rows[0]?.transactionType === "ach.outgoing_transfer.settled"
	);
}

export function parseColumnReportJson(text: string): {
	rows: ColumnReportRow[];
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Column report is not valid JSON.");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("Column report must be a JSON array of transaction rows.");
	}
	return { rows: parsed.map(parseRow) };
}

function parseRow(value: unknown, index: number): ColumnReportRow {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Column report row ${index + 1} must be an object.`);
	}
	const row = value as Record<string, unknown>;
	const requiredStrings = [
		"effective_at",
		"bank_account_id",
		"transaction_id",
		"transaction_type",
	] as const;
	for (const field of requiredStrings) {
		if (typeof row[field] !== "string" || row[field].length === 0) {
			throw new Error(`Column report row ${index + 1} needs ${field}.`);
		}
	}
	if (!Number.isFinite(Date.parse(row.effective_at as string))) {
		throw new Error(
			`Column report row ${index + 1} has an invalid effective_at.`,
		);
	}
	if (row.currency !== "USD") {
		throw new Error(`Column report row ${index + 1} must use USD.`);
	}
	const amount = row.available_amount;
	if (
		typeof amount !== "string" &&
		!(typeof amount === "number" && Number.isSafeInteger(amount))
	) {
		throw new Error(
			`Column report row ${index + 1} needs an integer available_amount.`,
		);
	}
	const amountString = String(amount);
	if (!/^-?\d+$/.test(amountString)) {
		throw new Error(
			`Column report row ${index + 1} needs an integer available_amount.`,
		);
	}
	return {
		effective_at: row.effective_at as string,
		bank_account_id: row.bank_account_id as string,
		transaction_id: row.transaction_id as string,
		transaction_type: row.transaction_type as string,
		currency: "USD",
		available_amount: amountString,
	};
}
