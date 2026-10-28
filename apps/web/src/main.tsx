import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";

import "@radix-ui/themes/styles.css";
import "./styles.css";
import { formatUsd } from "./lib/money";
import { ActivityPanel } from "./components/ActivityPanel";
import { ActionNotices } from "./components/ActionNotices";
import { ContractorMappings } from "./components/ContractorMappings";
import { FailureLabPanel } from "./components/FailureLabPanel";
import { JobCreateForm } from "./components/JobCreateForm";
import { JobsPanel } from "./components/JobsPanel";
import { PayoutQueue } from "./components/PayoutQueue";
import { ReconciliationPanel } from "./components/ReconciliationPanel";
import { useOperations } from "./hooks/useOperations";
import { request } from "./lib/api";
import type { Overview } from "./types";

function App() {
	const [overview, setOverview] = useState<Overview | null>(null);
	const [loadError, setLoadError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const [replayOutcome, setReplayOutcome] = useState<"settled" | "returned">(
		"settled",
	);
	const [mappingDrafts, setMappingDrafts] = useState<Record<string, string>>(
		{},
	);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const data = await request<Overview>("/api/overview");
			setOverview(data);
			setLoadError("");
			setMappingDrafts((current) =>
				Object.fromEntries(
					data.contractors.map((contractor) => [
						contractor.id,
						current[contractor.id] ?? contractor.columnCounterpartyId ?? "",
					]),
				),
			);
		} catch (error) {
			setLoadError(
				error instanceof Error ? error.message : "Could not load operations.",
			);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = window.setInterval(() => void refresh(), 12_000);
		return () => window.clearInterval(timer);
	}, [refresh]);

	const {
		approveJob,
		createJob,
		submitPayouts,
		retryPayout,
		recoverPayout,
		simulateLostResponse,
		simulateMissingLedger,
		resolvePayout,
		syncBatch,
		saveMapping,
	} = useOperations({
		refresh,
		setLoadError,
		setNotice,
		setBusy,
		overview,
		selected,
		setSelected,
		replayOutcome,
		mappingDrafts,
	});

	if (!overview) {
		return (
			<div className="boot-screen">
				<div className="brand-lockup">
					<span className="brand-mark">M</span>
					<span>Money Trace</span>
				</div>
				<p>{loadError || "Connecting to the local ledger…"}</p>
				{loadError && (
					<button
						type="button"
						className="button primary"
						onClick={() => void refresh()}
					>
						Try again
					</button>
				)}
			</div>
		);
	}

	return (
		<div className="app-frame">
			<aside className="sidebar">
				<a className="brand-lockup" href="#top" aria-label="Money Trace home">
					<span className="brand-mark">M</span>
					<span>moneytrace</span>
				</a>
				<div className="workspace-chip">
					<span className="workspace-dot" /> LOCAL WORKSPACE
				</div>
				<nav aria-label="Main navigation">
					<a className="nav-link active" href="#top">
						<span className="nav-icon">◫</span>Overview
					</a>
					<a className="nav-link" href="#jobs">
						<span className="nav-icon">▤</span>Jobs & approvals
					</a>
					<a className="nav-link" href="#payouts">
						<span className="nav-icon">⇧</span>Payout queue
					</a>
					<a className="nav-link" href="#activity">
						<span className="nav-icon">◷</span>Activity
					</a>
					<a className="nav-link" href="#reconciliation">
						<span className="nav-icon">⌕</span>Reconciliation
					</a>
					<a className="nav-link" href="#failure-lab">
						<span className="nav-icon">⟳</span>Failure Lab
					</a>
					<a className="nav-link" href="#contractors">
						<span className="nav-icon">♙</span>Contractors
					</a>
				</nav>
				<div className="sidebar-bottom">
					<div className="ledger-card">
						<span className="ledger-icon">✓</span>
						<div>
							<strong>Ledger is balanced</strong>
							<small>Every journal entry reconciles</small>
						</div>
					</div>
					<div className="operator">
						<span className="avatar">NO</span>
						<span>
							<strong>Local operator</strong>
							<small>Owner access</small>
						</span>
						<span className="operator-menu">···</span>
					</div>
				</div>
			</aside>

			<main className="main-content" id="top">
				<header className="topbar">
					<div className="breadcrumbs">
						<span>Operations</span>
						<span className="crumb-slash">/</span>
						<strong>Overview</strong>
					</div>
					<div className="topbar-actions">
						<div className={`mode-indicator ${overview.bankMode}`}>
							<span />
							{overview.bankMode === "replay"
								? "Replay mode"
								: "Column sandbox"}
						</div>
						<button
							className="icon-button"
							type="button"
							aria-label="Refresh data"
							onClick={() => void refresh()}
						>
							⟳
						</button>
						<span className="top-avatar">N</span>
					</div>
				</header>

				<div className="page-content">
					<div className="page-heading">
						<div>
							<div className="eyebrow">
								<span className="eyebrow-line" />{" "}
								{new Intl.DateTimeFormat("en-US", {
									weekday: "long",
									month: "long",
									day: "numeric",
									year: "numeric",
								})
									.format(new Date())
									.toUpperCase()}
							</div>
							<h1>
								Good morning, Nirmal <span className="wave">✳</span>
							</h1>
							<p>Here’s where your contractor payouts stand today.</p>
						</div>
						<button
							type="button"
							className="button primary new-job-button"
							onClick={() => document.getElementById("job-title")?.focus()}
						>
							<span>＋</span> Create a job
						</button>
					</div>

					<ActionNotices
						error={loadError}
						notice={notice}
						onDismissError={() => setLoadError("")}
						onDismissNotice={() => setNotice("")}
					/>

					<section className="summary-grid" aria-label="Account balances">
						<article className="summary-card primary-summary">
							<div className="summary-top">
								<span>Available cash</span>
								<span className="summary-icon cash-icon">⌁</span>
							</div>
							<output>{formatUsd(overview.balances.availableCash)}</output>
							<div className="summary-foot">
								<span className="positive-dot" /> Cash held in your payout
								account
							</div>
						</article>
						<article className="summary-card">
							<div className="summary-top">
								<span>Ready to allocate</span>
								<span className="summary-icon allocate-icon">↗</span>
							</div>
							<output>{formatUsd(overview.balances.unallocatedFunds)}</output>
							<div className="summary-foot">
								Customer funds not yet assigned
							</div>
						</article>
						<article className="summary-card">
							<div className="summary-top">
								<span>Contractor payables</span>
								<span className="summary-icon payable-icon">⌗</span>
							</div>
							<output>
								{formatUsd(overview.balances.outstandingPayables)}
							</output>
							<div className="summary-foot">Approved work awaiting payment</div>
						</article>
						<article className="summary-card">
							<div className="summary-top">
								<span>In transit</span>
								<span className="summary-icon transit-icon">⇢</span>
							</div>
							<output>{formatUsd(overview.balances.moneyInTransit)}</output>
							<div className="summary-foot">Submitted to the payment rail</div>
						</article>
					</section>

					<section className="work-grid" id="jobs">
						<JobCreateForm
							contractors={overview.contractors}
							busy={busy}
							onCreate={createJob}
						/>
						<JobsPanel
							jobs={overview.jobs}
							busy={busy}
							onApprove={(jobId) => void approveJob(jobId)}
						/>
					</section>

					<PayoutQueue
						bankMode={overview.bankMode}
						obligations={overview.obligations}
						selected={selected}
						busy={busy}
						replayOutcome={replayOutcome}
						onSelectionChange={setSelected}
						onReplayOutcomeChange={setReplayOutcome}
						onSubmit={() => void submitPayouts()}
						onRetry={(obligationId) => void retryPayout(obligationId)}
						onRecover={(attemptId) => void recoverPayout(attemptId)}
						onSimulateLoss={(obligationId) =>
							void simulateLostResponse(obligationId)
						}
						onSimulateMissingLedger={(obligationId) =>
							void simulateMissingLedger(obligationId)
						}
						onResolve={(attemptId, result) =>
							void resolvePayout(attemptId, result)
						}
					/>

					<section className="lower-grid">
						<ActivityPanel
							batches={overview.batches}
							bankMode={overview.bankMode}
							busy={busy}
							onSync={(batchId) => void syncBatch(batchId)}
						/>
						<ContractorMappings
							bankMode={overview.bankMode}
							contractors={overview.contractors}
							drafts={mappingDrafts}
							busy={busy}
							onDraftChange={(contractorId, value) =>
								setMappingDrafts((current) => ({
									...current,
									[contractorId]: value,
								}))
							}
							onSave={(contractor) => void saveMapping(contractor)}
						/>
					</section>

					<FailureLabPanel enabled={overview.bankMode === "replay"} />
					<ReconciliationPanel />

					<footer className="page-footer">
						<span>
							<span className="footer-dot" /> Ledger healthy{" "}
							<span className="footer-divider">·</span> Last synced just now
						</span>
						<span>
							USD · Local operator <span className="footer-divider">·</span>{" "}
							<a href="#top">Documentation</a>
						</span>
					</footer>
				</div>
			</main>
		</div>
	);
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing app root.");

createRoot(root).render(
	<Theme accentColor="blue" grayColor="slate" radius="small" scaling="100%">
		<App />
	</Theme>,
);
