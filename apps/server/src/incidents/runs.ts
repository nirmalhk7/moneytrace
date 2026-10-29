import { randomUUID } from "node:crypto";
import { Pool, type Pool as PoolType } from "pg";

import { approveJob, createDraftJob } from "../jobs/store";
import { migrate } from "../database/migrate";
import { importSettlementReport } from "../reconciliation/store";
import { repairSettledPayoutLedger } from "../reconciliation/repairs";
import { createPayoutBatch, resolvePayoutAttempt } from "../payouts/store";
import {
	retryUnknownPayoutAttempt,
	simulateLostProviderResponse,
	simulateMissingLedgerEntry,
	submitPayoutBatch,
} from "../payouts/submissions";
import {
	verifyIncidentEvidence,
	type IncidentEvidence,
	type IncidentScenario,
} from "@money-trace/domain";

export interface IncidentRunResult {
	evidence: IncidentEvidence;
	verification: ReturnType<typeof verifyIncidentEvidence>;
}

export async function createIncidentRun(
	storagePool: PoolType,
	databaseUrl: string,
	scenario: IncidentScenario,
): Promise<IncidentRunResult> {
	const runId = randomUUID();
	const schema = `incident_${runId.replaceAll("-", "")}`;
	const admin = new Pool({ connectionString: databaseUrl });
	await admin.query(`CREATE SCHEMA ${schema}`);
	const pool = new Pool({
		connectionString: databaseUrl,
		options: `-c search_path=${schema}`,
	});
	try {
		await migrate(pool);
		const job = await createDraftJob(pool, {
			title: `Incident ${scenario} ${runId}`,
			gross: 10000n,
			platformFee: 1000n,
			allocations: [{ contractorId: "contractor_mara", amount: 9000n }],
		});
		await approveJob(pool, job.id);
		const obligationResult = await pool.query<{ id: string }>(
			"SELECT id FROM obligations WHERE job_id = $1",
			[job.id],
		);
		const obligationId = obligationResult.rows[0]?.id;
		if (!obligationId) throw new Error("Incident obligation was not created.");

		const observations: IncidentEvidence["observations"] = [];
		let attemptId = "";
		let transferId = "";
		let requestKey = "";
		if (scenario === "lost_response") {
			const lost = await simulateLostProviderResponse(pool, obligationId);
			attemptId = lost.attemptId;
			await retryUnknownPayoutAttempt(pool, attemptId, { mode: "replay" });
			const attempt = await readAttempt(pool, attemptId);
			transferId = attempt.provider_transfer_id ?? "";
			requestKey = attempt.idempotency_key;
			observations.push(
				{
					sequence: 1,
					kind: "provider_accepted",
					value: "accepted",
					transferId,
				},
				{ sequence: 2, kind: "response_lost", value: "unknown", transferId },
				{ sequence: 3, kind: "recovered", value: "submitted", transferId },
			);
		} else if (scenario === "missing_ledger") {
			const missing = await simulateMissingLedgerEntry(pool, obligationId);
			attemptId = missing.attemptId;
			transferId = missing.providerTransferId;
			requestKey = (await readAttempt(pool, attemptId)).idempotency_key;
			const reportId = `incident_${runId}`;
			await importSettlementReport(pool, reportId, [
				{
					effective_at: new Date().toISOString(),
					bank_account_id: "bacc_replay_fixture",
					transaction_id: transferId,
					transaction_type: "ach.outgoing_transfer.settled",
					currency: "USD",
					available_amount: "-9000",
				},
			]);
			await repairSettledPayoutLedger(pool, reportId, 1, "bacc_replay_fixture");
			observations.push(
				{
					sequence: 1,
					kind: "report_settlement",
					value: "settled",
					transferId,
				},
				{
					sequence: 2,
					kind: "ledger_repaired",
					value: "append_only",
					transferId,
				},
			);
		} else {
			const batch = await createPayoutBatch(pool, [obligationId]);
			const attempt = batch.attempts[0];
			if (!attempt) throw new Error("Incident payout attempt was not created.");
			attemptId = attempt.id;
			requestKey = attempt.idempotencyKey;
			await submitPayoutBatch(pool, batch.id, { mode: "replay" });
			transferId =
				(await readAttempt(pool, attemptId)).provider_transfer_id ?? "";
			await resolvePayoutAttempt(pool, attemptId, "settled");
			await resolvePayoutAttempt(pool, attemptId, "returned", "R29");
			observations.push(
				{ sequence: 1, kind: "provider_status", value: "settled", transferId },
				{ sequence: 2, kind: "provider_status", value: "returned", transferId },
			);
		}

		const evidence = await collectEvidence(pool, {
			runId,
			scenario,
			amountMinor: "9000",
			observations,
			attemptId,
			transferId,
			requestKey,
			jobId: job.id,
		});
		const verification = verifyIncidentEvidence(evidence);
		if (!verification.valid) {
			throw new Error(
				`Incident evidence failed verification: ${verification.findings.join(" ")}`,
			);
		}
		await storagePool.query(
			`INSERT INTO incident_runs (id, scenario, source, evidence)
			 VALUES ($1, $2, 'replay', $3::jsonb)`,
			[runId, scenario, JSON.stringify(evidence)],
		);
		return { evidence, verification };
	} finally {
		await pool.end();
		await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await admin.end();
	}
}

