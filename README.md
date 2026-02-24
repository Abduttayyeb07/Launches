# MDF Launch Tracker

TypeScript/Node.js service that tracks MemesDotFun (MDF) token launches over Zig RPC WebSocket and sends Telegram alerts.

## Important

Launch alerts are emitted from `create_denom` / `MsgCreateDenom` events.

## Install

```bash
npm install
```

## Run

```bash
npm run dev
npm run build
npm start
```

## Configuration

Copy `.env.example` to `.env` and set values.

| Variable | Required | Description |
| --- | --- | --- |
| `RPC_WS` | Yes | Zig RPC WebSocket URL |
| `MDF_CONTRACT` | Yes | MDF contract address |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `MDF_TOKEN_API_BASE` | No | Optional metadata enrichment base URL |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` |
| `DATA_DIR` | No | Directory for persistent `subscribers.json` |

## Output format

```text
[MDF LAUNCH] symbol=<...> name=<...> denom=<...> creator=<...> image=<...> source=create_denom
```

## Graceful shutdown

Send `SIGINT` or `SIGTERM`.

