import { describe, expect, it } from "vitest";

import {
	parseColumnReportJson,
	isRepairableSettlementFinding,
} from "./reconciliation";

describe("Column transaction report parser", () => {
	it("normalizes a Column JSON report into exact minor-unit strings", () => {
		expect(
			parseColumnReportJson(
				JSON.stringify([
					{
						effective_at: "2026-10-27T16:10:00Z",
						bank_account_id: "bacc_demo",
						transaction_id: "acht_demo",
						transaction_type: "ach.outgoing_transfer.settled",
						currency: "USD",
						available_amount: -9007199254740991,
					},
				]),
			),
		).toEqual({
			rows: [
				{
					effective_at: "2026-10-27T16:10:00Z",
					bank_account_id: "bacc_demo",
					transaction_id: "acht_demo",
					transaction_type: "ach.outgoing_transfer.settled",
					currency: "USD",
					available_amount: "-9007199254740991",
				},
			],
		});
	});

	it("rejects malformed JSON instead of silently importing partial evidence", () => {
		expect(() => parseColumnReportJson("{not-json")).toThrow(
			"Column report is not valid JSON.",
		);
	});

	it("allows repair only for one settled report row on a missing-ledger finding", () => {
		const finding = { classification: "missing_ledger_entry" };
		const row = {
			reportId: "report_1",
			rowNumber: 1,
			transactionType: "ach.outgoing_transfer.settled",
		};

		expect(isRepairableSettlementFinding(finding, [row])).toBe(true);
		expect(isRepairableSettlementFinding(finding, [row, row])).toBe(false);
		expect(
			isRepairableSettlementFinding(finding, [
				{ ...row, transactionType: "ach.outgoing_transfer.returned" },
			]),
		).toBe(false);
		expect(
			isRepairableSettlementFinding({ classification: "matched" }, [row]),
		).toBe(false);
	});
});