export async function getIncidentRun(
	pool: PoolType,
	runId: string,
): Promise<IncidentRunResult> {
	const result = await pool.query<{ evidence: IncidentEvidence }>(
		"SELECT evidence FROM incident_runs WHERE id = $1",
		[runId],
	);
	const evidence = result.rows[0]?.evidence;
	if (!evidence) throw new Error("Incident run not found.");
	return { evidence, verification: verifyIncidentEvidence(evidence) };
}

async function readAttempt(
	pool: PoolType,
	attemptId: string,
): Promise<{ provider_transfer_id: string | null; idempotency_key: string }> {
	const result = await pool.query<{
		provider_transfer_id: string | null;
		idempotency_key: string;
	}>(
		"SELECT provider_transfer_id, idempotency_key FROM payout_attempts WHERE id = $1",
		[attemptId],
	);
	const attempt = result.rows[0];
	if (!attempt) throw new Error("Incident payout attempt was not found.");
	return attempt;
}

async function collectEvidence(
	pool: PoolType,
	input: {
		runId: string;
		scenario: IncidentScenario;
		amountMinor: string;
		observations: IncidentEvidence["observations"];
		attemptId: string;
		transferId: string;
		requestKey: string;
		jobId: string;
	},
): Promise<IncidentEvidence> {
	const journals = await pool.query<IncidentEvidence["journals"][number]>(
		`SELECT lj.source_type AS "sourceType", lj.source_id AS "sourceId",
		        json_agg(json_build_object(
		          'account', le.account,
		          'debitMinor', le.debit_minor::text,
		          'creditMinor', le.credit_minor::text
		        ) ORDER BY le.id) AS lines
		 FROM ledger_journals lj JOIN ledger_entries le ON le.journal_id = lj.id
		 WHERE lj.source_id = ANY($1::text[])
		 GROUP BY lj.id ORDER BY lj.source_type, lj.source_id`,
		[[input.jobId, input.attemptId]],
	);
	return {
		version: 1,
		runId: input.runId,
		scenario: input.scenario,
		source: "replay",
		amountMinor: input.amountMinor,
		openingBankCashMinor: "1000000",
		openingFeeRevenueMinor: "0",
		feeRevenueMinor: "1000",
		observations: input.observations,
		requestKeys: [input.requestKey],
		attemptIds: [input.attemptId],
		transferIds: [input.transferId],
		journals: journals.rows,
	};
}
