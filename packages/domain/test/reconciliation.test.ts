import { describe, expect, it } from "vitest";

import * as domain from "../src/index";

interface ExpectedTransfer {
	transferId: string;
	amountMinor: string;
	status: "submitted" | "settled" | "returned";
	settlementLedgerEntryPresent: boolean;
	returnLedgerEntryPresent: boolean;
}

interface ReportTransaction {
	transactionId: string;
	transactionType: string;
	amountMinor: string;
}

interface Finding {
	transactionId: string;
	classification:
		| "matched"
		| "pending"
		| "returned"
		| "untracked_transaction"
		| "missing_ledger_entry"
		| "missing_bank_transaction"
		| "duplicate_report_transaction"
		| "amount_mismatch";
	expectedAmountMinor?: string;
	observedAmountMinor?: string;
	duplicateCount?: number;
}

const reconcileSettlement = (
	domain as unknown as {
		reconcileSettlement?: (
			expected: ExpectedTransfer[],
			report: ReportTransaction[],
		) => Finding[];
	}
).reconcileSettlement;

describe("settlement reconciliation", () => {
	it("matches report rows and identifies each payout discrepancy", () => {
		expect(typeof reconcileSettlement).toBe("function");
		if (!reconcileSettlement) return;

		const findings = reconcileSettlement(
			[
				{
					transferId: "acht_matched",
					amountMinor: "27000",
					status: "settled",
					settlementLedgerEntryPresent: true,
					returnLedgerEntryPresent: false,
				},
				{
					transferId: "acht_missing_ledger",
					amountMinor: "1000",
					status: "settled",
					settlementLedgerEntryPresent: false,
					returnLedgerEntryPresent: false,
				},
				{
					transferId: "acht_missing_report",
					amountMinor: "5000",
					status: "settled",
					settlementLedgerEntryPresent: true,
					returnLedgerEntryPresent: false,
				},
				{
					transferId: "acht_pending",
					amountMinor: "1200",
					status: "submitted",
					settlementLedgerEntryPresent: false,
					returnLedgerEntryPresent: false,
				},
				{
					transferId: "acht_mismatch",
					amountMinor: "6000",
					status: "settled",
					settlementLedgerEntryPresent: true,
					returnLedgerEntryPresent: false,
				},
				{
					transferId: "acht_returned",
					amountMinor: "3000",
					status: "returned",
					settlementLedgerEntryPresent: false,
					returnLedgerEntryPresent: true,
				},
				{
					transferId: "acht_stale_submission",
					amountMinor: "4000",
					status: "submitted",
					settlementLedgerEntryPresent: false,
					returnLedgerEntryPresent: false,
				},
			],
			[
				{
					transactionId: "acht_matched",
					transactionType: "ach.outgoing_transfer.settled",
					amountMinor: "-27000",
				},
				{
					transactionId: "acht_matched",
					transactionType: "ach.outgoing_transfer.settled",
					amountMinor: "-27000",
				},
				{
					transactionId: "acht_missing_ledger",
					transactionType: "ach.outgoing_transfer.settled",
					amountMinor: "-1000",
				},
				{
					transactionId: "acht_mismatch",
					transactionType: "ach.outgoing_transfer.settled",
					amountMinor: "-5999",
				},
				{
					transactionId: "acht_returned",
					transactionType: "ach.outgoing_transfer.returned",
					amountMinor: "3000",
				},
				{
					transactionId: "acht_stale_submission",
					transactionType: "ach.outgoing_transfer.settled",
					amountMinor: "-4000",
				},
				{
					transactionId: "acht_external",
					transactionType: "ach.incoming_transfer.settled",
					amountMinor: "9000",
				},
			],
		);

		expect(findings).toEqual([
			{
				transactionId: "acht_external",
				classification: "untracked_transaction",
				observedAmountMinor: "9000",
			},
			{
				transactionId: "acht_matched",
				classification: "duplicate_report_transaction",
				duplicateCount: 2,
			},
			{
				transactionId: "acht_matched",
				classification: "matched",
				expectedAmountMinor: "27000",
				observedAmountMinor: "-27000",
			},
			{
				transactionId: "acht_mismatch",
				classification: "amount_mismatch",
				expectedAmountMinor: "6000",
				observedAmountMinor: "-5999",
			},
			{
				transactionId: "acht_missing_ledger",
				classification: "missing_ledger_entry",
				expectedAmountMinor: "1000",
				observedAmountMinor: "-1000",
			},
			{
				transactionId: "acht_missing_report",
				classification: "missing_bank_transaction",
				expectedAmountMinor: "5000",
			},
			{
				transactionId: "acht_pending",
				classification: "pending",
				expectedAmountMinor: "1200",
			},
			{
				transactionId: "acht_returned",
				classification: "returned",
				expectedAmountMinor: "3000",
				observedAmountMinor: "3000",
			},
			{
				transactionId: "acht_stale_submission",
				classification: "missing_ledger_entry",
				expectedAmountMinor: "4000",
				observedAmountMinor: "-4000",
			},
		]);
	});
});
