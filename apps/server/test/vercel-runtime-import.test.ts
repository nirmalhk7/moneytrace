import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

const routeDirectory = fileURLToPath(new URL("../../../api/", import.meta.url));
const sourcePath = join(routeDirectory, "index.ts");
const emittedPath = join(routeDirectory, ".vercel-runtime-test.js");
const probePath = join(routeDirectory, ".vercel-runtime-probe.mjs");

afterEach(() => {
	for (const path of [emittedPath, probePath]) {
		if (existsSync(path)) unlinkSync(path);
	}
});

describe("Vercel ESM runtime bootstrap", () => {
	it("loads the TypeScript application from the emitted Node handler", () => {
		const source = ts.sys.readFile(sourcePath);
		if (!source) throw new Error("Vercel route source was not found.");
		const emitted = ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
			},
		}).outputText;
		writeFileSync(emittedPath, emitted);
		writeFileSync(
			probePath,
			'const handler = await import("./.vercel-runtime-test.js"); console.log(typeof handler.default);',
		);

		const result = spawnSync(process.execPath, [probePath], {
			cwd: process.cwd(),
			env: {
				...process.env,
				DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
				DATABASE_URL_UNPOOLED: "postgresql://test:test@127.0.0.1:5432/test",
			},
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("function");
	});
});
