const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
const USD_AMOUNT_FORMAT_ERROR =
	"Enter a USD amount with at most two decimal places.";

export interface JobAllocation {
	gross: bigint;
	contractorAmounts: readonly bigint[];
	platformFee: bigint;
}

export function parseUsdAmount(input: string): bigint {
	if (input.startsWith("-")) {
		throw new Error("Enter a non-negative USD amount.");
	}

	const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input);

	if (!match) {
		throw new Error(USD_AMOUNT_FORMAT_ERROR);
	}

	const wholeDollars = BigInt(match[1] ?? "0");
	const fraction = (match[2] ?? "").padEnd(2, "0");
	const minorUnits = wholeDollars * 100n + BigInt(fraction || "0");

	if (minorUnits > POSTGRES_INT8_MAX) {
		throw new Error("USD amount exceeds the supported limit.");
	}

	return minorUnits;
}

export function assertJobAllocation({
	gross,
	contractorAmounts,
	platformFee,
}: JobAllocation): void {
	if (gross <= 0n) {
		throw new Error("Job gross must be greater than zero.");
	}

	if (contractorAmounts.length === 0) {
		throw new Error("Add at least one contractor allocation.");
	}

	if (contractorAmounts.some((amount) => amount <= 0n)) {
		throw new Error("Contractor allocations must be greater than zero.");
	}

	if (platformFee < 0n) {
		throw new Error("Platform fee cannot be negative.");
	}

	if (
		gross > POSTGRES_INT8_MAX ||
		platformFee > POSTGRES_INT8_MAX ||
		contractorAmounts.some((amount) => amount > POSTGRES_INT8_MAX)
	) {
		throw new Error("Job allocation exceeds the supported limit.");
	}

	const allocated =
		contractorAmounts.reduce((sum, amount) => sum + amount, 0n) + platformFee;

	if (allocated !== gross) {
		throw new Error(
			"Contractor amounts and platform fee must equal job gross.",
		);
	}
}
