export interface CreateAchTransferInput {
	apiKey: string;
	bankAccountId: string;
	counterpartyId: string;
	amount: bigint;
	description: string;
	idempotencyKey: string;
}

export type ColumnAchTransferRequest = Omit<CreateAchTransferInput, "apiKey">;

export interface ColumnTransfer {
	id: string;
	status: string;
	returnCode?: string | null;
}

export class ColumnApiError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTransfer(payload: unknown): ColumnTransfer {
	if (!isObject(payload)) {
		throw new Error("Column returned an invalid ACH transfer response.");
	}
	const id = payload.id;
	const status = payload.status;
	if (typeof id !== "string" || typeof status !== "string") {
		throw new Error("Column returned an invalid ACH transfer response.");
	}
	return {
		id,
		status,
		...(typeof payload.return_code === "string"
			? { returnCode: payload.return_code }
			: {}),
	};
}

function parseColumnError(payload: unknown, fallback: string): string {
	if (!isObject(payload)) return fallback;
	if (typeof payload.message === "string") return payload.message;
	if (typeof payload.error === "string") return payload.error;
	return fallback;
}

export async function createAchTransfer(
	input: CreateAchTransferInput,
	fetcher: typeof fetch = fetch,
): Promise<ColumnTransfer> {
	const body = new URLSearchParams({
		bank_account_id: input.bankAccountId,
		counterparty_id: input.counterpartyId,
		amount: input.amount.toString(),
		currency_code: "USD",
		description: input.description,
		type: "CREDIT",
		entry_class_code: "CCD",
	});
	const response = await fetcher("https://api.column.com/transfers/ach", {
		method: "POST",
		headers: {
			Authorization: `Basic ${Buffer.from(`:${input.apiKey}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
			"Idempotency-Key": input.idempotencyKey,
		},
		body,
	});
	const payload: unknown = await response.json();

	if (!response.ok) {
		throw new ColumnApiError(
			parseColumnError(
				payload,
				`Column rejected the ACH transfer (${response.status}).`,
			),
		);
	}

	return parseTransfer(payload);
}

export async function getAchTransfer(
	apiKey: string,
	transferId: string,
	fetcher: typeof fetch = fetch,
): Promise<ColumnTransfer> {
	const response = await fetcher(
		`https://api.column.com/transfers/ach/${encodeURIComponent(transferId)}`,
		{
			method: "GET",
			headers: {
				Authorization: `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}`,
			},
		},
	);
	const payload: unknown = await response.json();

	if (!response.ok) {
		throw new ColumnApiError(
			parseColumnError(
				payload,
				`Column rejected the transfer lookup (${response.status}).`,
			),
		);
	}

	return parseTransfer(payload);
}
