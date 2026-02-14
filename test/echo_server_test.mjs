import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, run } from "../cmd/echo-server.mjs";

describe("echo-server command", () => {
    it("parseArgs uses expected defaults", () => {
        const parsed = parseArgs(["node", "echo-server.mjs"]);

        assert.equal(parsed.listen, "ws://127.0.0.1:0/rpc");
        assert.equal(parsed.sdk, "js-web-holons");
        assert.equal(parsed.version, "0.1.0");
        assert.equal(parsed.maxConnections, 1);
        assert.equal(parsed.handlerDelayMs, 0);
        assert.equal(parsed.maxPayloadBytes, 1024 * 1024);
        assert.equal(parsed.shutdownGraceMs, 10_000);
    });

    it("parseArgs supports explicit flags", () => {
        const parsed = parseArgs([
            "node",
            "echo-server.mjs",
            "--listen",
            "ws://127.0.0.1:9999/custom",
            "--sdk",
            "custom-sdk",
            "--version",
            "9.9.9",
            "--max-connections",
            "3",
            "--handler-delay-ms",
            "250",
            "--max-payload-bytes",
            "131072",
            "--shutdown-grace-ms",
            "7500",
        ]);

        assert.equal(parsed.listen, "ws://127.0.0.1:9999/custom");
        assert.equal(parsed.sdk, "custom-sdk");
        assert.equal(parsed.version, "9.9.9");
        assert.equal(parsed.maxConnections, 3);
        assert.equal(parsed.handlerDelayMs, 250);
        assert.equal(parsed.maxPayloadBytes, 131072);
        assert.equal(parsed.shutdownGraceMs, 7500);
    });

    it("run registers echo handler and starts the server", async () => {
        const capture = {};
        const fakeServer = {
            register(method, handler) {
                capture.method = method;
                capture.handler = handler;
            },
            async start() {
                capture.started = true;
                return "ws://127.0.0.1:4567/rpc";
            },
            async close() {
                capture.closed = true;
            },
        };

        const result = await run(
            [
                "node",
                "echo-server.mjs",
                "--listen",
                "ws://127.0.0.1:4567/rpc",
                "--sdk",
                "custom-sdk",
                "--version",
                "1.2.3",
                "--max-connections",
                "2",
                "--handler-delay-ms",
                "30",
                "--max-payload-bytes",
                "2048",
                "--shutdown-grace-ms",
                "3000",
            ],
            {
                createServer: (uri, options) => {
                    capture.uri = uri;
                    capture.options = options;
                    return fakeServer;
                },
                onStarted: (uri) => {
                    capture.startedURI = uri;
                },
                keepAlive: false,
            },
        );

        assert.equal(capture.started, true);
        assert.equal(capture.uri, "ws://127.0.0.1:4567/rpc");
        assert.equal(capture.options.maxConnections, 2);
        assert.equal(capture.options.maxPayloadBytes, 2048);
        assert.equal(capture.options.shutdownGraceMs, 3000);
        assert.equal(capture.method, "echo.v1.Echo/Ping");
        assert.equal(capture.startedURI, "ws://127.0.0.1:4567/rpc");
        assert.equal(result.address, "ws://127.0.0.1:4567/rpc");

        const response = await capture.handler({ message: "hello" });
        assert.deepEqual(response, {
            message: "hello",
            sdk: "custom-sdk",
            version: "1.2.3",
        });
    });
});
