import { describe, expect, it } from "vitest";

import {
	normalizeIncidentEvidence,
	verifyIncidentEvidence,
} from "../src/incident-evidence";
import type { IncidentEvidence } from "../src/incident-evidence";

const validReturnIncident: IncidentEvidence = {
	version: 1,
	runId: "run-1",
	scenario: "late_return",
	source: "replay",
	amountMinor: "9000",
	openingBankCashMinor: "1000000",
	openingFeeRevenueMinor: "0",
	feeRevenueMinor: "1000",
	observations: [
		{
			sequence: 1,
			kind: "provider_status",
			value: "settled",
			transferId: "acht-1",
		},
		{
			sequence: 2,
			kind: "provider_status",
			value: "returned",
			transferId: "acht-1",
		},
	],
	requestKeys: ["key-1"],
	attemptIds: ["attempt-1"],
	transferIds: ["acht-1"],
	journals: [
		{
			sourceType: "job_approved",
			sourceId: "job-1",
			lines: [
				{
					account: "unallocated_customer_funds",
					debitMinor: "10000",
					creditMinor: "0",
				},
				{ account: "contractor_payable", debitMinor: "0", creditMinor: "9000" },
				{ account: "fee_revenue", debitMinor: "0", creditMinor: "1000" },
			],
		},
		{
			sourceType: "payout_submitted",
			sourceId: "attempt-1",
			lines: [
				{ account: "contractor_payable", debitMinor: "9000", creditMinor: "0" },
				{ account: "money_in_transit", debitMinor: "0", creditMinor: "9000" },
			],
		},
		{
			sourceType: "payout_settled",
			sourceId: "attempt-1",
			lines: [
				{ account: "money_in_transit", debitMinor: "9000", creditMinor: "0" },
				{ account: "bank_cash", debitMinor: "0", creditMinor: "9000" },
			],
		},
		{
			sourceType: "payout_returned",
			sourceId: "attempt-1",
			lines: [
				{ account: "bank_cash", debitMinor: "9000", creditMinor: "0" },
				{ account: "contractor_payable", debitMinor: "0", creditMinor: "9000" },
			],
		},
	],
};

describe("incident evidence verifier", () => {
	it("accepts a balanced late-return lifecycle", () => {
		expect(verifyIncidentEvidence(validReturnIncident)).toEqual({
			valid: true,
			findings: [],
		});
	});

	it("rejects a late return without a balanced cash-restoration journal", () => {
		const corrupted: IncidentEvidence = {
			...validReturnIncident,
			journals: validReturnIncident.journals.map((journal) =>
				journal.sourceType === "payout_returned"
					? {
							...journal,
							lines: journal.lines.map((line) => ({
								...line,
								debitMinor: "0",
							})),
						}
					: journal,
			),
		};

		const result = verifyIncidentEvidence(corrupted);
		expect(result.valid).toBe(false);
		expect(result.findings).toContain(
			"Journal payout_returned:attempt-1 is not balanced.",
		);
	});

	it("rejects settlement and return evidence for different transfers", () => {
		const corrupted: IncidentEvidence = {
			...validReturnIncident,
			observations: validReturnIncident.observations.map(
				(observation, index) =>
					index === 1
						? { ...observation, transferId: "acht-other" }
						: observation,
			),
		};

		expect(verifyIncidentEvidence(corrupted).valid).toBe(false);
	});

	it("rejects a late-return bundle that reverses earned platform fee", () => {
		const corrupted = { ...validReturnIncident, feeRevenueMinor: "0" };
		const result = verifyIncidentEvidence(corrupted);

		expect(result.valid).toBe(false);
		expect(result.findings).toContain(
			"Late return changed earned fee revenue.",
		);
	});

	it("normalizes run-specific IDs for reproducible comparisons", () => {
		const secondRun: IncidentEvidence = {
			...validReturnIncident,
			runId: "run-2",
			attemptIds: ["attempt-2"],
			transferIds: ["acht-2"],
			requestKeys: ["key-2"],
			observations: validReturnIncident.observations.map((observation) => ({
				...observation,
				transferId: "acht-2",
			})),
			journals: validReturnIncident.journals.map((journal) => ({
				...journal,
				sourceId: journal.sourceType === "job_approved" ? "job-2" : "attempt-2",
			})),
		};

		expect(normalizeIncidentEvidence(secondRun)).toEqual(
			normalizeIncidentEvidence(validReturnIncident),
		);
	});
});
