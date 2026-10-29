export function ActionNotices({
	error,
	notice,
	onDismissError,
	onDismissNotice,
}: {
	error: string;
	notice: string;
	onDismissError: () => void;
	onDismissNotice: () => void;
}) {
	return (
		<>
			{error && (
				<div className="notice error" role="alert">
					<strong>Action needs attention.</strong> {error}
					<button
						type="button"
						onClick={onDismissError}
						aria-label="Dismiss error"
					>
						×
					</button>
				</div>
			)}
			{notice && (
				<output className="notice success">
					<span>✓</span> {notice}
					<button
						type="button"
						onClick={onDismissNotice}
						aria-label="Dismiss notice"
					>
						×
					</button>
				</output>
			)}
		</>
	);
}
