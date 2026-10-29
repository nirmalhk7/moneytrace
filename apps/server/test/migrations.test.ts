import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { migrate } from "../src/database/migrate";
import { createIsolatedTestPool } from "./test-pool";

let pool: Pool;
let cleanup: () => Promise<void>;

describe("database migrations", () => {
	beforeAll(async () => {
		const isolated = await createIsolatedTestPool();
		pool = isolated.pool;
		cleanup = isolated.cleanup;
		await migrate(pool);
	});

	afterAll(async () => {
		await cleanup();
	});

	it("creates the demo contractors and opening funds exactly once", async () => {
		await migrate(pool);

		const result = await pool.query<{
			contractor_count: string;
			opening_cash: string;
			opening_unallocated: string;
			migration_count: string;
			provider_status_column: string;
			provider_request_column: string;
		}>(`
      SELECT
        (SELECT count(*) FROM contractors) AS contractor_count,
        (SELECT sum(debit_minor) FROM ledger_entries WHERE account = 'bank_cash') AS opening_cash,
        (SELECT sum(credit_minor) FROM ledger_entries WHERE account = 'unallocated_customer_funds') AS opening_unallocated,
	        (SELECT count(*) FROM schema_migrations) AS migration_count,
	        (SELECT count(*)::text FROM information_schema.columns
	          WHERE table_schema = current_schema()
	            AND table_name = 'payout_attempts'
	            AND column_name = 'provider_status') AS provider_status_column,
	        (SELECT count(*)::text FROM information_schema.columns
	          WHERE table_schema = current_schema()
	            AND table_name = 'payout_attempts'
	            AND column_name = 'provider_request') AS provider_request_column
    `);

		expect(result.rows[0]).toEqual({
			contractor_count: "3",
			opening_cash: "1000000",
			opening_unallocated: "1000000",
			migration_count: "3",
			provider_status_column: "1",
			provider_request_column: "1",
		});
	});

	it("serializes concurrent first-run migration setup", async () => {
		const isolated = await createIsolatedTestPool();
		try {
			await Promise.all([migrate(isolated.pool), migrate(isolated.pool)]);
			const result = await isolated.pool.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM schema_migrations",
			);
			expect(result.rows[0]?.count).toBe("3");
		} finally {
			await isolated.cleanup();
		}
	});

	it("rejects an unbalanced journal at transaction commit", async () => {
		const client = await pool.connect();
		const sourceId = `test-${crypto.randomUUID()}`;

		try {
			await client.query("BEGIN");
			const journal = await client.query<{ id: string }>(
				`INSERT INTO ledger_journals (id, source_type, source_id)
         VALUES ($1, 'test', $2) RETURNING id`,
				[crypto.randomUUID(), sourceId],
			);
			await client.query(
				`INSERT INTO ledger_entries (journal_id, account, debit_minor, credit_minor)
         VALUES ($1, 'bank_cash', 100, 0)`,
				[journal.rows[0]?.id],
			);

			await expect(client.query("COMMIT")).rejects.toThrow(
				"Journal must contain at least two entries and balance.",
			);
			await client.query("ROLLBACK");
		} finally {
			client.release();
		}
	});
});
