import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { migrate } from "../src/database/migrate";
import { approveJob, createDraftJob } from "../src/jobs/store";
import { createIsolatedTestPool } from "./test-pool";

let pool: Pool;
let cleanup: () => Promise<void>;

describe("job approval", () => {
	beforeAll(async () => {
		const isolated = await createIsolatedTestPool();
		pool = isolated.pool;
		cleanup = isolated.cleanup;
		await migrate(pool);
	});

	afterAll(async () => {
		await cleanup();
	});

	it("creates contractor obligations and books the fee exactly once", async () => {
		const job = await createDraftJob(pool, {
			title: `Crew electrical work ${randomUUID()}`,
			gross: 6000n,
			platformFee: 50n,
			allocations: [
				{ contractorId: "contractor_mara", amount: 2500n },
				{ contractorId: "contractor_northstar", amount: 3450n },
			],
		});

		expect(job.status).toBe("draft");

		const approved = await approveJob(pool, job.id);

		expect(approved.status).toBe("approved");

		const obligations = await pool.query<{
			amount_minor: string;
			status: string;
		}>(
			"SELECT amount_minor, status FROM obligations WHERE job_id = $1 ORDER BY amount_minor",
			[job.id],
		);
		const journal = await pool.query<{ debit: string; credit: string }>(
			`SELECT sum(debit_minor)::text AS debit, sum(credit_minor)::text AS credit
       FROM ledger_entries le JOIN ledger_journals lj ON lj.id = le.journal_id
       WHERE lj.source_type = 'job_approved' AND lj.source_id = $1`,
			[job.id],
		);

		expect(obligations.rows).toEqual([
			{ amount_minor: "2500", status: "due" },
			{ amount_minor: "3450", status: "due" },
		]);
		expect(journal.rows[0]).toEqual({ debit: "6000", credit: "6000" });
		await expect(approveJob(pool, job.id)).rejects.toThrow(
			"Job is already approved.",
		);

		const duplicateJournal = await pool.query(
			`SELECT count(*) FROM ledger_journals WHERE source_type = 'job_approved' AND source_id = $1`,
			[job.id],
		);
		expect(duplicateJournal.rows[0]?.count).toBe("1");
	});

	it("leaves job and ledger unchanged when funded customer balance is too low", async () => {
		const job = await createDraftJob(pool, {
			title: `Overfunded job ${randomUUID()}`,
			gross: 200_000_000n,
			platformFee: 0n,
			allocations: [{ contractorId: "contractor_mara", amount: 200_000_000n }],
		});

		await expect(approveJob(pool, job.id)).rejects.toThrow(
			"Insufficient unallocated customer funds.",
		);

		const state = await pool.query<{ status: string; obligations: string }>(
			`SELECT jobs.status, count(obligations.id)::text AS obligations
       FROM jobs LEFT JOIN obligations ON obligations.job_id = jobs.id
       WHERE jobs.id = $1 GROUP BY jobs.id`,
			[job.id],
		);
		expect(state.rows[0]).toEqual({ status: "draft", obligations: "0" });
	});

	it("allows only one approval when two requests race", async () => {
		const job = await createDraftJob(pool, {
			title: `Concurrent approval ${randomUUID()}`,
			gross: 2500n,
			platformFee: 0n,
			allocations: [{ contractorId: "contractor_mara", amount: 2500n }],
		});

		const outcomes = await Promise.allSettled([
			approveJob(pool, job.id),
			approveJob(pool, job.id),
		]);

		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === "rejected"),
		).toHaveLength(1);
		const obligations = await pool.query(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		expect(obligations.rowCount).toBe(1);
	});
});
