import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const connectionString =
	process.env.TEST_DATABASE_URL ??
	"postgres://money_trace:money_trace@127.0.0.1:5432/money_trace_test";

export async function createIsolatedTestPool(options?: {
	max?: number;
}): Promise<{
	pool: Pool;
	cleanup: () => Promise<void>;
}> {
	const schema = `test_${randomUUID().replaceAll("-", "")}`;
	const admin = new Pool({ connectionString });
	await admin.query(`CREATE SCHEMA ${schema}`);
	const pool = new Pool({
		connectionString,
		options: `-c search_path=${schema}`,
		max: options?.max,
	});

	return {
		pool,
		cleanup: async () => {
			await pool.end();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		},
	};
}
