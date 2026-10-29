const integerFormatter = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 0,
});

export function formatUsd(minorUnits: bigint | number | string): string {
	const amount = BigInt(minorUnits);
	const isNegative = amount < 0n;
	const absolute = isNegative ? -amount : amount;
	const dollars = absolute / 100n;
	const cents = (absolute % 100n).toString().padStart(2, "0");

	return `${isNegative ? "-" : ""}$${integerFormatter.format(dollars)}.${cents}`;
}
