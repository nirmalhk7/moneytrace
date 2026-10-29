import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { createIsolatedTestPool } from "./test-pool";

let pool: Pool;
let app: FastifyInstance;
let cleanup: () => Promise<void>;

describe("incident replay API", () => {
	beforeAll(async () => {
		const isolated = await createIsolatedTestPool();
		pool = isolated.pool;
		cleanup = isolated.cleanup;
		app = buildApp(pool, {
			bankMode: "replay",
			databaseUrl:
				process.env.TEST_DATABASE_URL ??
				"postgres://money_trace:money_trace@127.0.0.1:5432/money_trace_test",
		});
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
		await cleanup();
	});

	it.each(["lost_response", "missing_ledger", "late_return"] as const)(
		"runs %s in an isolated replay ledger and exports verifiable evidence",
		async (scenario) => {
			const response = await app.inject({
				method: "POST",
				url: "/api/incidents/runs",
				payload: { scenario },
			});
			const body = response.json();

			expect(response.statusCode, JSON.stringify(body)).toBe(201);
			expect(body.evidence.scenario).toBe(scenario);
			expect(body.evidence.source).toBe("replay");
			expect(body.verification).toEqual({ valid: true, findings: [] });
			expect(body.evidence.amountMinor).toBe("9000");
			const stored = await app.inject({
				method: "GET",
				url: `/api/incidents/runs/${body.evidence.runId}`,
			});
			expect(stored.statusCode).toBe(200);
			expect(stored.json().evidence).toEqual(body.evidence);
			await expect(
				pool.query("UPDATE incident_runs SET evidence = '{}' WHERE id = $1", [
					body.evidence.runId,
				]),
			).rejects.toThrow("Incident run evidence is immutable.");

			const mainLedger = await pool.query<{ cash: string }>(
				"SELECT sum(debit_minor - credit_minor)::text AS cash FROM ledger_entries WHERE account = 'bank_cash'",
			);
			expect(mainLedger.rows[0]?.cash).toBe("1000000");
		},
	);
});
