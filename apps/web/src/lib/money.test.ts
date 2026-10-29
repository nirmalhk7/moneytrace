import { describe, expect, it } from "vitest";

import { formatUsd } from "./money";

describe("formatUsd", () => {
	it("formats minor units with grouping and two decimal places", () => {
		expect(formatUsd("1234567")).toBe("$12,345.67");
	});

	it("preserves exact cents and supports amounts beyond safe integers", () => {
		expect(formatUsd("9223372036854775807")).toBe("$92,233,720,368,547,758.07");
	});

	it("formats negative ledger movements", () => {
		expect(formatUsd("-50")).toBe("-$0.50");
	});
});
