---
# Cartouche v1
title: "Holon-RPC Protocol Specification"
author:
  name: "B. ALTER"
  copyright: "© 2026 Benoit Pereira da Silva"
created: 2026-02-12
revised: 2026-02-13
lang: en-US
access:
  humans: true
  agents: true
status: draft
---
# Holon-RPC Protocol (js-web-holons)

This document specifies the JSON envelope protocol used between:

- `sdk/js-web-holons` (`HolonClient`)
- `sdk/go-holons/pkg/transport.WebBridge`

The protocol is symmetric: both sides may send requests and responses.

## Transport

- WebSocket subprotocol: `holon-rpc`
- Frame type: UTF-8 text frames containing a single JSON object
- Binary frames are invalid for this protocol

## Envelope

Allowed top-level fields:

- `jsonrpc`
- `id`
- `method`
- `params`
- `result`
- `error`

Unknown fields are invalid.

### Request

```json
{ "jsonrpc": "2.0", "id": "1", "method": "pkg.Service/Method", "params": {"x": 1} }
```

Rules:

- `jsonrpc`: required, must be `"2.0"`
- `id`: required, non-empty string
- `method`: required, non-empty string
- `params`: optional object (`{}` if omitted)
- `result`/`error`: must be absent

### Success response

```json
{ "jsonrpc": "2.0", "id": "1", "result": {"ok": true} }
```

Rules:

- `jsonrpc`: required, must be `"2.0"`
- `id`: required, non-empty string
- `result`: required
- `error`/`method`/`params`: must be absent

### Error response

```json
{ "jsonrpc": "2.0", "id": "1", "error": { "code": 12, "message": "method not registered" } }
```

Rules:

- `jsonrpc`: required, must be `"2.0"`
- `id`: required, non-empty string
- `error`: required object
- `error.code`: required integer
- `error.message`: required string
- `result`/`method`/`params`: must be absent

## ID semantics

- IDs are endpoint-generated, case-sensitive strings.
- Each endpoint must keep IDs unique among in-flight requests.
- A response must reuse the exact request ID.

Current conventions:

- Browser/client request IDs: incrementing numeric strings (`"1"`, `"2"`, ...)
- Browser heartbeat IDs: `"h<N>"`
- Go server-initiated IDs: `"s<N>"`

## Response ID classification

When receiving a response whose `id` has no active pending request:

- `unknown_response_id`: ID has never been seen
- `duplicate_response_id`: ID was already settled successfully/with error
- `stale_response_id`: ID corresponds to a request that already timed out

These responses are ignored and reported as protocol warnings.

## Error model

The protocol uses JSON-RPC + gRPC-style numeric semantics.
Common codes in this SDK:

- `-32700`: parse error
- `-32600`: invalid request / invalid response envelope
- `-32601`: method not found
- `-32602`: invalid params
- `4`: timeout / deadline exceeded
- `8`: resource exhausted (e.g. max pending reached)
- `12`: unimplemented (method not registered)
- `13`: internal error
- `14`: unavailable / connection closed

## Validation and failure policy

`HolonClient` performs strict inbound validation.

- Malformed JSON: connection is closed with protocol error
- Invalid envelope shape/types: connection is closed with protocol error
- Unknown/duplicate/stale response IDs: ignored and reported
