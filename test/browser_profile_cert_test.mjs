import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { HolonClient } from "../src/index.mjs";
import { HolonServer } from "../src/server.mjs";

const GO_BIN = process.env.GO_BIN || "go";
const GOCACHE = process.env.GOCACHE || "/tmp/go-cache";
const GO_ENV = (() => {
    const env = {
        ...process.env,
        GOCACHE,
    };
    delete env.GOROOT;
    delete env.GOTOOLDIR;
    return env;
})();

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIR = path.resolve(TEST_DIR, "..");
const GO_HOLONS_DIR = path.resolve(SDK_DIR, "..", "go-holons");
const ECHO_SERVER_PATH = path.resolve(SDK_DIR, "cmd", "echo-server.mjs");
const GO_CERT_HELPER_PATH = path.resolve(SDK_DIR, "cmd", "cert-go", "main.go");

let loopbackProbe = null;
let goProbe = null;

function isSocketPermissionError(err) {
    if (!err) return false;
    if (err.code === "EPERM" || err.code === "EACCES") return true;
    return /listen\s+(eperm|eacces)/i.test(String(err.message || err));
}

function canListenOnLoopback() {
    if (loopbackProbe) {
        return loopbackProbe;
    }

    loopbackProbe = new Promise((resolve) => {
        const probe = createNetServer();

        probe.once("error", (err) => {
            resolve(!isSocketPermissionError(err));
        });

        probe.listen(0, "127.0.0.1", () => {
            probe.close(() => resolve(true));
        });
    });

    return loopbackProbe;
}

function hasGoTool() {
    if (goProbe !== null) {
        return goProbe;
    }

    const out = spawnSync(GO_BIN, ["run", GO_CERT_HELPER_PATH, "--help"], {
        cwd: GO_HOLONS_DIR,
        encoding: "utf8",
        env: GO_ENV,
    });

    goProbe = out.status === 0;
    return goProbe;
}

function itRequiresGoAndLoopback(name, fn) {
    it(name, async (t) => {
        if (!await canListenOnLoopback()) {
            t.skip("socket bind not permitted in this environment");
            return;
        }
        if (!hasGoTool()) {
            t.skip(`go toolchain not available (GO_BIN=${GO_BIN})`);
            return;
        }
        await fn();
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastNonEmptyLine(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : "";
}

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            resolve({
                code: code ?? 1,
                stdout,
                stderr,
            });
        });
    });
}

function waitForExit(child, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            clearTimeout(timer);
            child.off("exit", onExit);
            child.off("close", onClose);
            child.off("error", onError);
        };

        const settle = (fn) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            fn();
        };

        const onExit = (code, signal) => {
            settle(() => resolve({ code, signal }));
        };

        const onClose = (code, signal) => {
            settle(() => resolve({
                code: code ?? child.exitCode,
                signal: signal ?? child.signalCode,
            }));
        };

        const onError = (err) => {
            settle(() => reject(err));
        };

        const timer = setTimeout(() => {
            if (child.exitCode !== null) {
                settle(() => resolve({ code: child.exitCode, signal: child.signalCode }));
                return;
            }
            settle(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)));
        }, timeoutMs);

        child.once("exit", onExit);
        child.once("close", onClose);
        child.once("error", onError);

        if (child.exitCode !== null) {
            settle(() => resolve({ code: child.exitCode, signal: child.signalCode }));
        }
    });
}

function waitForFirstStdoutLine(child, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        let buffer = "";

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`timed out waiting for process startup line after ${timeoutMs}ms`));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            child.off("exit", onExit);
            child.off("error", onError);
        };

        const onData = (chunk) => {
            buffer += chunk.toString();
            const idx = buffer.indexOf("\n");
            if (idx === -1) {
                return;
            }
            const line = buffer.slice(0, idx).trim();
            cleanup();
            resolve(line);
        };

        const onExit = (code, signal) => {
            cleanup();
            reject(new Error(`process exited before startup line (code=${String(code)} signal=${String(signal)})`));
        };

        const onError = (err) => {
            cleanup();
            reject(err);
        };

        child.stdout.on("data", onData);
        child.once("exit", onExit);
        child.once("error", onError);
    });
}

async function stopProcess(child, signal = "SIGTERM") {
    if (!child || child.exitCode !== null) {
        return;
    }

    child.kill(signal);
    try {
        await waitForExit(child, 5000);
    } catch {
        child.kill("SIGKILL");
        await waitForExit(child, 2000);
    }
}

