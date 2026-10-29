export interface Contractor {
	id: string;
	name: string;
	active: boolean;
	columnCounterpartyId: string | null;
}

export interface Allocation {
	contractorId: string;
	contractorName: string;
	amount: string;
}

export interface Job {
	id: string;
	title: string;
	gross: string;
	platformFee: string;
	status: "draft" | "approved";
	createdAt: string;
	allocations: Allocation[];
}

export interface Obligation {
	id: string;
	jobId: string;
	jobTitle: string;
	contractorId: string;
	contractorName: string;
	amount: string;
	status: "due" | "in_progress";
	createdAt: string;
	latestAttemptId: string | null;
	latestAttemptStatus: string | null;
	latestError: string | null;
}

export interface PayoutAttempt {
	id: string;
	amount: string;
	status: string;
	providerTransferId: string | null;
	errorMessage: string | null;
	returnCode: string | null;
	obligationId: string;
	contractorName: string;
	jobTitle: string;
}

export interface PayoutBatch {
	id: string;
	status: string;
	createdAt: string;
	attempts: PayoutAttempt[];
}

export interface Overview {
	balances: {
		bankCash: string;
		availableCash: string;
		unallocatedFunds: string;
		outstandingPayables: string;
		moneyInTransit: string;
	};
	bankMode: "replay" | "column";
	contractors: Contractor[];
	jobs: Job[];
	obligations: Obligation[];
	batches: PayoutBatch[];
}

export interface JobDraft {
	title: string;
	gross: string;
	platformFee: string;
	allocations: { contractorId: string; amount: string }[];
}
