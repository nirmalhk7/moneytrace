import { describe, expect, it, vi } from "vitest";

const { attachDatabasePool } = vi.hoisted(() => ({
	attachDatabasePool: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ attachDatabasePool }));

import { createVercelPool } from "../src/vercel-pool";

describe("Vercel database pool", () => {
	it("registers its reusable pg pool with Vercel Fluid Compute", () => {
		const pool = createVercelPool("postgresql://example.invalid/database");

		expect(attachDatabasePool).toHaveBeenCalledWith(pool);
		void pool.end();
	});
});
