import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import {
    parseArgs,
    buildInvocation,
    run,
} from "../cmd/echo-client.mjs";

function makeSpawn(result, capture = {}) {
    return (command, args, options) => {
        capture.command = command;
        capture.args = args;
        capture.options = options;

        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();

        queueMicrotask(() => {
            if (result.stdout) {
                child.stdout.write(result.stdout);
            }
            if (result.stderr) {
                child.stderr.write(result.stderr);
            }
            child.stdout.end();
            child.stderr.end();
            child.emit("close", result.code ?? 0);
        });

        return child;
    };
}

describe("certification", () => {
    it("cert.json declares echo commands and certification capabilities", async () => {
        const raw = await readFile(new URL("../cert.json", import.meta.url), "utf8");
        const cert = JSON.parse(raw);

        assert.equal(cert.executables.echo_server, "node ./cmd/echo-server.mjs");
        assert.equal(cert.executables.echo_client, "node ./cmd/echo-client.mjs");
        assert.equal(cert.capabilities.grpc_dial_tcp, true);
        assert.equal(cert.capabilities.grpc_dial_stdio, true);
        assert.equal(cert.capabilities.holon_rpc_server, true);
        assert.equal(cert.capabilities.valence, "mono");
    });

    it("parseArgs uses expected defaults", () => {
        const parsed = parseArgs(["node", "echo-client.mjs"]);

        assert.equal(parsed.uri, "stdio://");
        assert.equal(parsed.sdk, "js-web-holons");
        assert.equal(parsed.serverSDK, "go-holons");
        assert.equal(parsed.message, "hello");
        assert.equal(parsed.timeoutMs, 5000);
    });

    it("parseArgs supports explicit URI and flags", () => {
        const parsed = parseArgs([
            "node",
            "echo-client.mjs",
            "tcp://127.0.0.1:19090",
            "--sdk",
            "custom-sdk",
            "--server-sdk",
            "go-holons",
            "--message",
            "interop",
            "--timeout-ms",
            "2500",
            "--go",
            "go1.25",
        ]);

        assert.equal(parsed.uri, "tcp://127.0.0.1:19090");
        assert.equal(parsed.sdk, "custom-sdk");
        assert.equal(parsed.serverSDK, "go-holons");
        assert.equal(parsed.message, "interop");
        assert.equal(parsed.timeoutMs, 2500);
        assert.equal(parsed.goBinary, "go1.25");
    });

    it("buildInvocation constructs go invocation with helper path", () => {
        const invocation = buildInvocation(
            {
                uri: "stdio://",
                sdk: "js-web-holons",
                serverSDK: "go-holons",
                message: "hello",
                timeoutMs: 5000,
                goBinary: "go",
            },
            {
                goHolonsDir: "/repo/sdk/go-holons",
                helperPath: "/repo/sdk/js-web-holons/cmd/echo-client-go/main.go",
                env: {},
            },
        );

        assert.equal(invocation.command, "go");
        assert.equal(invocation.cwd, "/repo/sdk/go-holons");
        assert.deepEqual(invocation.args.slice(0, 2), [
            "run",
            "/repo/sdk/js-web-holons/cmd/echo-client-go/main.go",
        ]);
        assert.equal(invocation.args.at(-1), "stdio://");
        assert.equal(invocation.env.GOCACHE, "/tmp/go-cache");
    });

    it("run delegates to helper and returns decoded JSON", async () => {
        const capture = {};
        const result = await run(
            ["node", "echo-client.mjs", "tcp://127.0.0.1:19090", "--message", "cert"],
            {
                paths: {
                    goHolonsDir: "/repo/sdk/go-holons",
                    helperPath: "/repo/sdk/js-web-holons/cmd/echo-client-go/main.go",
                    env: {},
                },
                spawnFn: makeSpawn(
                    {
                        code: 0,
                        stdout: "{\"status\":\"pass\",\"sdk\":\"js-web-holons\",\"server_sdk\":\"go-holons\",\"latency_ms\":5}\n",
                    },
                    capture,
                ),
            },
        );

        assert.equal(capture.command, process.env.GO_BIN || "go");
        assert.equal(capture.args.includes("tcp://127.0.0.1:19090"), true);
        assert.equal(result.status, "pass");
        assert.equal(result.sdk, "js-web-holons");
    });

    it("run surfaces helper stderr when exit is non-zero", async () => {
        await assert.rejects(
            () => run(
                ["node", "echo-client.mjs"],
                {
                    paths: {
                        goHolonsDir: "/repo/sdk/go-holons",
                        helperPath: "/repo/sdk/js-web-holons/cmd/echo-client-go/main.go",
                        env: {},
                    },
                    spawnFn: makeSpawn({ code: 1, stderr: "dial failed\n" }),
                },
            ),
            /dial failed/,
        );
    });
});
