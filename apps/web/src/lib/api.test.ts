import { afterEach, describe, expect, it, vi } from "vitest";

import { request } from "./api";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("request", () => {
	it("does not send a JSON content type for bodyless requests", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await request("/api/jobs/job_123/approve", { method: "POST" });

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.method).toBe("POST");
		expect(init.body).toBeUndefined();
		expect(init.headers).not.toHaveProperty("Content-Type");
	});
});
