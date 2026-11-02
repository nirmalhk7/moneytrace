import { describe, expect, it, vi } from "vitest";

import { verifyColumnSandboxConnection } from "../src/providers/column-sandbox-smoke";

describe("Column sandbox connection smoke check", () => {
	it("creates a zero-dollar prenote and reads back the same ACH transfer", async () => {
		const responseBody = {
			id: "acht_smoke_1",
			status: "INITIATED",
			amount: 0,
			currency_code: "USD",
			bank_account_id: "bacc_smoke",
			counterparty_id: "cpty_smoke",
			type: "CREDIT",
			entry_class_code: "CCD",
		};
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(responseBody), { status: 201 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(responseBody), { status: 200 }),
			);

		const result = await verifyColumnSandboxConnection(
			{
				apiKey: "test_sandbox_key",
				bankAccountId: "bacc_smoke",
				counterpartyId: "cpty_smoke",
			},
			fetcher,
		);

		expect(result).toEqual({
			transferId: "acht_smoke_1",
			submittedStatus: "INITIATED",
			lookupStatus: "INITIATED",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		const [createUrl, createInit] = fetcher.mock.calls[0] ?? [];
		expect(createUrl).toBe("https://api.column.com/transfers/ach");
		expect(createInit?.method).toBe("POST");
		const createBody = new URLSearchParams(String(createInit?.body));
		expect(createBody.get("amount")).toBe("0");
		expect(createBody.get("counterparty_id")).toBe("cpty_smoke");
		expect(createBody.get("bank_account_id")).toBe("bacc_smoke");
		expect(createBody.get("type")).toBe("CREDIT");
		expect(createBody.get("entry_class_code")).toBe("CCD");
		const headers = new Headers(createInit?.headers);
		expect(headers.get("Idempotency-Key")).toMatch(/^column-smoke-/);
		const [lookupUrl, lookupInit] = fetcher.mock.calls[1] ?? [];
		expect(lookupUrl).toBe("https://api.column.com/transfers/ach/acht_smoke_1");
		expect(lookupInit?.method).toBe("GET");
	});

	it("explains a rejected prenote without retrying as a remittance", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					code: "invalid_field_value",
					message: "Invalid argument found.",
					details: {
						reason:
							"Required field 'payment_related_info' is missing for zero-dollar remittance entries.",
					},
				}),
				{ status: 400 },
			),
		);

		await expect(
			verifyColumnSandboxConnection(
				{
					apiKey: "test_sandbox_key",
					bankAccountId: "bacc_smoke",
					counterpartyId: "cpty_smoke",
				},
				fetcher,
			),
		).rejects.toThrow(
			"Invalid argument found. [invalid_field_value] Required field 'payment_related_info' is missing for zero-dollar remittance entries. This check requests a prenote. Confirm ACH prenotes are enabled for this Column sandbox platform; payment_related_info would change it into a remittance.",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("refuses live keys before making a provider request", async () => {
		const fetcher = vi.fn<typeof fetch>();

		await expect(
			verifyColumnSandboxConnection(
				{
					apiKey: "live_do_not_use",
					bankAccountId: "bacc_smoke",
					counterpartyId: "cpty_smoke",
				},
				fetcher,
			),
		).rejects.toThrow(
			"Only a Column sandbox API key beginning with test_ is allowed.",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
