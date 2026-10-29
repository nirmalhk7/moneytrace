export function StatusPill({ status }: { status: string }) {
	const normalized = status.toLowerCase().replaceAll("_", " ");
	const tone =
		status === "settled" || status === "completed" || status === "paid"
			? "green"
			: status === "returned" ||
					status === "failed" ||
					status === "partially_failed"
				? "red"
				: status === "draft"
					? "gray"
					: "blue";
	return <span className={`status-pill ${tone}`}>{normalized}</span>;
}
