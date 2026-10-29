import type { Contractor, Overview } from "../types";

export function ContractorMappings({
	bankMode,
	contractors,
	drafts,
	busy,
	onDraftChange,
	onSave,
}: {
	bankMode: Overview["bankMode"];
	contractors: Contractor[];
	drafts: Record<string, string>;
	busy: boolean;
	onDraftChange: (contractorId: string, value: string) => void;
	onSave: (contractor: Contractor) => void;
}) {
	return (
		<article className="panel contractors-panel" id="contractors">
			<div className="panel-heading">
				<div>
					<div className="section-kicker">SANDBOX SETUP</div>
					<h2>Contractor connections</h2>
					<p>Map each contractor to their Column counterparty.</p>
				</div>
				<span className="provider-mark">C</span>
			</div>
			{bankMode === "column" && (
				<div className="sandbox-note">
					<span>i</span>
					<span>
						Column sandbox mode is active. ACH payouts will be submitted from
						the configured bank account.
					</span>
				</div>
			)}
			<div className="mapping-list">
				{contractors.map((contractor) => (
					<ContractorMappingRow
						key={contractor.id}
						contractor={contractor}
						draft={drafts[contractor.id] ?? ""}
						busy={busy}
						onDraftChange={(value) => onDraftChange(contractor.id, value)}
						onSave={() => onSave(contractor)}
					/>
				))}
			</div>
			<div className="mapping-foot">
				<span className="lock-icon">⌑</span> Counterparty IDs stay in your local
				database.
			</div>
		</article>
	);
}

function ContractorMappingRow({
	contractor,
	draft,
	busy,
	onDraftChange,
	onSave,
}: {
	contractor: Contractor;
	draft: string;
	busy: boolean;
	onDraftChange: (value: string) => void;
	onSave: () => void;
}) {
	const initials = contractor.name
		.split(" ")
		.map((word) => word[0])
		.join("")
		.slice(0, 2);
	return (
		<div className="mapping-row">
			<span className="mapping-avatar">{initials}</span>
			<div className="mapping-name">
				<strong>{contractor.name}</strong>
				<span>{draft ? "Connected to Column" : "No counterparty linked"}</span>
			</div>
			<input
				aria-label={`${contractor.name} Column counterparty ID`}
				className="mapping-input"
				placeholder="cpty_…"
				value={draft}
				onChange={(event) => onDraftChange(event.target.value)}
			/>
			<button
				type="button"
				className="button small outline"
				disabled={busy || draft === (contractor.columnCounterpartyId ?? "")}
				onClick={onSave}
			>
				Save
			</button>
		</div>
	);
}
