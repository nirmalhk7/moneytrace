import { spawnSync } from "node:child_process";

const created = spawnSync(
	"docker",
	[
		"compose",
		"exec",
		"-T",
		"postgres",
		"createdb",
		"-U",
		"money_trace",
		"money_trace_test",
	],
	{ encoding: "utf8" },
);

if (created.status !== 0 && !created.stderr.includes("already exists")) {
	process.stderr.write(created.stderr);
	process.exit(created.status ?? 1);
}

const reset = spawnSync(
	"docker",
	[
		"compose",
		"exec",
		"-T",
		"postgres",
		"psql",
		"-U",
		"money_trace",
		"-d",
		"money_trace_test",
		"-c",
		"DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
	],
	{ encoding: "utf8" },
);

if (reset.status !== 0) {
	process.stderr.write(reset.stderr);
	process.exit(reset.status ?? 1);
}
