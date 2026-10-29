import { register } from "tsx/esm/api";

register();

const [{ buildApp }, { createVercelHandler }, { createVercelPool }] =
	await Promise.all([
		import("../apps/server/src/app.ts"),
		import("../apps/server/src/vercel-handler.ts"),
		import("../apps/server/src/vercel-pool.ts"),
	]);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL must be configured for the Vercel deployment.");
}

const pool = createVercelPool(databaseUrl);
const directDatabaseUrl = process.env.DATABASE_URL_UNPOOLED ?? databaseUrl;
const migrationPool =
	directDatabaseUrl === databaseUrl
		? pool
		: createVercelPool(directDatabaseUrl);

const app = buildApp(pool, {
	bankMode: process.env.BANK_MODE === "column" ? "column" : "replay",
	columnApiKey: process.env.COLUMN_API_KEY,
	columnBankAccountId: process.env.COLUMN_BANK_ACCOUNT_ID,
	databaseUrl: directDatabaseUrl,
	migrationPool,
});

export default createVercelHandler(app);
