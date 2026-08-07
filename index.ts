import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";

const API_SOCKET = "/.sprite/api.sock";
const TASK_EXPIRY = "5m";
const HEARTBEAT_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const STATUS_KEY = "sprite-keepalive";

interface ApiError extends Error {
	statusCode?: number;
}

function apiRequest(method: "PUT" | "DELETE", path: string, body?: object): Promise<void> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const req = request(
			{
				socketPath: API_SOCKET,
				hostname: "sprite",
				method,
				path,
				headers: {
					Host: "sprite",
					...(payload === undefined
						? {}
						: {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(payload),
							}),
				},
			},
			(response) => {
				let responseBody = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					if (responseBody.length < 8_192) responseBody += chunk;
				});
				response.on("end", () => {
					const status = response.statusCode ?? 0;
					if ((status >= 200 && status < 300) || (method === "DELETE" && status === 404)) {
						resolve();
						return;
					}

					const error = new Error(
						`Sprite Tasks API returned HTTP ${status}${responseBody ? `: ${responseBody.trim()}` : ""}`,
					) as ApiError;
					error.statusCode = status;
					reject(error);
				});
			},
		);

		req.setTimeout(REQUEST_TIMEOUT_MS, () => {
			req.destroy(new Error("Sprite Tasks API request timed out"));
		});
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

export default function spriteKeepalive(pi: ExtensionAPI) {
	// A unique name prevents concurrent Pi processes from releasing each other's hold.
	const taskName = `pi-agent-${process.pid}-${randomUUID().slice(0, 8)}`;
	const taskPath = `/v1/tasks/${encodeURIComponent(taskName)}`;

	let desiredActive = false;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let operationQueue: Promise<void> = Promise.resolve();
	let heartbeatFailed = false;

	function serialize(operation: () => Promise<void>): Promise<void> {
		const run = operationQueue.then(operation, operation);
		operationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function setActiveStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", "sprite: awake"));
	}

	function reportHeartbeatFailure(ctx: ExtensionContext, error: unknown): void {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "sprite: keepalive failed"));
		if (!heartbeatFailed) {
			heartbeatFailed = true;
			ctx.ui.notify(`Sprite keepalive failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		if (!desiredActive) return;
		await apiRequest("PUT", taskPath, { expire: TASK_EXPIRY });
		heartbeatFailed = false;
		setActiveStatus(ctx);
	}

	async function start(ctx: ExtensionContext): Promise<void> {
		if (desiredActive || !existsSync(API_SOCKET)) return;
		desiredActive = true;

		try {
			await serialize(() => refresh(ctx));
		} catch (error) {
			reportHeartbeatFailure(ctx, error);
		}

		if (!desiredActive || heartbeatTimer) return;
		heartbeatTimer = setInterval(() => {
			void serialize(() => refresh(ctx)).catch((error) => reportHeartbeatFailure(ctx, error));
		}, HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref();
	}

	async function stop(ctx: ExtensionContext): Promise<void> {
		desiredActive = false;
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}

		if (existsSync(API_SOCKET)) {
			try {
				// Serialization ensures an in-flight heartbeat cannot recreate the task after deletion.
				await serialize(() => apiRequest("DELETE", taskPath));
			} catch (error) {
				ctx.ui.notify(
					`Sprite keepalive cleanup failed; it will expire within ${TASK_EXPIRY}: ${
						error instanceof Error ? error.message : String(error)
					}`,
					"warning",
				);
			}
		}

		heartbeatFailed = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	pi.on("agent_start", async (_event, ctx) => {
		await start(ctx);
	});

	// agent_settled occurs after retries, compaction retries, and queued follow-ups.
	pi.on("agent_settled", async (_event, ctx) => {
		await stop(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stop(ctx);
	});
}
