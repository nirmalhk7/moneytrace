import Fastify, { type FastifyInstance } from "fastify";
import { parseUsdAmount } from "@money-trace/domain";
import type { Pool } from "pg";
import { z } from "zod";

import { approveJob, createDraftJob } from "./jobs/store";
import { createPayoutBatch, resolvePayoutAttempt } from "./payouts/store";
import {
	retryUnknownPayoutAttempt,
	simulateMissingLedgerEntry,
	simulateLostProviderResponse,
	submitPayoutBatch,
	syncPayoutBatch,
} from "./payouts/submissions";
import { migrate } from "./database/migrate";
import {
	getReconciliation,
	importSettlementReport,
} from "./reconciliation/store";
import { repairSettledPayoutLedger } from "./reconciliation/repairs";
import { receiveReplayEvent } from "./reconciliation/events";
import { createIncidentRun, getIncidentRun } from "./incidents/runs";

export interface AppConfig {
	bankMode: "replay" | "column";
	columnApiKey?: string | undefined;
	columnBankAccountId?: string | undefined;
	columnFetcher?: typeof fetch | undefined;
	databaseUrl?: string | undefined;
	migrationPool?: Pool | undefined;
}

const createJobSchema = z.object({
	title: z.string().trim().min(1).max(160),
	gross: z.string(),
	platformFee: z.string(),
	allocations: z
		.array(z.object({ contractorId: z.string().min(1), amount: z.string() }))
		.min(1),
});

const payoutBatchSchema = z.object({
	obligationIds: z.array(z.string().uuid()).min(1),
	replayOutcome: z.enum(["settled", "returned"]).optional(),
});

const resolveSchema = z.object({ result: z.enum(["settled", "returned"]) });

const reportAmountSchema = z.union([
	z.string().regex(/^-?\d+$/),
	z
		.number()
		.int()
		.refine(Number.isSafeInteger, "Column amount must be an exact integer.")
		.transform(String),
]);

const settlementReportSchema = z.object({
	reportId: z.string().trim().min(1).max(160),
	rows: z
		.array(
			z.object({
				effective_at: z
					.string()
					.refine((value) => !Number.isNaN(Date.parse(value))),
				bank_account_id: z.string().min(1).max(160),
				transaction_id: z.string().min(1).max(160),
				transaction_type: z.string().min(1).max(160),
				currency: z.literal("USD"),
				available_amount: reportAmountSchema,
			}),
		)
		.min(1),
});

