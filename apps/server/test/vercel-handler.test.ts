import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createVercelHandler } from "../src/vercel-handler";

describe("Vercel request handler", () => {
	it("restores the original API path after Vercel routes a nested path to one function", async () => {
		const server = new EventEmitter();
		const request = {
			url: "/api/index?__money_trace_path=jobs%2Fjob-123%2Fapprove&source=ui",
		} as never;
		const response = {} as never;
		const handler = createVercelHandler({
			ready: async () => undefined,
			server,
		});
		let forwardedUrl: string | undefined;
		server.on("request", (forwardedRequest: { url: string }) => {
			forwardedUrl = forwardedRequest.url;
		});

		await handler(request, response);

		expect(forwardedUrl).toBe("/api/jobs/job-123/approve?source=ui");
	});

	it("waits for Fastify startup before forwarding the request", async () => {
		let resolveReady: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const server = new EventEmitter();
		const request = {} as never;
		const response = {} as never;
		const emit = vi.spyOn(server, "emit");
		const handler = createVercelHandler({
			ready: () => ready,
			server,
		});

		const invocation = handler(request, response);
		expect(emit).not.toHaveBeenCalled();

		resolveReady?.();
		await invocation;

		expect(emit).toHaveBeenCalledWith("request", request, response);
	});
});
