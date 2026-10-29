import { useCallback, useEffect, useState } from "react";

import { request } from "../lib/api";
import { formatUsd } from "../lib/money";
import {
	isRepairableSettlementFinding,
	parseColumnReportJson,
} from "../lib/reconciliation";

type Finding = {
	transactionId: string;
	classification: string;
	expectedAmountMinor?: string;
	observedAmountMinor?: string;
	duplicateCount?: number;
};

type Reconciliation = {
	reports: { reportId: string; rowCount: number }[];
	rows: {
		reportId: string;
		rowNumber: number;
		transactionId: string | null;
		transactionType: string;
		amountMinor: string;
		bankAccountId: string;
		effectiveAt: string;
	}[];
	findings: Finding[];
};

export function ReconciliationPanel() {
	const [reportId, setReportId] = useState("demo-column-report");
	const [data, setData] = useState<Reconciliation | null>(null);
	const [file, setFile] = useState<File | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const refresh = useCallback(async (): Promise<void> => {
		setData(await loadReconciliation());
	}, []);
	const handleRefresh = useCallback(() => {
		void refresh().catch((cause: unknown) =>
			setError(errorMessage(cause, "Could not refresh.")),
		);
	}, [refresh]);

	useEffect(() => {
		void refresh().catch((cause: unknown) => {
			setError(errorMessage(cause, "Could not load reports."));
		});
	}, [refresh]);

	async function importReport(): Promise<void> {
		if (!file || !reportId.trim()) {
			setError("Choose a JSON report and enter a report ID.");
			return;
		}
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const result = await importColumnReport(file, reportId.trim());
			await refresh();
			setNotice(
				result.importedRows
					? `Imported ${result.importedRows} transaction rows.`
					: "This report was already imported; existing evidence is unchanged.",
			);
		} catch (cause) {
			setError(errorMessage(cause, "Could not import report."));
		} finally {
			setBusy(false);
		}
	}

	async function repairLedger(
		reportId: string,
		rowNumber: number,
	): Promise<void> {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await request("/api/reconciliation/repairs", {
				method: "POST",
				body: JSON.stringify({ reportId, rowNumber }),
			});
			await refresh();
			setNotice("Ledger repaired from report evidence. No payout was sent.");
		} catch (cause) {
			setError(errorMessage(cause, "Could not repair the ledger."));
		} finally {
			setBusy(false);
		}
	}

	return (
		<ReconciliationView
			reportId={reportId}
			data={data}
			file={file}
			busy={busy}
			error={error}
			notice={notice}
			onReportIdChange={setReportId}
			onFileChange={setFile}
			onImport={() => void importReport()}
			onRefresh={handleRefresh}
			onRepairLedger={(reportId, rowNumber) =>
				void repairLedger(reportId, rowNumber)
			}
		/>
	);
}

async function loadReconciliation(): Promise<Reconciliation> {
	return request<Reconciliation>("/api/reconciliation");
}

async function importColumnReport(
	file: File,
	reportId: string,
): Promise<{ importedRows: number }> {
	const parsed = parseColumnReportJson(await file.text());
	return request<{ importedRows: number }>("/api/reconciliation/reports", {
		method: "POST",
		body: JSON.stringify({ reportId, rows: parsed.rows }),
	});
}

function errorMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback;
}

function ReconciliationView({
	reportId,
	data,
	file,
	busy,
	error,
	notice,
	onReportIdChange,
	onFileChange,
	onImport,
	onRefresh,
	onRepairLedger,
}: {
	reportId: string;
	data: Reconciliation | null;
	file: File | null;
	busy: boolean;
	error: string;
	notice: string;
	onReportIdChange: (value: string) => void;
	onFileChange: (file: File | null) => void;
	onImport: () => void;
	onRefresh: () => void;
	onRepairLedger: (reportId: string, rowNumber: number) => void;
}) {
	return (
		<section className="panel reconciliation-panel" id="reconciliation">
			<div className="panel-heading">
				<div>
					<div className="section-kicker">MONEY TRACE</div>
					<h2>Settlement reconciliation</h2>
					<p>
						Compare payout attempts and ledger entries with Column report
						evidence.
					</p>
				</div>
				<button
					type="button"
					className="button outline small"
					disabled={busy}
					onClick={onRefresh}
				>
					Refresh
				</button>
			</div>
			<ReportImportForm
				reportId={reportId}
				file={file}
				busy={busy}
				onReportIdChange={onReportIdChange}
				onFileChange={onFileChange}
				onImport={onImport}
			/>
			<p className="report-hint">
				Accepts Column’s bank account transaction JSON export. Re-importing the
				same report ID and rows is safe.
			</p>
			{error && (
				<p className="report-message error-message" role="alert">
					{error}
				</p>
			)}
			{notice && (
				<output className="report-message success-message">{notice}</output>
			)}
			<FindingsTable data={data} busy={busy} onRepair={onRepairLedger} />
		</section>
	);
}

