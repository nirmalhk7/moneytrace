import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { approveJob, createDraftJob } from "../src/jobs/store";
import {
	retryUnknownPayoutAttempt,
	simulateLostProviderResponse,
} from "../src/payouts/submissions";
import { createIsolatedTestPool } from "./test-pool";

let pool: Pool;
let app: FastifyInstance;
let cleanup: () => Promise<void>;

describe("unknown payout cash reservation", () => {
	beforeAll(async () => {
		({ pool, cleanup } = await createIsolatedTestPool());
		app = buildApp(pool, { bankMode: "replay" });
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		await cleanup();
	});

	it("reserves unknown payouts without posting bank cash or submission journals", async () => {
		const job = await createDraftJob(pool, {
			title: "Unknown payout balance",
			gross: 10000n,
			platformFee: 1000n,
			allocations: [{ contractorId: "contractor_mara", amount: 9000n }],
		});
		await approveJob(pool, job.id);
		const obligation = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const lost = await simulateLostProviderResponse(
			pool,
			obligation.rows[0]?.id ?? "",
		);
		const unknown = await app.inject({ method: "GET", url: "/api/overview" });
		expect(unknown.json().balances).toMatchObject({
			bankCash: "1000000",
			availableCash: "991000",
			moneyInTransit: "0",
		});
		const journals = await pool.query(
			"SELECT id FROM ledger_journals WHERE source_id = $1",
			[lost.attemptId],
		);
		expect(journals.rowCount).toBe(0);

		await retryUnknownPayoutAttempt(pool, lost.attemptId, { mode: "replay" });
		const recovered = await app.inject({ method: "GET", url: "/api/overview" });
		expect(recovered.json().balances).toMatchObject({
			bankCash: "1000000",
			availableCash: "991000",
			moneyInTransit: "9000",
		});
	});
});
