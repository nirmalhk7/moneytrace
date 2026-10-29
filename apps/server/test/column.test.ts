import { describe, expect, it, vi } from "vitest";

import { createAchTransfer, getAchTransfer } from "../src/providers/column";

describe("Column ACH adapter", () => {
	it("submits an idempotent ACH credit in minor units", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ id: "acht_demo", status: "initiated" }), {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
		);

		const transfer = await createAchTransfer(
			{
				apiKey: "test_column_key",
				bankAccountId: "bacc_demo",
				counterpartyId: "cpty_demo",
				amount: 12500n,
				description: "Job payout demo",
				idempotencyKey: "attempt-key-1",
			},
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledOnce();
		const [url, request] = fetcher.mock.calls[0] ?? [];
		expect(url).toBe("https://api.column.com/transfers/ach");
		expect(request?.method).toBe("POST");
		expect(new Headers(request?.headers).get("idempotency-key")).toBe(
			"attempt-key-1",
		);
		expect(new Headers(request?.headers).get("authorization")).toBe(
			`Basic ${Buffer.from(":test_column_key").toString("base64")}`,
		);
		expect(request?.body).toBeInstanceOf(URLSearchParams);
		expect(transfer).toEqual({ id: "acht_demo", status: "initiated" });
	});

	it("surfaces Column's rejection without losing the response detail", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ message: "Counterparty is invalid." }), {
				status: 422,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(
			createAchTransfer(
				{
					apiKey: "test_column_key",
					bankAccountId: "bacc_demo",
					counterpartyId: "cpty_missing",
					amount: 12500n,
					description: "Job payout demo",
					idempotencyKey: "attempt-key-2",
				},
				fetcher,
			),
		).rejects.toThrow("Counterparty is invalid.");
	});

	it("reads transfer state using the Column transfer ID", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: "acht_demo",
					status: "returned",
					return_code: "R01",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const transfer = await getAchTransfer(
			"test_column_key",
			"acht_demo",
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledWith(
			"https://api.column.com/transfers/ach/acht_demo",
			expect.objectContaining({ method: "GET" }),
		);
		expect(transfer).toEqual({
			id: "acht_demo",
			status: "returned",
			returnCode: "R01",
		});
	});
});
