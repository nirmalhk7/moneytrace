import type { IncomingMessage, ServerResponse } from "node:http";

interface RequestServer {
	emit(
		event: "request",
		request: IncomingMessage,
		response: ServerResponse,
	): boolean;
}

interface RequestApp {
	ready(): Promise<unknown>;
	server: RequestServer;
}

export function createVercelHandler(app: RequestApp) {
	return async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		await app.ready();
		if (request.url) {
			const url = new URL(request.url, "http://vercel.local");
			const routedPath = url.searchParams.get("__money_trace_path");
			if (routedPath !== null) {
				url.searchParams.delete("__money_trace_path");
				const query = url.searchParams.toString();
				request.url = `/api/${routedPath.replace(/^\/+/, "")}${query ? `?${query}` : ""}`;
			}
		}
		app.server.emit("request", request, response);
	};
}
