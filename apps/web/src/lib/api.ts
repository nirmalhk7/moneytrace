export async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			...(init?.body === undefined
				? {}
				: { "Content-Type": "application/json" }),
			...init?.headers,
		},
	});
	const body: unknown = await response.json();
	if (!response.ok) {
		const message =
			typeof body === "object" && body !== null && "error" in body
				? String(body.error)
				: "Request could not be completed.";
		throw new Error(message);
	}
	return body as T;
}