async function startEchoServer(options = {}) {
    const args = [
        ECHO_SERVER_PATH,
        "--listen",
        options.listen || "ws://127.0.0.1:0/rpc",
        "--max-connections",
        String(options.maxConnections ?? 1),
    ];

    if (typeof options.handlerDelayMs === "number") {
        args.push("--handler-delay-ms", String(options.handlerDelayMs));
    }
    if (typeof options.maxPayloadBytes === "number") {
        args.push("--max-payload-bytes", String(options.maxPayloadBytes));
    }
    if (typeof options.shutdownGraceMs === "number") {
        args.push("--shutdown-grace-ms", String(options.shutdownGraceMs));
    }

    const child = spawn(process.execPath, args, {
        cwd: SDK_DIR,
        env: {
            ...process.env,
            GOCACHE,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
    });

    const address = await waitForFirstStdoutLine(child, 8000);
    return { child, address, getStderr: () => stderr };
}

async function runGoHelper(mode, uri, args = []) {
    const result = await runCommand(
        GO_BIN,
        [
            "run",
            GO_CERT_HELPER_PATH,
            "--mode",
            mode,
            ...args,
            uri,
        ],
        {
            cwd: GO_HOLONS_DIR,
            env: {
                ...GO_ENV,
            },
        },
    );

    if (result.code !== 0) {
        throw new Error(`go helper mode=${mode} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }

    const payloadLine = lastNonEmptyLine(result.stdout);
    if (!payloadLine) {
        throw new Error(`go helper mode=${mode} returned empty stdout`);
    }

    let decoded;
    try {
        decoded = JSON.parse(payloadLine);
    } catch {
        throw new Error(`go helper mode=${mode} returned invalid JSON: ${payloadLine}`);
    }

    assert.equal(decoded.status, "pass");
    assert.equal(decoded.mode, mode);
    return decoded;
}

async function reserveListenURI() {
    return new Promise((resolve, reject) => {
        const probe = createNetServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const addr = probe.address();
            const port = addr && typeof addr === "object" ? addr.port : 0;
            probe.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(`ws://127.0.0.1:${port}/rpc`);
            });
        });
    });
}

