import { describe, expect, it } from "vitest";

import { createBalancedJournal } from "../src";

describe("createBalancedJournal", () => {
	it("accepts a balanced double-entry journal", () => {
		expect(
			createBalancedJournal({
				sourceType: "job_approved",
				sourceId: "job_101",
				lines: [
					{ account: "unallocated_customer_funds", debit: 6000n, credit: 0n },
					{ account: "contractor_payable", debit: 0n, credit: 2500n },
					{ account: "contractor_payable", debit: 0n, credit: 3450n },
					{ account: "fee_revenue", debit: 0n, credit: 50n },
				],
			}),
		).toEqual({
			sourceType: "job_approved",
			sourceId: "job_101",
			lines: [
				{ account: "unallocated_customer_funds", debit: 6000n, credit: 0n },
				{ account: "contractor_payable", debit: 0n, credit: 2500n },
				{ account: "contractor_payable", debit: 0n, credit: 3450n },
				{ account: "fee_revenue", debit: 0n, credit: 50n },
			],
		});
	});

	it("rejects unbalanced totals", () => {
		expect(() =>
			createBalancedJournal({
				sourceType: "job_approved",
				sourceId: "job_101",
				lines: [
					{ account: "unallocated_customer_funds", debit: 6000n, credit: 0n },
					{ account: "contractor_payable", debit: 0n, credit: 5999n },
				],
			}),
		).toThrow("Journal debits and credits must balance.");
	});

	it("requires each line to contain one positive debit or credit", () => {
		expect(() =>
			createBalancedJournal({
				sourceType: "job_approved",
				sourceId: "job_101",
				lines: [
					{ account: "bank_cash", debit: 100n, credit: 100n },
					{ account: "fee_revenue", debit: 0n, credit: 0n },
				],
			}),
		).toThrow("Each journal line must have exactly one positive amount.");
	});

	it("rejects journals with fewer than two lines", () => {
		expect(() =>
			createBalancedJournal({
				sourceType: "opening_funds",
				sourceId: "opening_1",
				lines: [{ account: "bank_cash", debit: 100n, credit: 0n }],
			}),
		).toThrow("A journal must contain at least two lines.");
	});
});
