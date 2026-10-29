import { useEffect, useMemo, useState, type FormEvent } from "react";

import type { Contractor, JobDraft } from "../types";
import { formatUsd } from "../lib/money";

interface AllocationDraft {
	id: string;
	contractorId: string;
	amount: string;
}

interface JobCreateFormProps {
	contractors: Contractor[];
	busy: boolean;
	onCreate: (draft: JobDraft) => Promise<void>;
}

function moneyToMinor(value: string): bigint | null {
	if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
	const [whole = "0", fraction = ""] = value.split(".");
	return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function newAllocation(contractorId = ""): AllocationDraft {
	return { id: crypto.randomUUID(), contractorId, amount: "" };
}

export function JobCreateForm({
	contractors,
	busy,
	onCreate,
}: JobCreateFormProps) {
	const [title, setTitle] = useState("");
	const [gross, setGross] = useState("");
	const [platformFee, setPlatformFee] = useState("");
	const [allocations, setAllocations] = useState<AllocationDraft[]>([
		newAllocation(),
	]);

	useEffect(() => {
		setAllocations((current) =>
			current.map((item) => ({
				...item,
				contractorId: item.contractorId || contractors[0]?.id || "",
			})),
		);
	}, [contractors]);

	const allocationTotal = useMemo(
		() =>
			allocations.reduce(
				(sum, item) => sum + (moneyToMinor(item.amount) ?? 0n),
				0n,
			),
		[allocations],
	);
	const fee = moneyToMinor(platformFee);
	const grossAmount = moneyToMinor(gross);
	const splitIsValid =
		grossAmount !== null &&
		fee !== null &&
		allocations.every((item) => moneyToMinor(item.amount) !== null) &&
		allocationTotal === grossAmount - fee;

	async function createJob(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		await onCreate({
			title,
			gross,
			platformFee,
			allocations: allocations.map(({ contractorId, amount }) => ({
				contractorId,
				amount,
			})),
		});
		setTitle("");
		setGross("");
		setPlatformFee("");
		setAllocations([newAllocation(contractors[0]?.id ?? "")]);
	}

	function updateAllocation(
		id: string,
		updates: Partial<AllocationDraft>,
	): void {
		setAllocations((current) =>
			current.map((item) => (item.id === id ? { ...item, ...updates } : item)),
		);
	}

	return (
		<article className="panel job-panel">
			<div className="panel-heading">
				<div>
					<div className="section-kicker">NEW WORK</div>
					<h2>Create a payout job</h2>
					<p>Record completed work and split its funding.</p>
				</div>
				<span className="step-badge">
					01 <span>/ 02</span>
				</span>
			</div>
			<form onSubmit={(event) => void createJob(event)}>
				<label className="field-label" htmlFor="job-title">
					Job description
				</label>
				<input
					id="job-title"
					className="text-input"
					placeholder="e.g. Replace rooftop condenser"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					required
					maxLength={160}
				/>
				<div className="field-row">
					<div>
						<label className="field-label" htmlFor="gross">
							Total job amount
						</label>
						<CurrencyInput id="gross" value={gross} onChange={setGross} />
					</div>
					<div>
						<label className="field-label" htmlFor="platform-fee">
							Platform fee
						</label>
						<CurrencyInput
							id="platform-fee"
							value={platformFee}
							onChange={setPlatformFee}
						/>
					</div>
				</div>
				<div className="split-heading">
					<span>Contractor split</span>
					<span>AMOUNT</span>
				</div>
				{allocations.map((allocation, index) => (
					<div className="allocation-row" key={allocation.id}>
						<select
							aria-label={`Contractor ${index + 1}`}
							value={allocation.contractorId}
							onChange={(event) =>
								updateAllocation(allocation.id, {
									contractorId: event.target.value,
								})
							}
							required
						>
							<option value="" disabled>
								Select contractor
							</option>
							{contractors
								.filter((contractor) => contractor.active)
								.map((contractor) => (
									<option key={contractor.id} value={contractor.id}>
										{contractor.name}
									</option>
								))}
						</select>
						<CurrencyInput
							id={`allocation-${index}`}
							label={`Contractor ${index + 1} amount`}
							compact
							value={allocation.amount}
							onChange={(amount) => updateAllocation(allocation.id, { amount })}
						/>
						{allocations.length > 1 && (
							<button
								type="button"
								className="remove-row"
								onClick={() =>
									setAllocations((items) =>
										items.filter((item) => item.id !== allocation.id),
									)
								}
								aria-label="Remove contractor"
							>
								×
							</button>
						)}
					</div>
				))}
				<button
					type="button"
					className="text-action"
					onClick={() =>
						setAllocations((items) => [
							...items,
							newAllocation(contractors[0]?.id ?? ""),
						])
					}
				>
					＋ Add contractor
				</button>
				<output
					className={`allocation-total ${splitIsValid ? "balanced" : ""}`}
				>
					<span>Contractors + platform fee</span>
					<strong>{formatUsd(allocationTotal + (fee ?? 0n))}</strong>
				</output>
				{gross && !splitIsValid && (
					<div className="validation-hint">
						Split must add up to the total job amount of{" "}
						{formatUsd(grossAmount ?? 0n)}.
					</div>
				)}
				<button
					type="submit"
					className="button primary form-submit"
					disabled={busy || !splitIsValid || !title.trim()}
				>
					<span>Save as draft</span>
					<span>→</span>
				</button>
				<div className="form-footnote">
					<span>⌑</span> Approval creates contractor payables and locks the job
					split.
				</div>
			</form>
		</article>
	);
}

function CurrencyInput({
	id,
	label,
	value,
	onChange,
	compact = false,
}: {
	id: string;
	label?: string;
	value: string;
	onChange: (value: string) => void;
	compact?: boolean;
}) {
	return (
		<div className={`currency-input ${compact ? "compact" : ""}`}>
			<span>$</span>
			<input
				id={id}
				aria-label={label}
				inputMode="decimal"
				placeholder="0.00"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				required
			/>
		</div>
	);
}