describe("browser profile certification", () => {
    itRequiresGoAndLoopback("3.4/4.3: Go Holon-RPC client reaches js-web HolonServer echo", async () => {
        const server = await startEchoServer({
            maxConnections: 4,
        });

        try {
            const out = await runGoHelper("echo", server.address, ["--message", "interop"]);
            assert.equal(out.data.message, "interop");
        } finally {
            await stopProcess(server.child);
        }
    });

    itRequiresGoAndLoopback("4.5: bidirectional Go<->js-web Holon-RPC works", async () => {
        const server = new HolonServer("ws://127.0.0.1:0/rpc", {
            maxConnections: 1,
        });
        server.register("echo.v1.Echo/Ping", (params = {}) => ({
            message: String(params.message || ""),
            sdk: "js-web-holons",
        }));

        const address = await server.start();
        const helperPromise = runGoHelper("bidirectional", address, [
            "--message",
            "bidirectional",
            "--timeout-ms",
            "5000",
        ]);

        try {
            const peer = await server.waitForClient({ timeout: 2000 });
            const resp = await server.invoke(peer.id, "test.v1.Client/Pong", { message: "from-js" });
            assert.equal(resp.message, "pong:from-js");

            const helperOut = await helperPromise;
            assert.equal(helperOut.data.server_call, "from-js");
        } finally {
            await server.close();
        }
    });

    itRequiresGoAndLoopback("5.1: HolonServer.close drains in-flight requests", async () => {
        let resolveStarted = () => {};
        const started = new Promise((resolve) => {
            resolveStarted = resolve;
        });

        const server = new HolonServer("ws://127.0.0.1:0/rpc", {
            maxConnections: 2,
            shutdownGraceMs: 2000,
        });
        server.register("echo.v1.Echo/Ping", async (params = {}) => {
            resolveStarted();
            await wait(250);
            return {
                message: String(params.message || ""),
            };
        });

        const address = await server.start();
        const helperPromise = runGoHelper("echo", address, [
            "--message",
            "graceful",
            "--timeout-ms",
            "3000",
        ]);

        try {
            await started;
            await server.close();
            const out = await helperPromise;
            assert.equal(out.data.message, "graceful");
        } finally {
            await server.close();
        }
    });

    itRequiresGoAndLoopback("5.1: echo-server process exits 0 on SIGTERM", async () => {
        const server = await startEchoServer();

        try {
            const exitPromise = waitForExit(server.child, 5000);
            server.child.kill("SIGTERM");
            const out = await exitPromise;
            assert.equal(out.code, 0, server.getStderr());
            assert.equal(out.signal, null);
        } finally {
            await stopProcess(server.child);
        }
    });

    itRequiresGoAndLoopback("5.2: HolonClient reconnects within 5s after server restart", async () => {
        const listen = await reserveListenURI();
        let server = new HolonServer(listen, {
            maxConnections: 4,
        });
        server.register("echo.v1.Echo/Ping", (params = {}) => ({
            message: String(params.message || ""),
            sdk: "js-web-holons",
        }));
        await server.start();

        const client = new HolonClient(listen, {
            WebSocket,
            reconnect: {
                enabled: true,
                minDelay: 50,
                maxDelay: 200,
                factor: 1.5,
                jitter: 0,
            },
            heartbeat: false,
            connectTimeout: 1000,
            defaultTimeout: 1000,
        });

        try {
            const before = await client.invoke("echo.v1.Echo/Ping", { message: "before" }, { timeout: 1000 });
            assert.equal(before.message, "before");

            await server.close();
            server = new HolonServer(listen, {
                maxConnections: 4,
            });
            server.register("echo.v1.Echo/Ping", (params = {}) => ({
                message: String(params.message || ""),
                sdk: "js-web-holons",
            }));
            await server.start();

            await server.waitForClient({ timeout: 5000 });
            const after = await client.invoke("echo.v1.Echo/Ping", { message: "after" }, { timeout: 1000 });
            assert.equal(after.message, "after");
        } finally {
            client.close();
            await server.close();
        }
    });

    itRequiresGoAndLoopback("5.3: 50 concurrent Go clients succeed against HolonServer", async () => {
        const server = await startEchoServer({
            maxConnections: 64,
        });

        try {
            const out = await runGoHelper("concurrent-load", server.address, [
                "--clients",
                "50",
                "--timeout-ms",
                "6000",
            ]);
            assert.equal(out.data.clients, 50);
        } finally {
            await stopProcess(server.child);
        }
    });

    itRequiresGoAndLoopback("5.4: 100 connect/disconnect cycles remain stable", async () => {
        const server = await startEchoServer({
            maxConnections: 8,
        });

        try {
            const cleanup = await runGoHelper("resource-cleanup", server.address, [
                "--cycles",
                "100",
                "--timeout-ms",
                "3000",
            ]);
            assert.ok(cleanup.data.goroutine_delta <= 5);

            const probe = await runGoHelper("echo", server.address, ["--message", "post-cleanup"]);
            assert.equal(probe.data.message, "post-cleanup");
        } finally {
            await stopProcess(server.child);
        }
    });

    itRequiresGoAndLoopback("5.5: timeout propagates when handler delay exceeds client deadline", async () => {
        const server = await startEchoServer({
            maxConnections: 2,
            handlerDelayMs: 5000,
        });

        try {
            const out = await runGoHelper("timeout", server.address, ["--timeout-ms", "2000"]);
            assert.match(String(out.data.error), /timeout|deadline/i);
        } finally {
            await stopProcess(server.child);
        }
    });

    itRequiresGoAndLoopback("5.6: server survives abrupt close of 2/20 clients", async () => {
        const server = await startEchoServer({
            maxConnections: 24,
            handlerDelayMs: 100,
        });

        try {
            const out = await runGoHelper("chaos", server.address, [
                "--clients",
                "20",
                "--drop-count",
                "2",
                "--timeout-ms",
                "6000",
            ]);
            assert.equal(out.data.clients, 20);
            assert.equal(out.data.dropped, 2);
        } finally {
            await stopProcess(server.child);
        }
    });

    itRequiresGoAndLoopback("5.7: oversized message triggers WS 1009 and server stays healthy", async () => {
        const server = await startEchoServer({
            maxConnections: 4,
            maxPayloadBytes: 1024 * 1024,
        });

        try {
            const out = await runGoHelper("oversize", server.address, [
                "--payload-bytes",
                String(2 * 1024 * 1024),
                "--timeout-ms",
                "6000",
            ]);
            assert.equal(out.data.close_status, 1009);
        } finally {
            await stopProcess(server.child);
        }
    });
});
