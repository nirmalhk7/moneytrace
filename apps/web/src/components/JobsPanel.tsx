import type { Job } from "../types";
import { dateLabel } from "../lib/date";
import { formatUsd } from "../lib/money";
import { StatusPill } from "./StatusPill";

export function JobsPanel({
	jobs,
	busy,
	onApprove,
}: {
	jobs: Job[];
	busy: boolean;
	onApprove: (jobId: string) => void;
}) {
	return (
		<article className="panel jobs-panel">
			<div className="panel-heading">
				<div>
					<div className="section-kicker">RECENT WORK</div>
					<h2>Jobs &amp; approvals</h2>
					<p>Approve only after the scope and split are correct.</p>
				</div>
				<a className="quiet-link" href="#jobs">
					View all <span>↗</span>
				</a>
			</div>
			{jobs.length ? (
				<div className="job-list">
					{jobs.slice(0, 5).map((job) => (
						<div className="job-row" key={job.id}>
							<div className="job-symbol">
								{job.title.trim().charAt(0).toUpperCase()}
							</div>
							<div className="job-info">
								<strong>{job.title}</strong>
								<span>
									{job.allocations
										.map((allocation) => allocation.contractorName)
										.join(", ")}
								</span>
							</div>
							<div className="job-amount">
								<strong>{formatUsd(job.gross)}</strong>
								<small>{dateLabel(job.createdAt)}</small>
							</div>
							<div className="job-action">
								{job.status === "draft" ? (
									<button
										type="button"
										className="button small primary"
										disabled={busy}
										onClick={() => onApprove(job.id)}
									>
										Approve
									</button>
								) : (
									<StatusPill status={job.status} />
								)}
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="empty-state">
					<span>▤</span>
					<strong>No jobs recorded yet</strong>
					<p>Create a job to start the approval and payout trail.</p>
				</div>
			)}
			<div className="jobs-footer">
				<span>
					<i /> {jobs.length} recent {jobs.length === 1 ? "job" : "jobs"}
				</span>
				<span>Fees stay separate from contractor payables</span>
			</div>
		</article>
	);
}
