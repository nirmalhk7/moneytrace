import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
	assertJobAllocation,
	createBalancedJournal,
} from "@money-trace/domain";

interface JobInput {
	title: string;
	gross: bigint;
	platformFee: bigint;
	allocations: readonly { contractorId: string; amount: bigint }[];
}

interface JobRow {
	id: string;
	title: string;
	gross_minor: string;
	platform_fee_minor: string;
	status: "draft" | "approved";
}

export interface JobRecord {
	id: string;
	title: string;
	gross: bigint;
	platformFee: bigint;
	status: "draft" | "approved";
}

function toJobRecord(row: JobRow): JobRecord {
	return {
		id: row.id,
		title: row.title,
		gross: BigInt(row.gross_minor),
		platformFee: BigInt(row.platform_fee_minor),
		status: row.status,
	};
}

async function rollback(client: PoolClient): Promise<void> {
	await client.query("ROLLBACK");
}

export async function createDraftJob(
	pool: Pool,
	input: JobInput,
): Promise<JobRecord> {
	const title = input.title.trim();

	if (!title) {
		throw new Error("Job title is required.");
	}

	assertJobAllocation({
		gross: input.gross,
		platformFee: input.platformFee,
		contractorAmounts: input.allocations.map(({ amount }) => amount),
	});

	const contractorIds = input.allocations.map(
		({ contractorId }) => contractorId,
	);

	if (new Set(contractorIds).size !== contractorIds.length) {
		throw new Error("Each contractor can appear only once per job.");
	}

	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		const contractors = await client.query<{ id: string }>(
			"SELECT id FROM contractors WHERE id = ANY($1::text[]) AND active = true",
			[contractorIds],
		);

		if (contractors.rowCount !== contractorIds.length) {
			throw new Error("Select an active contractor for every allocation.");
		}

		const id = randomUUID();
		const result = await client.query<JobRow>(
			`INSERT INTO jobs (id, title, gross_minor, platform_fee_minor, created_by)
       VALUES ($1, $2, $3, $4, 'local-operator')
       RETURNING id, title, gross_minor, platform_fee_minor, status`,
			[id, title, input.gross.toString(), input.platformFee.toString()],
		);

		for (const allocation of input.allocations) {
			await client.query(
				`INSERT INTO job_allocations (job_id, contractor_id, amount_minor)
         VALUES ($1, $2, $3)`,
				[id, allocation.contractorId, allocation.amount.toString()],
			);
		}

		await client.query("COMMIT");
		const job = result.rows[0];

		if (!job) {
			throw new Error("Draft job could not be created.");
		}

		return toJobRecord(job);
	} catch (error) {
		await rollback(client);
		throw error;
	} finally {
		client.release();
	}
}

export async function approveJob(
	pool: Pool,
	jobId: string,
): Promise<JobRecord> {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtext('money-trace:unallocated-funds'))",
		);

		const jobResult = await client.query<JobRow>(
			`SELECT id, title, gross_minor, platform_fee_minor, status
       FROM jobs WHERE id = $1 FOR UPDATE`,
			[jobId],
		);
		const job = jobResult.rows[0];

		if (!job) {
			throw new Error("Job not found.");
		}

		if (job.status !== "draft") {
			throw new Error("Job is already approved.");
		}

		const allocations = await client.query<{
			contractor_id: string;
			amount_minor: string;
		}>(
			`SELECT contractor_id, amount_minor FROM job_allocations
       WHERE job_id = $1 ORDER BY contractor_id`,
			[jobId],
		);
		const gross = BigInt(job.gross_minor);
		const platformFee = BigInt(job.platform_fee_minor);
		const contractorAmounts = allocations.rows.map((row) =>
			BigInt(row.amount_minor),
		);

		assertJobAllocation({ gross, platformFee, contractorAmounts });

		const unallocated = await client.query<{ balance: string }>(
			`SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance
       FROM ledger_entries WHERE account = 'unallocated_customer_funds'`,
		);

		if (BigInt(unallocated.rows[0]?.balance ?? "0") < gross) {
			throw new Error("Insufficient unallocated customer funds.");
		}

		const obligationIds = allocations.rows.map(() => randomUUID());

		for (const [index, allocation] of allocations.rows.entries()) {
			await client.query(
				`INSERT INTO obligations (id, job_id, contractor_id, amount_minor)
         VALUES ($1, $2, $3, $4)`,
				[
					obligationIds[index],
					jobId,
					allocation.contractor_id,
					allocation.amount_minor,
				],
			);
		}

		const journal = createBalancedJournal({
			sourceType: "job_approved",
			sourceId: jobId,
			lines: [
				{
					account: "unallocated_customer_funds",
					debit: gross,
					credit: 0n,
				},
				...allocations.rows.map((allocation, index) => ({
					account: "contractor_payable" as const,
					debit: 0n,
					credit: BigInt(allocation.amount_minor),
				})),
				...(platformFee > 0n
					? [
							{
								account: "fee_revenue" as const,
								debit: 0n,
								credit: platformFee,
							},
						]
					: []),
			],
		});
		const journalId = randomUUID();

		await client.query(
			`INSERT INTO ledger_journals (id, source_type, source_id)
       VALUES ($1, $2, $3)`,
			[journalId, journal.sourceType, journal.sourceId],
		);

		for (const [index, line] of journal.lines.entries()) {
			await client.query(
				`INSERT INTO ledger_entries
           (journal_id, account, debit_minor, credit_minor, obligation_id)
         VALUES ($1, $2, $3, $4, $5)`,
				[
					journalId,
					line.account,
					line.debit.toString(),
					line.credit.toString(),
					line.account === "contractor_payable"
						? obligationIds[index - 1]
						: null,
				],
			);
		}

		const approved = await client.query<JobRow>(
			`UPDATE jobs SET status = 'approved', approved_at = now()
       WHERE id = $1
       RETURNING id, title, gross_minor, platform_fee_minor, status`,
			[jobId],
		);

		await client.query("COMMIT");
		const updatedJob = approved.rows[0];

		if (!updatedJob) {
			throw new Error("Approved job could not be loaded.");
		}

		return toJobRecord(updatedJob);
	} catch (error) {
		await rollback(client);
		throw error;
	} finally {
		client.release();
	}
}
