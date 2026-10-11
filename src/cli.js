import { networkInterfaces } from "node:os";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConfig, DEFAULTS } from "./config.js";
import { configureLog, createLogger } from "./log.js";
import { createBridge } from "./server.js";
import { providerNames, startTunnel, stopTunnel } from "./expose.js";

const log = createLogger("cli");

const HELP = `omp-terminal — Even Realities G2 Terminal Mode bridge for oh-my-pi (omp)

USAGE
  omp-terminal [options]

OPTIONS
  -p, --port <n>              Server port (default ${DEFAULTS.port})
  -t, --token <str>           Stable pairing token (default: random per boot)
  -n, --name <str>            Device name shown in the app
  -d, --cwd <path>            Working directory for new sessions
      --omp <path>            omp executable (default: ${DEFAULTS.ompCommand})
      --approval-mode <mode>  always-ask | write | yolo (default: ${DEFAULTS.approvalMode})
      --sessions-root <path>  omp transcript root (default: ~/.omp/agent/sessions)
      --provider-label <name> Provider name sent to the app: claude | claude-sync | codex
                              (default: claude; the app's picker only knows these).
                              The real backend stays visible as extra.backend=omp.
      --no-attach             Do not list desk/tmux omp sessions
      --lan                   Advertise the LAN IPv4 address
      --tailscale             Advertise the Tailscale IPv4 address
  -i, --interface <name>      Advertise one interface's IPv4 address
      --expose <provider>     Quick public tunnel: cloudflare | pinggy | bore | ngrok
                              (prints a second pairing QR for the public URL)
      --allow-cors            Allow cross-origin browser requests
      --log-file <path>
      --log-level <debug|info>
  -h, --help
  -v, --version

The stock Even App (Terminal Mode) pairs by scanning the printed QR: it carries
  http://<host>:<port>?token=<token>&defaultProvider=<provider-label>
`;

function parseArgs(argv) {
	const flags = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const next = () => argv[++index];
		switch (arg) {
			case "-p":
			case "--port":
				flags.port = Number(next());
				break;
			case "-t":
			case "--token":
				flags.token = next();
				break;
			case "-n":
			case "--name":
				flags.name = next();
				break;
			case "-d":
			case "--cwd":
				flags.cwd = next();
				break;
			case "--omp":
				flags.omp = next();
				break;
			case "--approval-mode":
				flags.approvalMode = next();
				break;
			case "--sessions-root":
				flags.sessionsRoot = next();
				break;
			case "--provider-label":
				flags.providerLabel = next();
				break;
			case "--no-attach":
				flags.attach = false;
				break;
			case "--lan":
				flags.networkMode = "lan";
				break;
			case "--tailscale":
				flags.networkMode = "tailscale";
				break;
			case "-i":
			case "--interface":
			case "--if":
				flags.networkMode = "interface";
				flags.interface = next();
				break;
			case "--expose":
				flags.expose = next();
				break;
			case "--allow-cors":
				flags.allowCors = true;
				break;
			case "--log-file":
				flags.logFile = next();
				break;
			case "--log-level":
				flags.logLevel = next();
				break;
			case "-h":
			case "--help":
				flags.help = true;
				break;
			case "-v":
			case "--version":
				flags.version = true;
				break;
			default:
				throw new Error(`unknown flag '${arg}' (see --help)`);
		}
	}
	return flags;
}

/**
 * Pick the interface address the phone can actually reach.
 *
 * `networkInterfaces()` order is kernel order, not usefulness: a VPN tun
 * (singbox, wg, docker bridge) can come first and advertise an address the
 * phone cannot route to, so the QR points at a black hole. Prefer a physical
 * WiFi/Ethernet interface, and only fall back to whatever private address
 * exists.
 */
function getLanAddress() {
	const nets = networkInterfaces();
	const isPrivate = address => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
	// Interface names that are never the phone's route to this host.
	const virtual = /^(singbox|tun|tap|wg|docker|br-|veth|virbr|tailscale|zt|ppp)/i;
	const candidates = [];
	for (const [name, addresses] of Object.entries(nets)) {
		for (const address of addresses ?? []) {
			if (address.family !== "IPv4" || address.internal) continue;
			if (!isPrivate(address.address)) continue;
			candidates.push({ name, address: address.address, virtual: virtual.test(name) });
		}
	}
	const physical = candidates.find(candidate => !candidate.virtual);
	return (physical ?? candidates[0])?.address ?? null;
}

