import { Pool } from "pg";

export const database = new Pool({
	connectionString:
		process.env.DATABASE_URL ??
		"postgres://money_trace:money_trace@127.0.0.1:5432/money_trace",
});
