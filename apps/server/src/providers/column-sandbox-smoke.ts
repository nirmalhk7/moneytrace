import { randomUUID } from "node:crypto";

import { createAchTransfer, getAchTransfer } from "./column";

export interface ColumnSandboxSmokeConfig {
	apiKey: string | undefined;
	bankAccountId: string | undefined;
	counterpartyId: string | undefined;
}

export interface ColumnSandboxSmokeResult {
	transferId: string;
	submittedStatus: string;
	lookupStatus: string;
}

export async function verifyColumnSandboxConnection(
	config: ColumnSandboxSmokeConfig,
	fetcher: typeof fetch = fetch,
): Promise<ColumnSandboxSmokeResult> {
	if (!config.apiKey?.startsWith("test_")) {
		throw new Error(
			"Only a Column sandbox API key beginning with test_ is allowed.",
		);
	}
	if (!config.bankAccountId?.startsWith("bacc_")) {
		throw new Error(
			"A Column sandbox bank account ID beginning with bacc_ is required.",
		);
	}
	if (!config.counterpartyId?.startsWith("cpty_")) {
		throw new Error(
			"A sandbox counterparty ID beginning with cpty_ is required.",
		);
	}

	const idempotencyKey = `column-smoke-${randomUUID()}`;
	const submitted = await createAchTransfer(
		{
			apiKey: config.apiKey,
			bankAccountId: config.bankAccountId,
			counterpartyId: config.counterpartyId,
			amount: 0n,
			description: "Money Trace sandbox ACH prenote",
			idempotencyKey,
		},
		fetcher,
	);
	const lookedUp = await getAchTransfer(config.apiKey, submitted.id, fetcher);
	if (lookedUp.id !== submitted.id) {
		throw new Error("Column ACH lookup returned a different transfer ID.");
	}
	return {
		transferId: submitted.id,
		submittedStatus: submitted.status,
		lookupStatus: lookedUp.status,
	};
}
