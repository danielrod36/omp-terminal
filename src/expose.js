import { spawn } from "node:child_process";
import { createLogger, redactToken } from "./log.js";

const log = createLogger("expose");

/**
 * Quick public tunnels for WAN access.
 *
 * The stock even-terminal ships pinggy/bore/ngrok. This adds a `cloudflare`
 * provider (`cloudflared tunnel --url`) because it needs no account, and keeps
 * the stock providers with identical argv so the QR the wearer scans is the
 * same shape either way.
 *
 * Verified live:
 *  - pinggy: `ssh ... -R0:127.0.0.1:<port> a.pinggy.io` prints
 *    `https://<name>.run.pinggy-free.link` and serves the tunnel immediately.
 *  - cloudflared: prints a bordered box containing
 *    `https://<words>.trycloudflare.com`.
 *
 * A provider only helps if the host can reach its edge. cloudflared's edge
 * (port 7844/443 to *.argotunnel.com) fails behind a transparent TLS proxy:
 * the handshake returns `SSL alert 42` / EOF because the intercepting proxy
 * serves an origin certificate instead of the edge's public one. `preflight()`
 * detects that and reports the exact reason instead of hanging.
 */
export const PROVIDERS = {
	cloudflare: {
		name: "cloudflare",
		program: "cloudflared",
		envPathVar: "CLOUDFLARED_PROGRAM_PATH",
		installHint: "Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ (or `pacman -S cloudflared`)",
		buildArgs: port => ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
		parseUrl: output => {
			// The account-less quick tunnel prints a bordered box; the URL is the
			// only trycloudflare hostname in the stream.
			const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
			return match?.[0];
		},
		// cloudflared needs its edge reachable; a blocked edge never yields a URL.
		preflight: async () => {
			const net = await import("node:tls");
			return new Promise(resolve => {
				const socket = net.connect({
					host: "region1.v2.argotunnel.com",
					port: 7844,
					servername: "region1.v2.argotunnel.com",
					rejectUnauthorized: false,
					timeout: 6000,
				});
				const done = ok => {
					socket.destroy();
					resolve(ok);
				};
				socket.once("secureConnect", () => {
					// The edge must present a publicly-trusted chain. A transparent
					// proxy substitutes an origin certificate, which cloudflared
					// rejects; report that instead of letting it spin.
					const authorized = socket.authorized;
					done(authorized ? true : { ok: false, reason: "edge presented an untrusted certificate (transparent TLS proxy?)" });
				});
				socket.once("error", error => resolve({ ok: false, reason: `edge unreachable: ${error.message}` }));
				socket.once("timeout", () => resolve({ ok: false, reason: "edge connection timed out" }));
			});
		},
	},

	pinggy: {
		name: "pinggy",
		program: "ssh",
		envPathVar: "PINGGY_PROGRAM_PATH",
		installHint: "No install needed — uses your system's ssh client.",
		buildArgs: port => ["-T", "-o", "StrictHostKeyChecking=no", "-p", "443", "-R0:127.0.0.1:" + String(port), "a.pinggy.io"],
		parseUrl: output => {
			const https = output.match(/https:\/\/[^\s]+\.pinggy(?:-free)?\.(?:link|net)/);
			if (https) return https[0];
			const http = output.match(/http:\/\/[^\s]+\.pinggy(?:-free)?\.(?:link|net)/);
			return http?.[0];
		},
	},

	bore: {
		name: "bore",
		program: "bore",
		envPathVar: "BORE_PROGRAM_PATH",
		installHint: "Install: `cargo install bore-cli`, a distro package, or a GitHub release binary.",
		buildArgs: port => ["local", String(port), "--to", "bore.pub"],
		parseUrl: output => {
			const match = output.match(/\blistening at\s+bore\.pub:(\d+)\b/i);
			return match ? `http://bore.pub:${match[1]}` : undefined;
		},
	},

	ngrok: {
		name: "ngrok",
		program: "ngrok",
		envPathVar: "NGROK_PROGRAM_PATH",
		installHint: "Install from https://ngrok.com/download, then run `ngrok config add-authtoken <TOKEN>` (free account required).",
		buildArgs: port => ["http", String(port), "--log=stdout", "--log-format=json"],
		parseUrl: output => {
			for (const line of output.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let event;
				try {
					event = JSON.parse(trimmed);
				} catch {
					continue;
				}
				if (!event || typeof event !== "object" || !("addr" in event)) continue;
				if (typeof event.url === "string" && /^https?:\/\/[^/]+\.ngrok/.test(event.url)) return event.url;
			}
			return undefined;
		},
	},
};

export function providerNames() {
	return Object.keys(PROVIDERS);
}

/**
 * Start a quick tunnel and resolve once its public URL appears.
 *
 * Returns `{ url, stop }`; the child is owned by the caller so SIGINT shutdown
 * can reap it. Rejects (rather than hanging) when the provider never prints a
 * URL, when the program is missing, or when `preflight()` says the edge is
 * unreachable.
 */
export async function startTunnel({ providerName, port, onLog = () => {} }) {
	const provider = PROVIDERS[providerName];
	if (!provider) throw new Error(`unknown expose provider '${providerName}' (known: ${providerNames().join(", ")})`);

	if (provider.preflight) {
		const pre = await provider.preflight();
		if (pre !== true) {
			const reason = typeof pre === "object" && pre.reason ? pre.reason : "preflight failed";
			throw new Error(`${providerName} cannot reach its edge from this host — ${reason}`);
		}
	}

	const program = process.env[provider.envPathVar] || provider.program;
	const args = provider.buildArgs(port);
	log.info(`starting ${providerName}: ${program} ${args.join(" ")}`);
	const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });

	return await new Promise((resolve, reject) => {
		let buffer = "";
		let settled = false;
		const finish = url => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ url, child, provider, stop: () => stopTunnel(child) });
		};

		const handle = chunk => {
			const text = chunk.toString();
			buffer += text;
			// Keep the buffer bounded; URLs appear early in the stream.
			if (buffer.length > 256 * 1024) buffer = buffer.slice(-64 * 1024);
			for (const line of text.split(/\r?\n/)) {
				if (line.trim()) onLog(redactToken(line.trim()));
			}
			const url = provider.parseUrl(buffer);
			if (url) finish(url);
		};

		child.stdout.on("data", handle);
		child.stderr.on("data", handle);
		child.on("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(
				new Error(
					`failed to start ${providerName}: ${error.message}. Checked program: ${program}. Override with ${provider.envPathVar}=... . ${provider.installHint}`,
				),
			);
		});
		child.on("exit", code => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`${providerName} exited (code ${code}) before printing a public URL. ${provider.installHint}`));
		});

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			stopTunnel(child);
			reject(new Error(`${providerName} did not print a public URL within 45s`));
		}, 45_000);
		timer.unref?.();
	});
}

export function stopTunnel(child) {
	if (!child) return;
	try {
		child.kill();
	} catch {
		/* already gone */
	}
}
