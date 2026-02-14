#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { HolonServer } from "../src/server.mjs";

const DEFAULT_LISTEN = "ws://127.0.0.1:0/rpc";
const DEFAULT_SDK = "js-web-holons";
const DEFAULT_VERSION = "0.1.0";
const DEFAULT_MAX_CONNECTIONS = 1;

export function parseArgs(argv = process.argv) {
    const out = {
        listen: DEFAULT_LISTEN,
        sdk: DEFAULT_SDK,
        version: DEFAULT_VERSION,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
    };

    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];

        if (token === "--listen") {
            out.listen = requireValue(argv, i, "--listen");
            i += 1;
            continue;
        }
        if (token === "--sdk") {
            out.sdk = requireValue(argv, i, "--sdk");
            i += 1;
            continue;
        }
        if (token === "--version") {
            out.version = requireValue(argv, i, "--version");
            i += 1;
            continue;
        }
        if (token === "--max-connections") {
            const raw = requireValue(argv, i, "--max-connections");
            const parsed = Number(raw);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error("--max-connections must be a positive integer");
            }
            out.maxConnections = parsed;
            i += 1;
            continue;
        }

        throw new Error(`unknown flag: ${token}`);
    }

    return out;
}

export async function run(argv = process.argv, options = {}) {
    const args = parseArgs(argv);

    const createServer = options.createServer
        || ((uri, serverOptions) => new HolonServer(uri, serverOptions));
    const server = createServer(args.listen, {
        maxConnections: args.maxConnections,
    });

    server.register("echo.v1.Echo/Ping", (params = {}) => {
        const message = typeof params?.message === "string" ? params.message : "";
        return {
            message,
            sdk: args.sdk,
            version: args.version,
        };
    });

    const address = await server.start();
    const onStarted = options.onStarted
        || ((uri) => process.stdout.write(`${uri}\n`));
    onStarted(address);

    if (options.keepAlive === false) {
        return {
            args,
            address,
            server,
        };
    }

    await waitForShutdown(server, options.shutdownSignals || ["SIGINT", "SIGTERM"]);

    return {
        args,
        address,
        server,
    };
}

function waitForShutdown(server, signals) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const listeners = [];

        const cleanup = () => {
            for (const [signal, listener] of listeners) {
                process.off(signal, listener);
            }
        };

        const finish = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) {
                reject(err);
                return;
            }
            resolve();
        };

        const closeServer = async () => {
            try {
                await server.close();
                finish(null);
            } catch (err) {
                finish(err);
            }
        };

        for (const signal of signals) {
            const listener = () => {
                closeServer();
            };
            listeners.push([signal, listener]);
            process.once(signal, listener);
        }
    });
}

function requireValue(argv, index, flag) {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`missing value for ${flag}`);
    }
    return value;
}

async function main() {
    try {
        await run(process.argv);
    } catch (err) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main();
}
