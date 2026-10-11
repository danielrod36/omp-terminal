#!/usr/bin/env node
/**
 * Parse every source and test file with the Node parser.
 *
 * The project has no dependencies and no build step, so a full parse is the
 * available static check: it catches typos, unbalanced braces, and invalid
 * syntax before any test runs.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const roots = ["src", "bin", "test"];
const files = [];
for (const root of roots) {
	for (const name of readdirSync(root)) {
		if (/\.(js|mjs)$/.test(name)) files.push(join(root, name));
	}
}
files.sort();

let failed = 0;
for (const file of files) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
	} catch (error) {
		failed++;
		console.error(`✗ ${file}`);
		console.error(String(error.stderr ?? error.message).trim());
	}
}
console.log(failed === 0 ? `✓ ${files.length} files parse` : `✗ ${failed} file(s) failed to parse`);
process.exit(failed === 0 ? 0 : 1);
