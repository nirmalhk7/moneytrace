import type { Pool } from "pg";

export async function receiveReplayEvent(
	pool: Pool,
	event: {
		eventId: string;
		eventType: string;
		transferId: string | null;
		payload: Record<string, unknown>;
	},
): Promise<boolean> {
	const result = await pool.query<{ event_id: string }>(
		`INSERT INTO event_inbox (event_id, event_type, transfer_id, payload)
		 VALUES ($1, $2, $3, $4::jsonb)
		 ON CONFLICT (event_id) DO NOTHING
		 RETURNING event_id`,
		[
			event.eventId,
			event.eventType,
			event.transferId,
			JSON.stringify(event.payload),
		],
	);
	return result.rowCount === 1;
}
