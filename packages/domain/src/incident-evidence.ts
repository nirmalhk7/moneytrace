export type IncidentScenario =
	| "lost_response"
	| "missing_ledger"
	| "late_return";

export interface IncidentEvidence {
	version: 1;
	runId: string;
	scenario: IncidentScenario;
	source: "replay" | "column_sandbox";
	amountMinor: string;
	openingBankCashMinor: string;
	openingFeeRevenueMinor: string;
	feeRevenueMinor: string;
	observations: Array<{
		sequence: number;
		kind: string;
		value: string;
		transferId: string;
	}>;
	requestKeys: string[];
	attemptIds: string[];
	transferIds: string[];
	journals: Array<{
		sourceType: string;
		sourceId: string;
		lines: Array<{
			account: string;
			debitMinor: string;
			creditMinor: string;
		}>;
	}>;
}

export interface IncidentVerification {
	valid: boolean;
	findings: string[];
}

const isIntegerAmount = (value: string): boolean => /^\d+$/.test(value);

function validateJournal(
	journal: IncidentEvidence["journals"][number],
): boolean {
	let debits = 0n;
	let credits = 0n;
	let valid = journal.lines.length >= 2;
	for (const line of journal.lines) {
		if (
			!isIntegerAmount(line.debitMinor) ||
			!isIntegerAmount(line.creditMinor)
		) {
			valid = false;
			continue;
		}
		const debit = BigInt(line.debitMinor);
		const credit = BigInt(line.creditMinor);
		if (debit > 0n === credit > 0n) valid = false;
		debits += debit;
		credits += credit;
	}
	return valid && debits === credits;
}

function addScenarioFindings(
	evidence: IncidentEvidence,
	findings: string[],
): void {
	switch (evidence.scenario) {
		case "late_return":
			validateLateReturn(evidence, findings);
			break;
		case "lost_response":
			validateLostResponse(evidence, findings);
			break;
		case "missing_ledger":
			validateMissingLedger(evidence, findings);
			break;
	}
}

function validateLateReturn(
	evidence: IncidentEvidence,
	findings: string[],
): void {
	const settled = evidence.observations.find(
		(observation) =>
			observation.kind === "provider_status" && observation.value === "settled",
	);
	const returned = evidence.observations.find(
		(observation) =>
			observation.kind === "provider_status" &&
			observation.value === "returned",
	);
	if (
		!settled ||
		!returned ||
		settled.sequence >= returned.sequence ||
		settled.transferId !== returned.transferId
	) {
		findings.push(
			"Settlement and return must describe same transfer in order.",
		);
	}
	const returnJournals = evidence.journals.filter(
		(journal) => journal.sourceType === "payout_returned",
	);
	if (returnJournals.length !== 1) {
		findings.push("Late return must have exactly one return journal.");
	}
	const lines = evidence.journals.flatMap((journal) => journal.lines);
	const bankDelta = accountDelta(lines, "bank_cash", "debit");
	if (isIntegerAmount(evidence.openingBankCashMinor) && bankDelta !== 0n) {
		findings.push(
			"Returned payout must restore bank cash to its opening balance.",
		);
	}
	const feeDelta = accountDelta(lines, "fee_revenue", "credit");
	const returnedFee = returnJournals.some((journal) =>
		journal.lines.some((line) => line.account === "fee_revenue"),
	);
	const feeEvidenceValid =
		isIntegerAmount(evidence.openingFeeRevenueMinor) &&
		isIntegerAmount(evidence.feeRevenueMinor) &&
		BigInt(evidence.openingFeeRevenueMinor) + feeDelta ===
			BigInt(evidence.feeRevenueMinor);
	if (returnedFee || !feeEvidenceValid) {
		findings.push("Late return changed earned fee revenue.");
	}
}

function accountDelta(
	lines: IncidentEvidence["journals"][number]["lines"],
	account: string,
	positiveSide: "debit" | "credit",
): bigint {
	return lines
		.filter((line) => line.account === account)
		.reduce((total, line) => {
			if (
				!isIntegerAmount(line.debitMinor) ||
				!isIntegerAmount(line.creditMinor)
			) {
				return total;
			}
			const debit = BigInt(line.debitMinor);
			const credit = BigInt(line.creditMinor);
			return (
				total + (positiveSide === "debit" ? debit - credit : credit - debit)
			);
		}, 0n);
}

