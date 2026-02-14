import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";
import { HolonClient, HolonError } from "../src/index.mjs";
import { HolonServer } from "../src/server.mjs";

let loopbackProbe = null;

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

function itRequiresLoopback(name, fn) {
    it(name, async (t) => {
        if (!await canListenOnLoopback()) {
            t.skip("socket bind not permitted in this environment");
            return;
        }
        await fn();
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOpen(ws, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("timed out waiting for websocket open"));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            ws.off("open", onOpen);
            ws.off("error", onError);
        };

        const onOpen = () => {
            cleanup();
            resolve();
        };

        const onError = (err) => {
            cleanup();
            reject(err);
        };

        ws.once("open", onOpen);
        ws.once("error", onError);
    });
}

function waitForClose(ws, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("timed out waiting for websocket close"));
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(timer);
            ws.off("close", onClose);
            ws.off("error", onError);
        };

        const onClose = (code, reason) => {
            cleanup();
            resolve({ code, reason: reason.toString("utf8") });
        };

        const onError = (err) => {
            cleanup();
            reject(err);
        };

        ws.once("close", onClose);
        ws.once("error", onError);
    });
}

describe("HolonServer", () => {
    itRequiresLoopback("accepts HolonClient invoke and supports server->client invoke", async () => {
        const server = new HolonServer("ws://127.0.0.1:0/rpc", { maxConnections: 1 });
        server.register("echo.v1.Echo/Ping", (params = {}) => ({
            message: String(params.message || ""),
            sdk: "js-web-holons",
            version: "0.1.0",
        }));

        const uri = await server.start();
        const client = new HolonClient(uri, {
            WebSocket,
            reconnect: false,
            heartbeat: false,
        });

        client.register("test.v1.Client/Pong", (params = {}) => ({
            message: `pong:${String(params.message || "")}`,
        }));

        try {
            const echoed = await client.invoke("echo.v1.Echo/Ping", { message: "cert" });
            assert.equal(echoed.message, "cert");
            assert.equal(echoed.sdk, "js-web-holons");

            const peer = await server.waitForClient({ timeout: 1000 });
            const back = await server.invoke(peer.id, "test.v1.Client/Pong", { message: "from-server" });
            assert.equal(back.message, "pong:from-server");

            await assert.rejects(
                () => client.invoke("does.not.Exist/Nope", {}),
                (err) => {
                    assert(err instanceof HolonError);
                    assert.equal(err.code, -32601);
                    return true;
                },
            );
        } finally {
            client.close();
            await server.close();
        }
    });

    itRequiresLoopback("enforces monovalent mode by closing a second concurrent connection", async () => {
        const server = new HolonServer("ws://127.0.0.1:0/rpc", { maxConnections: 1 });
        server.register("echo.v1.Echo/Ping", (params = {}) => params);

        const uri = await server.start();
        const first = new WebSocket(uri, "holon-rpc");

        try {
            await waitForOpen(first);
            const second = new WebSocket(uri, "holon-rpc");

            try {
                const closed = await waitForClose(second);
                assert.equal(closed.code, 1008);
            } finally {
                second.close();
            }

            await wait(30);
            assert.equal(server.listClients().length, 1);
        } finally {
            first.close();
            await server.close();
        }
    });

    itRequiresLoopback("rejects oversized messages with close code 1009 and remains healthy", async () => {
        const server = new HolonServer("ws://127.0.0.1:0/rpc", {
            maxConnections: 2,
            maxPayloadBytes: 1024 * 1024,
        });
        server.register("echo.v1.Echo/Ping", (params = {}) => params);

        const uri = await server.start();
        const ws = new WebSocket(uri, "holon-rpc");

        try {
            await waitForOpen(ws);

            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: "big-1",
                method: "echo.v1.Echo/Ping",
                params: { message: "x".repeat(2 * 1024 * 1024) },
            }));

            const closed = await waitForClose(ws, 3000);
            assert.equal(closed.code, 1009);

            const probe = new HolonClient(uri, {
                WebSocket,
                reconnect: false,
                heartbeat: false,
            });

            try {
                const heartbeat = await probe.invoke("rpc.heartbeat", {});
                assert.deepEqual(heartbeat, {});
            } finally {
                probe.close();
            }
        } finally {
            ws.close();
            await server.close();
        }
    });

    itRequiresLoopback("survives client disconnect while handler is still running", async () => {
        const server = new HolonServer("ws://127.0.0.1:0/rpc", {
            maxConnections: 2,
        });
        server.register("echo.v1.Echo/Ping", async (params = {}) => {
            await wait(80);
            return { message: String(params.message || "") };
        });

        const uri = await server.start();
        const ws = new WebSocket(uri, "holon-rpc");

        try {
            await waitForOpen(ws);
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: "race-1",
                method: "echo.v1.Echo/Ping",
                params: { message: "race" },
            }));
            ws.close(1000, "disconnect");

            await wait(120);

            const probe = new HolonClient(uri, {
                WebSocket,
                reconnect: false,
                heartbeat: false,
            });

            try {
                const heartbeat = await probe.invoke("rpc.heartbeat", {});
                assert.deepEqual(heartbeat, {});
            } finally {
                probe.close();
            }
        } finally {
            ws.close();
            await server.close();
        }
    });
});
