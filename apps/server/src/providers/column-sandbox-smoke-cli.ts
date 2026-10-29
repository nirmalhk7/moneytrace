import { verifyColumnSandboxConnection } from "./column-sandbox-smoke";

try {
	const result = await verifyColumnSandboxConnection({
		apiKey: process.env.COLUMN_API_KEY,
		bankAccountId: process.env.COLUMN_BANK_ACCOUNT_ID,
		counterpartyId: process.env.COLUMN_SMOKE_COUNTERPARTY_ID,
	});
	process.stdout.write(
		`Column sandbox verified: transfer ${result.transferId}, submitted ${result.submittedStatus}, lookup ${result.lookupStatus}.\n`,
	);
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Column sandbox check failed."}\n`,
	);
	process.exitCode = 1;
}