function validateLostResponse(
	evidence: IncidentEvidence,
	findings: string[],
): void {
	const kinds = new Set(evidence.observations.map(({ kind }) => kind));
	if (
		!kinds.has("provider_accepted") ||
		!kinds.has("response_lost") ||
		!kinds.has("recovered")
	) {
		findings.push(
			"Lost-response evidence must show acceptance, loss, and recovery.",
		);
	}
	if (evidence.requestKeys.length !== 1 || evidence.transferIds.length !== 1) {
		findings.push("Recovery must reuse one request key and one transfer ID.");
	}
	if (
		evidence.journals.filter(
			(journal) => journal.sourceType === "payout_submitted",
		).length !== 1
	) {
		findings.push(
			"Recovery must create exactly one payout submission journal.",
		);
	}
}

function validateMissingLedger(
	evidence: IncidentEvidence,
	findings: string[],
): void {
	const kinds = new Set(evidence.observations.map(({ kind }) => kind));
	if (!kinds.has("report_settlement") || !kinds.has("ledger_repaired")) {
		findings.push(
			"Repair requires settlement report evidence and a repair record.",
		);
	}
	if (
		evidence.journals.filter(
			(journal) => journal.sourceType === "payout_settled",
		).length !== 1 ||
		evidence.attemptIds.length !== 1
	) {
		findings.push(
			"Repair must post one settlement journal without a new attempt.",
		);
	}
}

export function normalizeIncidentEvidence(
	evidence: IncidentEvidence,
): IncidentEvidence {
	const attempts = new Map(
		evidence.attemptIds.map((id, index) => [id, `attempt_${index + 1}`]),
	);
	const transfers = new Map(
		evidence.transferIds.map((id, index) => [id, `transfer_${index + 1}`]),
	);
	const keys = new Map(
		evidence.requestKeys.map((key, index) => [key, `key_${index + 1}`]),
	);
	const jobs = new Map(
		evidence.journals
			.filter((journal) => journal.sourceType === "job_approved")
			.map((journal, index) => [journal.sourceId, `job_${index + 1}`]),
	);
	return {
		...evidence,
		runId: "normalized_run",
		observations: evidence.observations.map((observation) => ({
			...observation,
			transferId:
				transfers.get(observation.transferId) ?? observation.transferId,
		})),
		requestKeys: evidence.requestKeys.map((key) => keys.get(key) ?? key),
		attemptIds: evidence.attemptIds.map((id) => attempts.get(id) ?? id),
		transferIds: evidence.transferIds.map((id) => transfers.get(id) ?? id),
		journals: evidence.journals.map((journal) => ({
			...journal,
			sourceId:
				attempts.get(journal.sourceId) ??
				jobs.get(journal.sourceId) ??
				journal.sourceId,
		})),
	};
}

export function verifyIncidentEvidence(
	evidence: IncidentEvidence,
): IncidentVerification {
	const findings: string[] = [];
	if (evidence.version !== 1) findings.push("Unsupported evidence version.");
	if (!evidence.runId.trim()) findings.push("Run ID is required.");
	if (
		!isIntegerAmount(evidence.amountMinor) ||
		BigInt(evidence.amountMinor) <= 0n
	) {
		findings.push("Payout amount must be a positive integer-cent string.");
	}
	if (!isIntegerAmount(evidence.openingBankCashMinor)) {
		findings.push("Opening bank cash must be an integer-cent string.");
	}
	if (evidence.source !== "replay" && evidence.source !== "column_sandbox") {
		findings.push("Evidence source must identify replay or Column sandbox.");
	}
	if (new Set(evidence.attemptIds).size !== evidence.attemptIds.length) {
		findings.push("Attempt IDs must be unique.");
	}
	if (new Set(evidence.requestKeys).size !== evidence.requestKeys.length) {
		findings.push("Request keys must be unique within a run.");
	}
	if (new Set(evidence.transferIds).size !== evidence.transferIds.length) {
		findings.push("Transfer IDs must be unique within a run.");
	}
	for (const journal of evidence.journals) {
		if (!validateJournal(journal)) {
			findings.push(
				`Journal ${journal.sourceType}:${journal.sourceId} is not balanced.`,
			);
		}
	}
	addScenarioFindings(evidence, findings);
	return { valid: findings.length === 0, findings };
}