function getTailscaleAddress() {
	try {
		const out = execSync("tailscale ip -4", { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
			.toString()
			.trim();
		return out.split("\n")[0]?.trim() || null;
	} catch {
		return null;
	}
}

function getInterfaceAddress(name) {
	for (const address of networkInterfaces()[name] ?? []) {
		if (address.family === "IPv4") return address.address;
	}
	return null;
}

function resolveHost(flags) {
	const mode = flags.networkMode ?? process.env.EVEN_HOST_MODE ?? null;
	if (mode === "tailscale") {
		const address = getTailscaleAddress();
		if (!address) throw new Error("failed to get Tailscale IPv4 (is `tailscale` installed and running?)");
		return { label: "Tailscale", address };
	}
	if (mode === "interface") {
		const name = flags.interface ?? process.env.EVEN_HOST_INTERFACE ?? "";
		const address = name ? getInterfaceAddress(name) : null;
		if (!address) throw new Error(`failed to get IPv4 address for interface '${name || "(none)"}'`);
		return { label: name, address };
	}
	const address = getLanAddress();
	if (!address) log.warn("no private LAN IPv4 found; pairing QR will use localhost only");
	return { label: "LAN", address: address ?? "" };
}

function printBanner({ host, port, token, cwd, name, providerLabel, tokenSource }) {
	const logo = ["██  ████████", "████        ", "██  ████████", "████        ", "██  ████████"];
	const label = Math.max("Local".length, "Token".length, "Name".length, "CWD".length, host.label.length);
	const pad = text => text.padEnd(label);
	const info = [
		"omp-terminal v0.1.0 (oh-my-pi bridge)",
		name ? `${pad("Name")}:  ${name}` : "",
		`${pad("Local")}:  http://localhost:${port}`,
		host.address ? `${pad(host.label)}:  http://${host.address}:${port}` : "",
		`${pad("Token")}:  ${token.slice(0, 8)}...${token.slice(-4)}`,
		`${pad("CWD")}:  ${cwd}`,
		"",
		"",
	];
	console.log("");
	for (let index = 0; index < Math.max(logo.length, info.length); index++) {
		console.log(`  ${(logo[index] ?? "").padEnd(12)}     ${info[index] ?? ""}`);
	}
	console.log("");
	console.log("  Connect your Even App (Terminal Mode) to this terminal");
	console.log(`  ${"─".repeat(61)}`);
	console.log("");
	console.log(`  Full token: ${token}${tokenSource ? `  (${tokenSource})` : ""}`);
	if (tokenSource === "generated") {
		console.log("  Saved to ~/.omp-terminal/config.json — reused on the next start.");
	}
	console.log("");
	const url = `http://${host.address || "localhost"}:${port}?token=${encodeURIComponent(token)}&defaultProvider=${encodeURIComponent(providerLabel)}`;
	console.log(`  ${url}`);
	console.log("");
	try {
		execSync(`qrencode -t ANSIUTF8 ${JSON.stringify(url)}`, { stdio: "inherit" });
	} catch {
		console.log("  (install `qrencode` to print a scannable QR code)");
	}
	console.log("");
}

export async function main(argv) {
	const flags = parseArgs(argv);
	if (flags.help) {
		console.log(HELP);
		return;
	}
	if (flags.version) {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		console.log(`omp-terminal ${pkg.version}`);
		return;
	}

	const config = loadConfig({ flags });
	configureLog({ level: flags.logLevel ?? "info", file: config.logFile });

	if (config.expose && !providerNames().includes(config.expose)) {
		throw new Error(`unsupported expose provider '${config.expose}' (known: ${providerNames().join(", ")})`);
	}

	const host = resolveHost(flags);
	if (flags.networkMode === "lan") config.bindHost = config.bindHost || "0.0.0.0";

	const bridge = createBridge(config);
	await bridge.listen();
	printBanner({
		host,
		port: config.port,
		token: bridge.token,
		cwd: config.cwd,
		name: config.name,
		providerLabel: config.providerLabel,
		tokenSource: config.tokenSource,
	});

	// Start the requested public tunnel and print a second pairing QR for it.
	let tunnel = null;
	if (config.expose) {
		console.log(`  Starting public tunnel via ${config.expose}...`);
		try {
			tunnel = await startTunnel({
				providerName: config.expose,
				port: config.port,
				onLog: line => log.debug(line),
			});
			const url = `${tunnel.url}?token=${encodeURIComponent(bridge.token)}&defaultProvider=${encodeURIComponent(config.providerLabel)}`;
			console.log("");
			console.log(`  Public (${config.expose}):  ${tunnel.url}`);
			console.log("");
			console.log(`  ${url}`);
			console.log("");
			try {
				execSync(`qrencode -t ANSIUTF8 ${JSON.stringify(url)}`, { stdio: "inherit" });
			} catch {
				console.log("  (install `qrencode` to print a scannable QR code)");
			}
			console.log("");
		} catch (error) {
			console.error(`  Tunnel unavailable: ${error.message}`);
			console.error("  The LAN QR above still works; retry with another --expose provider.");
		}
	}

	const shutdown = async () => {
		log.info("shutting down");
		if (tunnel) stopTunnel(tunnel.child);
		await bridge.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Keep the process alive; the HTTP server owns the event loop.
	return new Promise(() => {});
}
