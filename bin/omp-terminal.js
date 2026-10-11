#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch(error => {
	console.error(`omp-terminal: ${error?.message ?? error}`);
	process.exit(1);
});
