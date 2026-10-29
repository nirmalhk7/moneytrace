import { readFile } from "node:fs/promises";

import {
	verifyIncidentEvidence,
	type IncidentEvidence,
} from "@money-trace/domain";

const file = process.argv[2];
if (!file) {
	process.stderr.write("Usage: pnpm evidence:verify <evidence.json>\n");
	process.exitCode = 2;
} else {
	try {
		const evidence = JSON.parse(
			await readFile(file, "utf8"),
		) as IncidentEvidence;
		const result = verifyIncidentEvidence(evidence);
		if (result.valid) {
			process.stdout.write("Evidence verified.\n");
		} else {
			process.stderr.write(
				`${result.findings.map((finding) => `- ${finding}`).join("\n")}\n`,
			);
			process.exitCode = 1;
		}
	} catch (error) {
		process.stderr.write(
			`Could not verify evidence: ${error instanceof Error ? error.message : "Invalid input."}\n`,
		);
		process.exitCode = 1;
	}
}
