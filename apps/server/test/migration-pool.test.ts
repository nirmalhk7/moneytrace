import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app";
import type { Pool } from "pg";

function migrationPool() {
	const query = vi.fn().mockResolvedValue({ rowCount: 1 });
	const client = { query, release: vi.fn() };
	const connect = vi.fn().mockResolvedValue(client);
	return { query, connect, end: vi.fn() } as unknown as Pool & {
		connect: ReturnType<typeof vi.fn>;
		query: ReturnType<typeof vi.fn>;
		end: ReturnType<typeof vi.fn>;
	};
}

describe("app startup migrations", () => {
	it("runs migrations on the direct migration pool when configured", async () => {
		const runtimePool = migrationPool();
		const directPool = migrationPool();
		const app = buildApp(runtimePool, {
			bankMode: "replay",
			migrationPool: directPool,
		});

		await app.ready();
		await app.close();

		expect(directPool.connect).toHaveBeenCalledOnce();
		expect(runtimePool.connect).not.toHaveBeenCalled();
	});
});
