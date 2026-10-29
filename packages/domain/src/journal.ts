const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;

export type LedgerAccount =
	| "bank_cash"
	| "unallocated_customer_funds"
	| "contractor_payable"
	| "money_in_transit"
	| "fee_revenue";

export interface JournalLine {
	account: LedgerAccount;
	debit: bigint;
	credit: bigint;
}

export interface JournalDraft {
	sourceType: string;
	sourceId: string;
	lines: readonly JournalLine[];
}

export function createBalancedJournal({
	sourceType,
	sourceId,
	lines,
}: JournalDraft): JournalDraft {
	if (!sourceType.trim() || !sourceId.trim()) {
		throw new Error("Journal source type and source ID are required.");
	}

	if (lines.length < 2) {
		throw new Error("A journal must contain at least two lines.");
	}

	let debits = 0n;
	let credits = 0n;

	for (const line of lines) {
		const debitIsValid = line.debit > 0n && line.credit === 0n;
		const creditIsValid = line.credit > 0n && line.debit === 0n;

		if (!debitIsValid && !creditIsValid) {
			throw new Error(
				"Each journal line must have exactly one positive amount.",
			);
		}

		if (line.debit > POSTGRES_INT8_MAX || line.credit > POSTGRES_INT8_MAX) {
			throw new Error("Journal line exceeds the supported limit.");
		}

		debits += line.debit;
		credits += line.credit;
	}

	if (debits !== credits) {
		throw new Error("Journal debits and credits must balance.");
	}

	return {
		sourceType,
		sourceId,
		lines: lines.map((line) => ({ ...line })),
	};
}
