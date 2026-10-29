import type { PayoutBatch } from "../types";
import { dateLabel } from "../lib/date";
import { formatUsd } from "../lib/money";
import { StatusPill } from "./StatusPill";

export function ActivityPanel({
	batches,
	bankMode,
	busy,
	onSync,
}: {
	batches: PayoutBatch[];
	bankMode: "replay" | "column";
	busy: boolean;
	onSync: (batchId: string) => void;
}) {
	return (
		<article className="panel activity-panel" id="activity">
			<div className="panel-heading">
				<div>
					<div className="section-kicker">AUDIT TRAIL</div>
					<h2>Recent payout activity</h2>
					<p>Every attempt keeps its own status and provider reference.</p>
				</div>
				<span className="activity-count">{batches.length}</span>
			</div>
			{batches.length ? (
				<div className="activity-list">
					{batches.slice(0, 5).map((batch) => (
						<div className="activity-item" key={batch.id}>
							<span className={`activity-icon ${activityTone(batch.status)}`}>
								{activityGlyph(batch.status)}
							</span>
							<div className="activity-info">
								<strong>
									{batch.attempts.length === 1
										? batch.attempts[0]?.contractorName
										: `${batch.attempts.length} contractor payouts`}
								</strong>
								<span>
									{batch.attempts
										.map((attempt) => attempt.jobTitle)
										.join(" · ")}
								</span>
								<small>
									{dateLabel(batch.createdAt)}
									{batch.attempts[0]?.providerTransferId
										? ` · ${batch.attempts[0].providerTransferId}`
										: ""}
								</small>
							</div>
							<div className="activity-side">
								<strong>{batchAmount(batch)}</strong>
								<StatusPill status={batch.status} />
								{bankMode === "column" && batch.status === "processing" && (
									<button
										type="button"
										className="link-button"
										disabled={busy}
										onClick={() => onSync(batch.id)}
									>
										Sync Column
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="empty-state compact-empty">
					<span>◷</span>
					<strong>No payout activity yet</strong>
					<p>Submitted payments will appear here.</p>
				</div>
			)}
		</article>
	);
}

function batchAmount(batch: PayoutBatch): string {
	return formatUsd(
		batch.attempts.reduce((sum, attempt) => sum + BigInt(attempt.amount), 0n),
	);
}

function activityTone(status: string): string {
	if (status === "completed") return "complete";
	if (status === "partially_failed") return "returned";
	return "pending";
}

function activityGlyph(status: string): string {
	if (status === "completed") return "✓";
	if (status === "partially_failed") return "!";
	return "↗";
}
