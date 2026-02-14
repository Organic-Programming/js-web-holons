---
# Cartouche v1
title: "js-web-holons — Browser SDK for Organic Programming"
author:
  name: "B. ALTER"
  copyright: "© 2026 Benoit Pereira da Silva"
created: 2026-02-12
revised: 2026-02-12
lang: en-US
access:
  humans: true
  agents: true
status: draft
---
# js-web-holons

**Browser-side Holon-RPC client plus a Node test/server harness.**

This SDK is the browser counterpart to `go-holons/pkg/transport.WebBridge`.
Together they allow any browser application to call holon methods via
a simple JSON-over-WebSocket protocol — no gRPC-Web, no Envoy, no proxy.

## Architecture

```
┌──────────────┐   WebSocket       ┌──────────────────────────────────┐
│  Browser     │  ws://:8080/ws    │  Go Holon                        │
│  js-web-     │ ◄──────────────►  │  ┌──────────┐   ┌─────────────┐ │
│  holons      │  holon-rpc proto  │  │ WebBridge │──►│ gRPC server │ │
│  (client)    │                   │  │ (JSON/WS) │   │ (standard)  │ │
└──────────────┘                   │  └──────────┘   └─────────────┘ │
                                   └──────────────────────────────────┘
```

## Wire Protocol

The protocol is JSON-RPC 2.0 over WebSocket with subprotocol `holon-rpc`:

**Request** (browser → server):
```json
{ "jsonrpc": "2.0", "id": "1", "method": "hello.v1.HelloService/Greet", "params": {"name":"Alice"} }
```

**Response** (server → browser):
```json
{ "jsonrpc": "2.0", "id": "1", "result": {"message":"Hello, Alice!"} }
```

**Error** (server → browser):
```json
{ "jsonrpc": "2.0", "id": "1", "error": {"code": 12, "message": "method not registered"} }
```

For strict envelope rules and ID semantics, see [`PROTOCOL.md`](./PROTOCOL.md).

## Usage (Browser)

```html
<script type="module">
  import { HolonClient } from "./js-web-holons/src/index.mjs";

  const client = new HolonClient("ws://localhost:8080/ws");
  const resp = await client.invoke("hello.v1.HelloService/Greet", { name: "Alice" });
  console.log(resp.message); // "Hello, Alice!"
  client.close();
</script>
```

## API

### `new HolonClient(url, options?)`

- `url` — WebSocket URL, e.g. `"ws://localhost:8080/ws"`
- `options.WebSocket` — WebSocket constructor override (for Node.js testing)
- `options.defaultTimeout` — default invoke timeout in ms (default: `30000`)
- `options.connectTimeout` — connection timeout in ms (default: `10000`)
- `options.maxPendingRequests` — max concurrent in-flight `invoke()` calls (default: `256`)
- `options.maxTrackedResponseIds` — bounded cache for duplicate/stale response ID classification (default: `1024`)
- `options.reconnect` — reconnect policy
- `options.heartbeat` — heartbeat/stale-connection policy
- `options.onProtocolWarning` — callback for protocol anomalies

### `client.connect()` → `Promise<void>`

Establishes the WebSocket connection. Called automatically on first `invoke()`.

### `client.invoke(method, payload?, options?)` → `Promise<Object>`

Invoke a holon RPC method.

- `method` — full method path, e.g. `"hello.v1.HelloService/Greet"`
- `payload` — JSON-serializable request object (default: `{}`)
- `options.timeout` — timeout in ms (default: `options.defaultTimeout` or `30000`)

Throws `HolonError` on server errors or timeout.

### `client.close()`

Close the WebSocket connection gracefully.

### `HolonError`

Error class with `code` (integer) and `message` (string) properties.

### `new HolonServer(uri, options?)` (Node test/runtime harness)

- `uri` — WebSocket bind URL, e.g. `"ws://127.0.0.1:0/rpc"`
- `options.maxConnections` — maximum concurrent WebSocket peers (`1` by default for monovalent behavior)
- `options.maxPayloadBytes` — max inbound message size (`1 MiB` default; oversize closes with WS 1009)
- `options.shutdownGraceMs` — graceful shutdown drain window (`10000` ms default)

Methods:

- `server.register(method, handler)` — register a server-side handler
- `server.invoke(clientID, method, params)` — server-initiated call to a connected client
- `server.waitForClient({ timeout })` — wait for first connected client
- `server.start()` / `server.close()` — lifecycle management

## Test and Sanity Check

```bash
npm install
npm test

# Compatibility sanity check against the Go WebBridge
(cd ../go-holons && go test ./pkg/transport -run WebBridge -count=1)
```

## SDK Sync (Drift Elimination)

`examples/web-hello-world/static/holons.mjs` is a synced copy of this SDK.

```bash
# Copy sdk/js-web-holons/src/index.mjs into examples/web-hello-world/static/holons.mjs
bash ../../scripts/sync-web-sdk.sh sync

# Fail if the copied file has drifted
bash ../../scripts/sync-web-sdk.sh check
```

## Server-Side Setup (Go)

```go
import "github.com/Organic-Programming/go-holons/pkg/transport"

bridge := transport.NewWebBridge()
bridge.Register("hello.v1.HelloService/Greet", greetHandler)

mux := http.NewServeMux()
mux.HandleFunc("/ws", bridge.HandleWebSocket)
http.ListenAndServe(":8080", mux)
```
