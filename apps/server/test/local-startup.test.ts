import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { startServer } from "../src/app";

let app: FastifyInstance | undefined;

afterEach(async () => {
	await app?.close();
	vi.unstubAllEnvs();
});

describe("local server startup", () => {
	it("starts with the direct migration connection while the runtime connection is unavailable", async () => {
		vi.stubEnv(
			"DATABASE_URL",
			"postgres://invalid:invalid@127.0.0.1:1/invalid",
		);
		vi.stubEnv(
			"DATABASE_URL_UNPOOLED",
			process.env.TEST_DATABASE_URL ??
				"postgres://money_trace:money_trace@127.0.0.1:5432/money_trace_test",
		);
		vi.stubEnv("BANK_MODE", "replay");
		vi.stubEnv("PORT", "0");
		app = await startServer();
		expect(app.server.listening).toBe(true);
	});
});
