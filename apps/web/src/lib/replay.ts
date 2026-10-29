export interface ReplayEvent {
	eventId: string;
	eventType: string;
	transferId: string;
	payload: { simulated: true; outcome: "settled" };
}

export interface ReplayEventResult {
	received: boolean;
	duplicate: boolean;
}

export async function simulateDuplicateEventDelivery(
	deliver: (event: ReplayEvent) => Promise<ReplayEventResult>,
): Promise<{ first: ReplayEventResult; second: ReplayEventResult }> {
	const event: ReplayEvent = {
		eventId: crypto.randomUUID(),
		eventType: "ach.outgoing_transfer.settled",
		transferId: "acht_failure_lab_sample",
		payload: { simulated: true, outcome: "settled" },
	};
	return {
		first: await deliver(event),
		second: await deliver(event),
	};
}
