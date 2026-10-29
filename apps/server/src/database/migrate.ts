import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";

const migrationsDirectory = join(
	dirname(fileURLToPath(import.meta.url)),
	"migrations",
);

export async function migrate(pool: Pool): Promise<void> {
	const migrationFiles = (await readdir(migrationsDirectory))
		.filter((name) => name.endsWith(".sql"))
		.sort();
	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtext('money-trace:migrations'))",
		);
		await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

		for (const name of migrationFiles) {
			const applied = await client.query(
				"SELECT 1 FROM schema_migrations WHERE name = $1",
				[name],
			);

			if (applied.rowCount) {
				continue;
			}

			const sql = await readFile(join(migrationsDirectory, name), "utf8");
			await client.query(sql);
			await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
				name,
			]);
		}

		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
