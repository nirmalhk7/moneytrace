import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";

export function createVercelPool(connectionString: string): Pool {
	const pool = new Pool({
		connectionString,
		max: 1,
		idleTimeoutMillis: 5_000,
		allowExitOnIdle: true,
	});
	attachDatabasePool(pool);
	return pool;
}
