import { describe, expect, it } from "vitest";

import { assertJobAllocation, parseUsdAmount } from "../src";

describe("parseUsdAmount", () => {
	it("converts decimal USD input to exact cents", () => {
		expect(parseUsdAmount("1350.25")).toBe(135025n);
		expect(parseUsdAmount("12.3")).toBe(1230n);
		expect(parseUsdAmount("12")).toBe(1200n);
	});

	it("rejects values with more than two fractional digits", () => {
		expect(() => parseUsdAmount("10.001")).toThrow(
			"Enter a USD amount with at most two decimal places.",
		);
	});

	it("rejects negative values with a clear validation error", () => {
		expect(() => parseUsdAmount("-1.00")).toThrow(
			"Enter a non-negative USD amount.",
		);
	});

	it("rejects formatted currency symbols", () => {
		expect(() => parseUsdAmount("$10.00")).toThrow(
			"Enter a USD amount with at most two decimal places.",
		);
	});
});

describe("assertJobAllocation", () => {
	it("accepts contractor amounts and platform fee that equal gross", () => {
		expect(() =>
			assertJobAllocation({
				gross: 6000n,
				contractorAmounts: [2500n, 3450n],
				platformFee: 50n,
			}),
		).not.toThrow();
	});

	it("rejects allocations that do not equal gross", () => {
		expect(() =>
			assertJobAllocation({
				gross: 6000n,
				contractorAmounts: [2500n, 3400n],
				platformFee: 50n,
			}),
		).toThrow("Contractor amounts and platform fee must equal job gross.");
	});

	it("requires at least one positive contractor allocation", () => {
		expect(() =>
			assertJobAllocation({
				gross: 500n,
				contractorAmounts: [],
				platformFee: 0n,
			}),
		).toThrow("Add at least one contractor allocation.");
		expect(() =>
			assertJobAllocation({
				gross: 500n,
				contractorAmounts: [0n],
				platformFee: 0n,
			}),
		).toThrow("Contractor allocations must be greater than zero.");
	});
});
