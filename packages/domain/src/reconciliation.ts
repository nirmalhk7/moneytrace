export interface ExpectedTransfer {
	transferId: string;
	amountMinor: string;
	status: "submitted" | "settled" | "returned";
	settlementLedgerEntryPresent: boolean;
	returnLedgerEntryPresent: boolean;
}

export interface ReportTransaction {
	transactionId: string;
	transactionType: string;
	amountMinor: string;
}

export type ReconciliationClassification =
	| "matched"
	| "pending"
	| "returned"
	| "untracked_transaction"
	| "missing_ledger_entry"
	| "missing_bank_transaction"
	| "duplicate_report_transaction"
	| "amount_mismatch";

export interface ReconciliationFinding {
	transactionId: string;
	classification: ReconciliationClassification;
	expectedAmountMinor?: string;
	observedAmountMinor?: string;
	duplicateCount?: number;
}

export function reconcileSettlement(
	expected: readonly ExpectedTransfer[],
	report: readonly ReportTransaction[],
): ReconciliationFinding[] {
	const expectedById = new Map(
		expected.map((transfer) => [transfer.transferId, transfer]),
	);
	const findings: ReconciliationFinding[] = [];
	const observedTransferIds = new Set<string>();
	for (const transactions of groupTransactions(report).values()) {
		const transaction = transactions[0];
		if (!transaction) continue;
		findings.push(
			...classifyReportGroup(transaction, transactions.length, expectedById),
		);
		if (expectedById.has(transaction.transactionId)) {
			observedTransferIds.add(transaction.transactionId);
		}
	}

	findings.push(...classifyMissingTransfers(expected, observedTransferIds));

	return findings.sort(
		(left, right) =>
			left.transactionId.localeCompare(right.transactionId) ||
			left.classification.localeCompare(right.classification),
	);
}

function groupTransactions(
	report: readonly ReportTransaction[],
): Map<string, ReportTransaction[]> {
	const groups = new Map<string, ReportTransaction[]>();
	for (const transaction of report) {
		const key = `${transaction.transactionId}\u0000${transaction.transactionType}`;
		const group = groups.get(key) ?? [];
		group.push(transaction);
		groups.set(key, group);
	}
	return groups;
}

function classifyReportGroup(
	transaction: ReportTransaction,
	duplicateCount: number,
	expected: ReadonlyMap<string, ExpectedTransfer>,
): ReconciliationFinding[] {
	const transfer = expected.get(transaction.transactionId);
	const findings: ReconciliationFinding[] = [];
	if (duplicateCount > 1) {
		findings.push({
			transactionId: transaction.transactionId,
			classification: "duplicate_report_transaction",
			duplicateCount,
		});
	}
	if (!transfer) {
		findings.push({
			transactionId: transaction.transactionId,
			classification: "untracked_transaction",
			observedAmountMinor: transaction.amountMinor,
		});
		return findings;
	}

	findings.push(classifyKnownTransfer(transaction, transfer));
	return findings;
}

function classifyKnownTransfer(
	transaction: ReportTransaction,
	transfer: ExpectedTransfer,
): ReconciliationFinding {
	const resultBase = {
		transactionId: transaction.transactionId,
		expectedAmountMinor: transfer.amountMinor,
		observedAmountMinor: transaction.amountMinor,
	};
	if (
		absolute(BigInt(transaction.amountMinor)) !== BigInt(transfer.amountMinor)
	) {
		return { ...resultBase, classification: "amount_mismatch" };
	}
	if (isReturned(transaction.transactionType)) {
		return {
			...resultBase,
			classification: transfer.returnLedgerEntryPresent
				? "returned"
				: "missing_ledger_entry",
		};
	}
	if (isSettled(transaction.transactionType)) {
		return {
			...resultBase,
			classification: transfer.settlementLedgerEntryPresent
				? "matched"
				: "missing_ledger_entry",
		};
	}
	if (transfer.status === "submitted") {
		return { ...resultBase, classification: "pending" };
	}
	return {
		...resultBase,
		classification: transfer.settlementLedgerEntryPresent
			? "matched"
			: "missing_ledger_entry",
	};
}

function classifyMissingTransfers(
	expected: readonly ExpectedTransfer[],
	observedIds: ReadonlySet<string>,
): ReconciliationFinding[] {
	return expected
		.filter((transfer) => !observedIds.has(transfer.transferId))
		.map((transfer) => ({
			transactionId: transfer.transferId,
			expectedAmountMinor: transfer.amountMinor,
			classification:
				transfer.status === "submitted"
					? "pending"
					: "missing_bank_transaction",
		}));
}

function absolute(value: bigint): bigint {
	return value < 0n ? -value : value;
}

function isReturned(transactionType: string): boolean {
	return transactionType.toLowerCase().includes("returned");
}

function isSettled(transactionType: string): boolean {
	return transactionType.toLowerCase().includes("settled");
}
