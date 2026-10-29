import { useState } from "react";
import {
	verifyIncidentEvidence,
	type IncidentEvidence,
	type IncidentScenario,
} from "@money-trace/domain";

import { request } from "../lib/api";

interface IncidentRun {
	evidence: IncidentEvidence;
	verification: { valid: boolean; findings: string[] };
}

const scenarios: Array<{
	id: IncidentScenario;
	title: string;
	detail: string;
}> = [
	{
		id: "lost_response",
		title: "Lose a payout response",
		detail: "Recover the accepted transfer with its original key.",
	},
	{
		id: "missing_ledger",
		title: "Drop a settlement posting",
		detail: "Repair once from the matching settlement report row.",
	},
	{
		id: "late_return",
		title: "Return after settlement",
		detail: "Restore bank cash and reopen only the contractor payable.",
	},
];

export function FailureLabPanel({ enabled }: { enabled: boolean }) {
	const [busy, setBusy] = useState(false);
	const [run, setRun] = useState<IncidentRun | null>(null);
	const [error, setError] = useState("");

	async function runScenario(scenario: IncidentScenario): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const result = await request<IncidentRun>("/api/incidents/runs", {
				method: "POST",
				body: JSON.stringify({ scenario }),
			});
			setRun(result);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Incident replay failed.",
			);
		} finally {
			setBusy(false);
		}
	}

	function downloadEvidence(): void {
		if (!run) return;
		const file = new Blob([`${JSON.stringify(run.evidence, null, 2)}\n`], {
			type: "application/json",
		});
		const url = URL.createObjectURL(file);
		const link = document.createElement("a");
		link.href = url;
		link.download = `money-trace-${run.evidence.scenario}-${run.evidence.runId}.json`;
		link.click();
		URL.revokeObjectURL(url);
	}

	const localVerification = run
		? verifyIncidentEvidence(run.evidence)
		: undefined;

	return (
		<section className="panel failure-lab-panel" id="failure-lab">
			<div className="failure-lab-copy">
				<div className="section-kicker">
					ISOLATED REPLAY · NO COLUMN REQUESTS
				</div>
				<h2>Can you break this payout?</h2>
				<p>
					Trigger a payment failure, inspect the ledger result, then verify the
					evidence outside this screen.
				</p>
				<div className="failure-lab-scenarios">
					{scenarios.map((scenario) => (
						<button
							key={scenario.id}
							type="button"
							className="button outline"
							disabled={!enabled || busy}
							onClick={() => void runScenario(scenario.id)}
						>
							<strong>{scenario.title}</strong>
							<span>{scenario.detail}</span>
						</button>
					))}
				</div>
				{busy && <output>Running isolated payout scenario…</output>}
				{error && (
					<p className="report-message error-message" role="alert">
						{error}
					</p>
				)}
				{run && (
					<div className="failure-lab-result">
						<output>
							{localVerification?.valid
								? "Evidence verified"
								: "Evidence needs review"}
						</output>
						<span>
							Run {run.evidence.runId} · {run.evidence.source} · payout $90.00
						</span>
						<ol>
							{run.evidence.observations.map((observation) => (
								<li key={`${observation.sequence}-${observation.kind}`}>
									{observation.kind.replaceAll("_", " ")}: {observation.value}
								</li>
							))}
						</ol>
						{localVerification?.findings.map((finding) => (
							<p className="report-message error-message" key={finding}>
								{finding}
							</p>
						))}
						<button
							type="button"
							className="button outline"
							onClick={downloadEvidence}
						>
							Download evidence JSON
						</button>
						<code>pnpm evidence:verify &lt;evidence.json&gt;</code>
					</div>
				)}
			</div>
		</section>
	);
}
