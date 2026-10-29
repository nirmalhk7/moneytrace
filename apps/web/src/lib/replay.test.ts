import { describe, expect, it } from "vitest";

import { simulateDuplicateEventDelivery } from "./replay";

describe("duplicate webhook replay", () => {
	it("sends the same uniquely identified event twice", async () => {
		const delivered: unknown[] = [];
		await simulateDuplicateEventDelivery(async (event) => {
			delivered.push(event);
			return {
				received: delivered.length === 1,
				duplicate: delivered.length > 1,
			};
		});

		expect(delivered).toHaveLength(2);
		expect(delivered[0]).toEqual(delivered[1]);
		expect(delivered[0]).toMatchObject({
			eventType: "ach.outgoing_transfer.settled",
			payload: { simulated: true },
		});
	});
});
