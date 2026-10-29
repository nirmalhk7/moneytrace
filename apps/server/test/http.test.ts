import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { createIsolatedTestPool } from "./test-pool";

let pool: Pool;
let app: FastifyInstance;
let cleanup: () => Promise<void>;

describe("Money Trace HTTP API", () => {
	beforeAll(async () => {
		const isolated = await createIsolatedTestPool();
		pool = isolated.pool;
		cleanup = isolated.cleanup;
		app = buildApp(pool, { bankMode: "replay" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		await cleanup();
	});

	it("returns balances and active contractors for the operations screen", async () => {
		const response = await app.inject({ method: "GET", url: "/api/overview" });
		const body = response.json();

		expect(response.statusCode).toBe(200);
		expect(body.balances).toMatchObject({
			bankCash: "1000000",
			unallocatedFunds: "1000000",
			outstandingPayables: "0",
		});
		expect(body.contractors).toHaveLength(3);
	});

	it("creates and approves a job before queuing its payout", async () => {
		const created = await app.inject({
			method: "POST",
			url: "/api/jobs",
			payload: {
				title: "Replace rooftop condenser",
				gross: "300.00",
				platformFee: "30.00",
				allocations: [{ contractorId: "contractor_mara", amount: "270.00" }],
			},
		});

		expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
		const jobId = created.json().id as string;
		const approved = await app.inject({
			method: "POST",
			url: `/api/jobs/${jobId}/approve`,
		});
		expect(approved.statusCode).toBe(200);
		expect(approved.json().status).toBe("approved");

		const obligations = await app.inject({
			method: "GET",
			url: "/api/obligations?status=due",
		});
		expect(obligations.json()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					contractorName: "Mara Electrical",
					amount: "27000",
					jobTitle: "Replace rooftop condenser",
				}),
			]),
		);
		const obligationId = (obligations.json() as Array<{ id: string }>)[0]?.id;
		expect(obligationId).toBeDefined();

		const submitted = await app.inject({
			method: "POST",
			url: "/api/payout-batches",
			payload: { obligationIds: [obligationId], replayOutcome: "settled" },
		});
		expect(submitted.statusCode).toBe(201);

		const refreshed = await app.inject({ method: "GET", url: "/api/overview" });
		expect(refreshed.json().balances).toMatchObject({
			bankCash: "973000",
			unallocatedFunds: "970000",
			outstandingPayables: "0",
			moneyInTransit: "0",
		});
		expect(refreshed.json().batches[0].status).toBe("completed");
	});
});