const ledgerRepairSchema = z.object({
	reportId: z.string().trim().min(1).max(160),
	rowNumber: z.number().int().positive(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		throw new Error(parsed.error.issues[0]?.message ?? "Request is invalid.");
	}
	return parsed.data;
}

export function buildApp(pool: Pool, config: AppConfig): FastifyInstance {
	const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

	app.setErrorHandler((error, _request, reply) => {
		const message =
			error instanceof Error ? error.message : "Unexpected server error.";
		const status = message.includes("not found") ? 404 : 400;
		void reply.status(status).send({ error: message });
	});

	registerReadRoutes(app, pool, config);
	registerJobRoutes(app, pool);
	registerPayoutRoutes(app, pool, config);
	registerPayoutRecoveryRoutes(app, pool, config);
	registerPayoutSyncRoutes(app, pool, config);
	registerContractorRoutes(app, pool);
	registerReconciliationRoutes(app, pool, config);
	registerIncidentRoutes(app, pool, config);
	app.addHook("onReady", async () => migrate(config.migrationPool ?? pool));
	if (config.migrationPool && config.migrationPool !== pool) {
		app.addHook("onClose", async () => config.migrationPool?.end());
	}
	return app;
}

function registerIncidentRoutes(
	app: FastifyInstance,
	pool: Pool,
	config: AppConfig,
): void {
	app.post("/api/incidents/runs", async (request, reply) => {
		if (!config.databaseUrl) {
			throw new Error("Incident replay requires a configured database URL.");
		}
		const body = parseBody(
			z.object({
				scenario: z.enum(["lost_response", "missing_ledger", "late_return"]),
			}),
			request.body,
		);
		const result = await createIncidentRun(
			pool,
			config.databaseUrl,
			body.scenario,
		);
		return reply.status(201).send(result);
	});

	app.get<{ Params: { runId: string } }>(
		"/api/incidents/runs/:runId",
		async (request) => {
			if (!z.string().uuid().safeParse(request.params.runId).success) {
				throw new Error("Incident run ID must be a UUID.");
			}
			return getIncidentRun(pool, request.params.runId);
		},
	);
}

function registerReadRoutes(
	app: FastifyInstance,
	pool: Pool,
	config: AppConfig,
): void {
	app.get("/health", async () => ({ status: "ok" }));

	app.get("/api/overview", async () => {
		const [balances, contractors, jobs, obligations, batches] =
			await Promise.all([
				pool.query<{
					bank_cash: string;
					reserved_cash: string;
					unallocated_funds: string;
					outstanding_payables: string;
					money_in_transit: string;
				}>(`
				SELECT
				  COALESCE(sum(debit_minor - credit_minor) FILTER (WHERE account = 'bank_cash'), 0)::text AS bank_cash,
				  COALESCE((SELECT sum(amount_minor) FROM payout_attempts
				    WHERE status IN ('queued', 'submitting', 'unknown', 'initiated', 'submitted')), 0)::text AS reserved_cash,
				  COALESCE(sum(credit_minor - debit_minor) FILTER (WHERE account = 'unallocated_customer_funds'), 0)::text AS unallocated_funds,
				  COALESCE(sum(credit_minor - debit_minor) FILTER (WHERE account = 'contractor_payable'), 0)::text AS outstanding_payables,
				  COALESCE(sum(credit_minor - debit_minor) FILTER (WHERE account = 'money_in_transit'), 0)::text AS money_in_transit
				FROM ledger_entries
			`),
				pool.query(
					`SELECT id, name, active, column_counterparty_id AS "columnCounterpartyId"
				 FROM contractors ORDER BY name`,
				),
				pool.query(
					`SELECT j.id, j.title, j.gross_minor::text AS gross,
				        j.platform_fee_minor::text AS "platformFee", j.status,
				        j.created_at AS "createdAt",
				        COALESCE(json_agg(json_build_object(
				          'contractorId', a.contractor_id, 'contractorName', c.name,
				          'amount', a.amount_minor::text
				        )) FILTER (WHERE a.contractor_id IS NOT NULL), '[]') AS allocations
				 FROM jobs j
			 LEFT JOIN job_allocations a ON a.job_id = j.id
			 LEFT JOIN contractors c ON c.id = a.contractor_id
			 GROUP BY j.id ORDER BY j.created_at DESC LIMIT 12`,
				),
				pool.query(
					`SELECT o.id, o.job_id AS "jobId", j.title AS "jobTitle",
				        o.contractor_id AS "contractorId", c.name AS "contractorName",
				        o.amount_minor::text AS amount, o.status,
				        o.created_at AS "createdAt",
				        (SELECT pa.id FROM payout_attempts pa
				         WHERE pa.obligation_id = o.id ORDER BY pa.attempt_number DESC LIMIT 1) AS "latestAttemptId",
				        (SELECT pa.status FROM payout_attempts pa
				         WHERE pa.obligation_id = o.id ORDER BY pa.attempt_number DESC LIMIT 1) AS "latestAttemptStatus",
				        (SELECT pa.error_message FROM payout_attempts pa
				         WHERE pa.obligation_id = o.id ORDER BY pa.attempt_number DESC LIMIT 1) AS "latestError"
				 FROM obligations o JOIN jobs j ON j.id = o.job_id
			 JOIN contractors c ON c.id = o.contractor_id
			 WHERE o.status <> 'paid' ORDER BY o.created_at DESC`,
				),
				pool.query(
					`SELECT pb.id, pb.status, pb.created_at AS "createdAt",
			        json_agg(json_build_object(
			          'id', pa.id, 'amount', pa.amount_minor::text, 'status', pa.status,
			          'providerTransferId', pa.provider_transfer_id,
			          'errorMessage', pa.error_message, 'returnCode', pa.return_code,
			          'obligationId', o.id, 'contractorName', c.name, 'jobTitle', j.title
			        ) ORDER BY c.name) AS attempts
				 FROM payout_batches pb
			 JOIN payout_attempts pa ON pa.batch_id = pb.id
			 JOIN obligations o ON o.id = pa.obligation_id
			 JOIN contractors c ON c.id = o.contractor_id
			 JOIN jobs j ON j.id = o.job_id
			 GROUP BY pb.id ORDER BY pb.created_at DESC LIMIT 10`,
				),
			]);

		return {
			balances: {
				bankCash: balances.rows[0]?.bank_cash ?? "0",
				availableCash: (
					BigInt(balances.rows[0]?.bank_cash ?? "0") -
					BigInt(balances.rows[0]?.reserved_cash ?? "0")
				).toString(),
				unallocatedFunds: balances.rows[0]?.unallocated_funds ?? "0",
				outstandingPayables: balances.rows[0]?.outstanding_payables ?? "0",
				moneyInTransit: balances.rows[0]?.money_in_transit ?? "0",
			},
			bankMode: config.bankMode,
			contractors: contractors.rows,
			jobs: jobs.rows,
			obligations: obligations.rows,
			batches: batches.rows,
		};
	});
}

function registerJobRoutes(app: FastifyInstance, pool: Pool): void {
	app.post("/api/jobs", async (request, reply) => {
		const body = parseBody(createJobSchema, request.body);
		const job = await createDraftJob(pool, {
			title: body.title,
			gross: parseUsdAmount(body.gross),
			platformFee: parseUsdAmount(body.platformFee),
			allocations: body.allocations.map((allocation) => ({
				contractorId: allocation.contractorId,
				amount: parseUsdAmount(allocation.amount),
			})),
		});
		return reply.status(201).send({
			...job,
			gross: job.gross.toString(),
			platformFee: job.platformFee.toString(),
		});
	});

	app.post<{ Params: { jobId: string } }>(
		"/api/jobs/:jobId/approve",
		async (request) => {
			const job = await approveJob(pool, request.params.jobId);
			return {
				...job,
				gross: job.gross.toString(),
				platformFee: job.platformFee.toString(),
			};
		},
	);

	app.get<{ Querystring: { status?: string } }>(
		"/api/obligations",
		async (request) => {
			const status = request.query.status;
			if (status && status !== "due" && status !== "in_progress") {
				throw new Error("Obligation status must be due or in_progress.");
			}
			return pool
				.query(
					`SELECT o.id, o.job_id AS "jobId", j.title AS "jobTitle",
				        o.contractor_id AS "contractorId", c.name AS "contractorName",
				        o.amount_minor::text AS amount, o.status,
				        o.created_at AS "createdAt",
				        (SELECT pa.id FROM payout_attempts pa
				         WHERE pa.obligation_id = o.id ORDER BY pa.attempt_number DESC LIMIT 1) AS "latestAttemptId",
				        (SELECT pa.status FROM payout_attempts pa
				         WHERE pa.obligation_id = o.id ORDER BY pa.attempt_number DESC LIMIT 1) AS "latestAttemptStatus",
				        (SELECT pa.error_message FROM payout_attempts pa
				         WHERE pa.obligation_id = o.id ORDER BY pa.attempt_number DESC LIMIT 1) AS "latestError"
				 FROM obligations o JOIN jobs j ON j.id = o.job_id
				 JOIN contractors c ON c.id = o.contractor_id
				 WHERE o.status <> 'paid' AND ($1::text IS NULL OR o.status = $1)
				 ORDER BY o.created_at DESC`,
					[status ?? null],
				)
				.then((result) => result.rows);
		},
	);
}

function registerPayoutRoutes(
	app: FastifyInstance,
	pool: Pool,
	config: AppConfig,
): void {
	app.post("/api/payout-batches", async (request, reply) => {
		const body = parseBody(payoutBatchSchema, request.body);
		const batch = await createPayoutBatch(pool, body.obligationIds);
		await submitPayoutBatch(pool, batch.id, {
			mode: config.bankMode,
			outcome: body.replayOutcome,
			columnApiKey: config.columnApiKey,
			columnBankAccountId: config.columnBankAccountId,
		});
		return reply.status(201).send({ id: batch.id });
	});

	app.post<{ Params: { attemptId: string } }>(
		"/api/payout-attempts/:attemptId/resolve",
		async (request) => {
			if (config.bankMode !== "replay") {
				throw new Error(
					"Manual outcome simulation is available only in replay mode.",
				);
			}
			const body = parseBody(resolveSchema, request.body);
			await resolvePayoutAttempt(pool, request.params.attemptId, body.result);
			return { status: body.result };
		},
	);

	app.post<{ Params: { obligationId: string } }>(
		"/api/obligations/:obligationId/retry",
		async (request, reply) => {
			const batch = await createPayoutBatch(pool, [
				request.params.obligationId,
			]);
			await submitPayoutBatch(pool, batch.id, {
				mode: config.bankMode,
				columnApiKey: config.columnApiKey,
				columnBankAccountId: config.columnBankAccountId,
			});
			return reply.status(201).send({ id: batch.id });
		},
	);
}

function registerPayoutRecoveryRoutes(
	app: FastifyInstance,
	pool: Pool,
	config: AppConfig,
): void {
	app.post<{ Params: { attemptId: string } }>(
		"/api/payout-attempts/:attemptId/recover",
		async (request) => {
			if (config.bankMode === "column" && !config.columnApiKey) {
				throw new Error(
					"Unknown-response recovery requires Column sandbox mode and an API key.",
				);
			}
			const status = await retryUnknownPayoutAttempt(
				pool,
				request.params.attemptId,
				{
					mode: config.bankMode,
					columnApiKey: config.columnApiKey,
					columnBankAccountId: config.columnBankAccountId,
					fetcher: config.columnFetcher,
				},
			);
			return { status };
		},
	);
	app.post("/api/replay/lost-response", async (request, reply) => {
		if (config.bankMode !== "replay") {
			throw new Error(
				"Lost-response simulation is available only in replay mode.",
			);
		}
		const body = parseBody(
			z.object({ obligationId: z.string().uuid() }),
			request.body,
		);
		const result = await simulateLostProviderResponse(pool, body.obligationId);
		return reply.status(201).send(result);
	});
	app.post("/api/replay/missing-ledger", async (request, reply) => {
		if (config.bankMode !== "replay") {
			throw new Error(
				"Missing-ledger simulation is available only in replay mode.",
			);
		}
		const body = parseBody(
			z.object({ obligationId: z.string().uuid() }),
			request.body,
		);
		const result = await simulateMissingLedgerEntry(pool, body.obligationId);
		return reply.status(201).send(result);
	});
}

function registerPayoutSyncRoutes(
	app: FastifyInstance,
	pool: Pool,
	config: AppConfig,
): void {
	app.post<{ Params: { batchId: string } }>(
		"/api/payout-batches/:batchId/sync",
		async (request) => {
			if (config.bankMode !== "column" || !config.columnApiKey) {
				throw new Error(
					"Column transfer sync requires Column sandbox mode and an API key.",
				);
			}
			return syncPayoutBatch(pool, request.params.batchId, {
				apiKey: config.columnApiKey,
				fetcher: config.columnFetcher,
			});
		},
	);
}

function registerContractorRoutes(app: FastifyInstance, pool: Pool): void {
	app.patch<{ Params: { contractorId: string } }>(
		"/api/contractors/:contractorId",
		async (request) => {
			const body = parseBody(
				z.object({
					columnCounterpartyId: z.string().trim().max(128).nullable(),
				}),
				request.body,
			);
			const contractor = await pool.query(
				`UPDATE contractors SET column_counterparty_id = $2
				 WHERE id = $1 RETURNING id, name, column_counterparty_id AS "columnCounterpartyId"`,
				[request.params.contractorId, body.columnCounterpartyId || null],
			);
			if (!contractor.rowCount) {
				throw new Error("Contractor not found.");
			}
			return contractor.rows[0];
		},
	);
}

function registerReconciliationRoutes(
	app: FastifyInstance,
	pool: Pool,
	config: AppConfig,
): void {
	app.post("/api/reconciliation/reports", async (request, reply) => {
		const body = parseBody(settlementReportSchema, request.body);
		const importedRows = await importSettlementReport(
			pool,
			body.reportId,
			body.rows.map((row) => ({
				...row,
				available_amount: String(row.available_amount),
			})),
		);
		return reply
			.status(importedRows > 0 ? 201 : 200)
			.send({ reportId: body.reportId, importedRows });
	});

	app.get<{ Querystring: { reportId?: string } }>(
		"/api/reconciliation",
		async (request) => getReconciliation(pool, request.query.reportId),
	);

	app.post("/api/reconciliation/repairs", async (request) => {
		const body = parseBody(ledgerRepairSchema, request.body);
		if (config.bankMode === "column" && !config.columnBankAccountId) {
			throw new Error(
				"Configure the Column bank account ID before repairing ledger entries.",
			);
		}
		return repairSettledPayoutLedger(
			pool,
			body.reportId,
			body.rowNumber,
			config.columnBankAccountId,
		);
	});

	app.post("/api/replay/events", async (request, reply) => {
		if (config.bankMode !== "replay") {
			throw new Error(
				"Replay event delivery is available only in replay mode.",
			);
		}
		const body = parseBody(
			z.object({
				eventId: z.string().trim().min(1).max(160),
				eventType: z.string().trim().min(1).max(160),
				transferId: z.string().trim().min(1).max(160).nullable(),
				payload: z.record(z.string(), z.unknown()),
			}),
			request.body,
		);
		const received = await receiveReplayEvent(pool, body);
		return reply
			.status(received ? 202 : 200)
			.send({ received, duplicate: !received });
	});
}

export async function startServer(): Promise<void> {
	const pool = new (await import("pg")).Pool({
		connectionString:
			process.env.DATABASE_URL ??
			"postgres://money_trace:money_trace@127.0.0.1:5432/money_trace",
	});
	const app = buildApp(pool, {
		bankMode: process.env.BANK_MODE === "column" ? "column" : "replay",
		columnApiKey: process.env.COLUMN_API_KEY,
		columnBankAccountId: process.env.COLUMN_BANK_ACCOUNT_ID,
		databaseUrl:
			process.env.DATABASE_URL ??
			"postgres://money_trace:money_trace@127.0.0.1:5432/money_trace",
	});
	const port = Number(process.env.PORT ?? "3001");
	await app.listen({ host: "127.0.0.1", port });

	const close = async (): Promise<void> => {
		await app.close();
		await pool.end();
	};
	process.once("SIGINT", () => void close());
	process.once("SIGTERM", () => void close());
}
