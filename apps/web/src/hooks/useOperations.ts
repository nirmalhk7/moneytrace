import type { Contractor, JobDraft, Overview } from "../types";
import { request } from "../lib/api";

interface OperationsOptions {
	refresh: () => Promise<void>;
	setLoadError: (message: string) => void;
	setNotice: (message: string) => void;
	setBusy: (busy: boolean) => void;
	overview: Overview | null;
	selected: string[];
	setSelected: (ids: string[]) => void;
	replayOutcome: "settled" | "returned";
	mappingDrafts: Record<string, string>;
}

export function useOperations({
	refresh,
	setLoadError,
	setNotice,
	setBusy,
	overview,
	selected,
	setSelected,
	replayOutcome,
	mappingDrafts,
}: OperationsOptions) {
	async function act(
		action: () => Promise<void>,
		success?: string,
	): Promise<void> {
		setBusy(true);
		setNotice("");
		setLoadError("");
		try {
			await action();
			if (success) setNotice(success);
			await refresh();
		} catch (error) {
			setLoadError(
				error instanceof Error ? error.message : "The operation failed.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function approveJob(jobId: string): Promise<void> {
		await act(async () => {
			await request(`/api/jobs/${jobId}/approve`, { method: "POST" });
		}, "Job approved. Contractor obligations are now available for payout.");
	}

	async function createJob(draft: JobDraft): Promise<void> {
		await act(async () => {
			await request("/api/jobs", {
				method: "POST",
				body: JSON.stringify(draft),
			});
		}, "Draft job created. Review its split, then approve it to create payables.");
	}

	async function submitPayouts(): Promise<void> {
		await act(async () => {
			await request("/api/payout-batches", {
				method: "POST",
				body: JSON.stringify({
					obligationIds: selected,
					...(overview?.bankMode === "replay" ? { replayOutcome } : {}),
				}),
			});
			setSelected([]);
		}, "Payout batch submitted.");
	}

	async function retryPayout(obligationId: string): Promise<void> {
		await act(async () => {
			await request(`/api/obligations/${obligationId}/retry`, {
				method: "POST",
			});
		}, "New payout attempt submitted.");
	}

	async function recoverPayout(attemptId: string): Promise<void> {
		await act(async () => {
			const result = await request<{ status: string }>(
				`/api/payout-attempts/${attemptId}/recover`,
				{ method: "POST" },
			);
			setNotice(
				`Recovery check complete. Provider response: ${result.status}.`,
			);
		});
	}

	async function simulateLostResponse(obligationId: string): Promise<void> {
		await act(async () => {
			await request("/api/replay/lost-response", {
				method: "POST",
				body: JSON.stringify({ obligationId }),
			});
		}, "Provider response marked unknown. Recover the same payout attempt.");
	}

	async function simulateMissingLedger(obligationId: string): Promise<void> {
		await act(async () => {
			const result = await request<{ providerTransferId: string }>(
				"/api/replay/missing-ledger",
				{
					method: "POST",
					body: JSON.stringify({ obligationId }),
				},
			);
			setNotice(
				`Replay settlement ${result.providerTransferId} has no ledger posting. Import its provider report row to see the finding.`,
			);
		});
	}

	async function resolvePayout(
		attemptId: string,
		result: "settled" | "returned",
	): Promise<void> {
		await act(
			async () => {
				await request(`/api/payout-attempts/${attemptId}/resolve`, {
					method: "POST",
					body: JSON.stringify({ result }),
				});
			},
			result === "settled"
				? "Replay payout settled."
				: "Replay payout returned to the payable queue.",
		);
	}

	async function syncBatch(batchId: string): Promise<void> {
		await act(async () => {
			const result = await request<{
				settled: number;
				returned: number;
				pending: number;
			}>(`/api/payout-batches/${batchId}/sync`, { method: "POST" });
			setNotice(
				`Column sync: ${result.settled} settled, ${result.returned} returned, ${result.pending} still processing.`,
			);
		});
	}

	async function saveMapping(contractor: Contractor): Promise<void> {
		await act(async () => {
			await request(`/api/contractors/${contractor.id}`, {
				method: "PATCH",
				body: JSON.stringify({
					columnCounterpartyId: mappingDrafts[contractor.id] || null,
				}),
			});
		}, `Column mapping saved for ${contractor.name}.`);
	}

	return {
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
	};
}