function ReportImportForm({
	reportId,
	file,
	busy,
	onReportIdChange,
	onFileChange,
	onImport,
}: {
	reportId: string;
	file: File | null;
	busy: boolean;
	onReportIdChange: (value: string) => void;
	onFileChange: (file: File | null) => void;
	onImport: () => void;
}) {
	return (
		<div className="report-import">
			<div>
				<label className="field-label" htmlFor="report-id">
					Report ID
				</label>
				<input
					className="text-input"
					id="report-id"
					value={reportId}
					onChange={(event) => onReportIdChange(event.currentTarget.value)}
					maxLength={128}
				/>
			</div>
			<div>
				<label className="field-label" htmlFor="column-report-file">
					Column JSON report
				</label>
				<input
					className="report-file-input"
					id="column-report-file"
					accept=".json,application/json"
					type="file"
					onChange={(event) =>
						onFileChange(event.currentTarget.files?.[0] ?? null)
					}
				/>
			</div>
			<button
				type="button"
				className="button primary"
				disabled={busy || !file}
				onClick={onImport}
			>
				{busy ? "Importing…" : "Import report"}
			</button>
		</div>
	);
}

function FindingsTable({
	data,
	busy,
	onRepair,
}: {
	data: Reconciliation | null;
	busy: boolean;
	onRepair: (reportId: string, rowNumber: number) => void;
}) {
	return (
		<>
			<div className="reconciliation-summary">
				<span>{data?.reports.length ?? 0} reports loaded</span>
				<span>{data?.rows.length ?? 0} transaction rows</span>
				<span>{data?.findings.length ?? 0} reconciliation findings</span>
			</div>
			<div className="table-wrap">
				<table>
					<thead>
						<tr>
							<th>FINDING</th>
							<th>PROVIDER TRANSACTION</th>
							<th>EXPECTED</th>
							<th>REPORTED</th>
							<th>REPORT EVIDENCE</th>
						</tr>
					</thead>
					<tbody>{renderFindingRows(data, busy, onRepair)}</tbody>
				</table>
			</div>
		</>
	);
}

function renderFindingRows(
	data: Reconciliation | null,
	busy: boolean,
	onRepair: (reportId: string, rowNumber: number) => void,
) {
	if (!data?.findings.length) {
		return (
			<tr>
				<td className="table-empty" colSpan={5}>
					{data
						? "No findings. Import a report to compare provider evidence."
						: "Loading reconciliation…"}
				</td>
			</tr>
		);
	}
	return data.findings.map((finding, index) => (
		<FindingRow
			key={`${finding.transactionId}-${finding.classification}-${index}`}
			finding={finding}
			rows={data.rows.filter(
				(row) => row.transactionId === finding.transactionId,
			)}
			busy={busy}
			onRepair={onRepair}
		/>
	));
}

function FindingRow({
	finding,
	rows,
	busy,
	onRepair,
}: {
	finding: Finding;
	rows: Reconciliation["rows"];
	busy: boolean;
	onRepair: (reportId: string, rowNumber: number) => void;
}) {
	const repairable = isRepairableSettlementFinding(finding, rows);
	const repairRow = repairable ? rows[0] : undefined;
	const rowDetails = rows
		.map((row) => `${formatUsd(row.amountMinor)} · ${row.bankAccountId}`)
		.join(" / ");
	const times = rows
		.map((row) => new Date(row.effectiveAt).toLocaleString())
		.join(" / ");
	return (
		<tr>
			<td>
				<span className={`finding-badge ${tone(finding.classification)}`}>
					{label(finding.classification)}
				</span>
			</td>
			<td>
				<span className="table-main">{finding.transactionId}</span>
				<span className="table-sub">
					{rows.length
						? rows.map((row) => row.transactionType).join(", ")
						: "No report row"}
				</span>
			</td>
			<td className="amount-cell">
				{finding.expectedAmountMinor
					? formatUsd(finding.expectedAmountMinor)
					: "—"}
			</td>
			<td className="amount-cell">
				{finding.observedAmountMinor
					? formatUsd(finding.observedAmountMinor)
					: finding.duplicateCount
						? `${finding.duplicateCount} rows`
						: "—"}
			</td>
			<td>
				<span className="table-main">
					{rows.length ? rowDetails : "Expected payout absent from report"}
				</span>
				<span className="table-sub">{times}</span>
				{repairRow && (
					<button
						type="button"
						className="button outline small"
						disabled={busy}
						onClick={() => onRepair(repairRow.reportId, repairRow.rowNumber)}
					>
						Repair ledger (no payout)
					</button>
				)}
			</td>
		</tr>
	);
}

function label(classification: string): string {
	return classification.replaceAll("_", " ");
}

function tone(classification: string): string {
	if (classification === "matched") return "good";
	if (classification === "pending") return "pending";
	return "issue";
}
