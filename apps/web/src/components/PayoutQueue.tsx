import type { Obligation, Overview } from "../types";
import { dateLabel } from "../lib/date";
import { formatUsd } from "../lib/money";
import { StatusPill } from "./StatusPill";

interface PayoutQueueProps {
	bankMode: Overview["bankMode"];
	obligations: Obligation[];
	selected: string[];
	busy: boolean;
	replayOutcome: "settled" | "returned";
	onSelectionChange: (ids: string[]) => void;
	onReplayOutcomeChange: (result: "settled" | "returned") => void;
	onSubmit: () => void;
	onRetry: (obligationId: string) => void;
	onRecover: (attemptId: string) => void;
	onSimulateLoss: (obligationId: string) => void;
	onSimulateMissingLedger: (obligationId: string) => void;
	onResolve: (attemptId: string, result: "settled" | "returned") => void;
}

export function PayoutQueue({
	bankMode,
	obligations,
	selected,
	busy,
	replayOutcome,
	onSelectionChange,
	onReplayOutcomeChange,
	onSubmit,
	onRetry,
	onRecover,
	onSimulateLoss,
	onSimulateMissingLedger,
	onResolve,
}: PayoutQueueProps) {
	const due = obligations.filter((item) => item.status === "due");
	const selectedAmount = due
		.filter((item) => selected.includes(item.id))
		.reduce((sum, item) => sum + BigInt(item.amount), 0n);
	const allDueSelected =
		due.length > 0 && due.every((item) => selected.includes(item.id));

	function toggleObligation(obligation: Obligation, checked: boolean): void {
		onSelectionChange(
			checked
				? [...selected, obligation.id]
				: selected.filter((id) => id !== obligation.id),
		);
	}

	return (
		<section className="panel payouts-panel" id="payouts">
			<div className="panel-heading payout-heading">
				<div>
					<div className="section-kicker">PAYMENT OPERATIONS</div>
					<h2>Contractor payout queue</h2>
					<p>
						Choose due obligations to send. Returned payments require a
						deliberate retry.
					</p>
				</div>
				<div className="queue-controls">
					{bankMode === "replay" && (
						<label className="scenario-select">
							<span>Replay outcome</span>
							<select
								value={replayOutcome}
								onChange={(event) =>
									onReplayOutcomeChange(
										event.target.value as "settled" | "returned",
									)
								}
							>
								<option value="settled">Settle normally</option>
								<option value="returned">Return this payout</option>
							</select>
						</label>
					)}
					<button
						type="button"
						className="button primary"
						onClick={onSubmit}
						disabled={busy || selected.length === 0}
					>
						<span>⇧</span> Submit{" "}
						{selected.length
							? `${selected.length} payout${selected.length === 1 ? "" : "s"}`
							: "payouts"}
						<b>{selected.length > 0 && formatUsd(selectedAmount)}</b>
					</button>
				</div>
			</div>
			<div className="table-wrap">
				<table>
					<thead>
						<tr>
							<th className="check-cell">
								<input
									type="checkbox"
									aria-label="Select due payouts"
									checked={allDueSelected}
									onChange={(event) =>
										onSelectionChange(
											event.target.checked ? due.map((item) => item.id) : [],
										)
									}
								/>
							</th>
							<th>CONTRACTOR</th>
							<th>JOB</th>
							<th>AMOUNT</th>
							<th>STATUS</th>
							<th>UPDATED</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{obligations.map((obligation) => (
							<ObligationRow
								key={obligation.id}
								obligation={obligation}
								selected={selected.includes(obligation.id)}
								busy={busy}
								bankMode={bankMode}
								onToggle={(checked) => toggleObligation(obligation, checked)}
								onRetry={() => onRetry(obligation.id)}
								onRecover={onRecover}
								onSimulateLoss={() => onSimulateLoss(obligation.id)}
								onSimulateMissingLedger={() =>
									onSimulateMissingLedger(obligation.id)
								}
								onResolve={onResolve}
							/>
						))}
						{obligations.length === 0 && (
							<tr>
								<td className="table-empty" colSpan={7}>
									<span>✓</span> All approved contractor obligations are paid.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			<div className="table-footer">
				<span>
					Showing {obligations.length} open obligation
					{obligations.length === 1 ? "" : "s"}
				</span>
				<span>
					<span className="secure-mark">⌑</span> Each submission is protected by
					an idempotency key
				</span>
			</div>
		</section>
	);
}

function ObligationRow({
	obligation,
	selected,
	busy,
	bankMode,
	onToggle,
	onRetry,
	onRecover,
	onSimulateLoss,
	onSimulateMissingLedger,
	onResolve,
}: {
	obligation: Obligation;
	selected: boolean;
	busy: boolean;
	bankMode: Overview["bankMode"];
	onToggle: (checked: boolean) => void;
	onRetry: () => void;
	onRecover: (attemptId: string) => void;
	onSimulateLoss: () => void;
	onSimulateMissingLedger: () => void;
	onResolve: (attemptId: string, result: "settled" | "returned") => void;
}) {
	const attemptId = obligation.latestAttemptId;
	return (
		<tr>
			<td className="check-cell">
				{obligation.status === "due" ? (
					<input
						type="checkbox"
						aria-label={`Select ${obligation.contractorName} payout`}
						checked={selected}
						onChange={(event) => onToggle(event.target.checked)}
					/>
				) : (
					<span className="row-lock">·</span>
				)}
			</td>
			<td>
				<div className="contractor-cell">
					<span className="contractor-avatar">
						{initials(obligation.contractorName)}
					</span>
					<strong>{obligation.contractorName}</strong>
				</div>
			</td>
			<td>
				<span className="table-main">{obligation.jobTitle}</span>
				<span className="table-sub">Job #{obligation.jobId.slice(0, 8)}</span>
			</td>
			<td>
				<strong className="amount-cell">{formatUsd(obligation.amount)}</strong>
			</td>
			<td>
				<StatusPill
					status={obligation.latestAttemptStatus ?? obligation.status}
				/>
				{obligation.latestError && (
					<span className="error-caption">{obligation.latestError}</span>
				)}
			</td>
			<td className="date-cell">{dateLabel(obligation.createdAt)}</td>
			<td className="row-action">
				{obligation.status === "in_progress" &&
				obligation.latestAttemptStatus === "unknown" ? (
					<button
						type="button"
						className="button small outline"
						disabled={busy}
						onClick={() => attemptId && onRecover(attemptId)}
					>
						Recover same attempt
					</button>
				) : bankMode === "replay" && obligation.status === "due" ? (
					<div className="inline-actions replay-actions">
						<button
							type="button"
							className="link-button"
							disabled={busy}
							onClick={onSimulateLoss}
						>
							Lost response
						</button>
						<button
							type="button"
							className="link-button danger-link"
							disabled={busy}
							onClick={onSimulateMissingLedger}
						>
							Missing ledger
						</button>
					</div>
				) : obligation.status === "due" &&
					obligation.latestAttemptStatus === "returned" ? (
					<button
						type="button"
						className="button small outline"
						disabled={busy}
						onClick={onRetry}
					>
						Retry payout
					</button>
				) : obligation.status === "in_progress" &&
					bankMode === "replay" &&
					attemptId ? (
					<div className="inline-actions">
						<button
							type="button"
							className="link-button"
							disabled={busy}
							onClick={() => onResolve(attemptId, "settled")}
						>
							Settle
						</button>
						<button
							type="button"
							className="link-button danger-link"
							disabled={busy}
							onClick={() => onResolve(attemptId, "returned")}
						>
							Return
						</button>
					</div>
				) : null}
			</td>
		</tr>
	);
}

function initials(name: string): string {
	return name
		.split(" ")
		.map((word) => word[0])
		.join("")
		.slice(0, 2);
}
