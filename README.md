# MDF Launch Tracker

A production-grade TypeScript/Node.js service that tracks **MemesDotFun (MDF)** and **Oroswap** token launches via the Zig RPC WebSocket.

---

> [!IMPORTANT]
> **Launch alert trigger is `denom_metadata_updated`, NOT raw `create_denom`.**
>
> The `create_denom` subscription is used for awareness only. A `[MDF LAUNCH]` line is emitted **exclusively** when a `denom_metadata_updated` event containing valid `denom_metadata` is received.

---

## Install

```bash
npm install
```

## Run

```bash
# Development (auto-restart on file changes)
npm run dev

# Production build
npm run build
npm start
```

## Configuration

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

| Variable             | Required | Description                                              |
| -------------------- | -------- | -------------------------------------------------------- |
| `RPC_WS`             | ✅       | Zig RPC WebSocket URL                                    |
| `MDF_CONTRACT`       | ✅       | MDF contract address on Zig chain                        |
| `MDF_TOKEN_API_BASE` | ❌       | Optional enrichment API base URL                         |
| `LOG_LEVEL`          | ❌       | `debug` \| `info` \| `warn` \| `error` (default: `info`) |

---

## Output Format

Each confirmed launch prints exactly one line:

```
[MDF LAUNCH] symbol=<...> name=<...> denom=<...> creator=<...> image=<...> source=denom_metadata_updated
```

---

## Architecture

```
WebSocket (Zig RPC)
    │
    ├── Subscription 1: create_denom (awareness only — no alert emitted)
    │
    └── Subscription 2: denom_metadata_updated
            │
            ├── Parse event (dict shape OR list shape)
            ├── Extract: symbol, name, denom, creator, imageUri
            ├── Deduplication (60s cooldown per denom)
            ├── Optional API enrichment (if MDF_TOKEN_API_BASE set)
            └── Emit: [MDF LAUNCH] ...
```

### Reconnect Strategy

Exponential backoff on disconnect: `1s → 2s → 4s → 8s → 16s → 30s (max)`.  
Resubscribes to both events after every reconnect.

---

## Trenches REST API Reference

The Trenches section of the bot fetches data from:

```
https://dev-api.degenter.io
```

### Endpoint

```
GET https://dev-api.degenter.io/trenches/latest
```

### Headers

```
Content-Type: application/json
Accept: application/json
Authorization: Bearer <API_KEY>   # if required
```

### Query Parameters

| Parameter | Type   | Description                |
| --------- | ------ | -------------------------- |
| `limit`   | number | Top N latest tokens        |
| `offset`  | number | Optional pagination offset |

### Example Request

```bash
curl -X GET "https://dev-api.degenter.io/trenches/latest?limit=10" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json"
```

### Response Fields

| Field       | Type     | Description               |
| ----------- | -------- | ------------------------- |
| `symbol`    | string   | Token ticker symbol       |
| `denom`     | string   | On-chain denom identifier |
| `name`      | string   | Token full name           |
| `createdAt` | ISO 8601 | Creation timestamp        |
| `price`     | number   | Current price             |
| `marketCap` | number   | Market capitalization     |
| `holders`   | number   | Number of holders         |
| `volume24h` | number   | 24-hour trading volume    |

Tokens are sorted by `createdAt DESC` (newest first).

### Example Response

```json
{
  "data": [
    {
      "symbol": "ORO",
      "denom": "factory/zig1.../oro",
      "name": "Oroswap Token",
      "createdAt": "2026-02-17T12:41:22.000Z",
      "price": 0.0021,
      "marketCap": 210000,
      "holders": 1342,
      "volume24h": 52000
    }
  ],
  "meta": {
    "limit": 10
  }
}
```

### Failure Handling

- Retry once on failure (short delay)
- If still fails → return empty list + show fallback message
- Never crash the bot
- Log errors safely

---

## Graceful Shutdown

Send `SIGINT` (Ctrl+C) or `SIGTERM` to shut down cleanly:

```
[WS] Received SIGINT. Shutting down gracefully...
[WS] Shutdown complete.
```
