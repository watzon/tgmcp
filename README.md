# tgmcp

[![npm](https://img.shields.io/npm/v/tgmcp.svg)](https://www.npmjs.com/package/tgmcp)
[![ci](https://img.shields.io/github/actions/workflow/status/watzon/tgmcp/ci.yml?branch=main)](https://github.com/watzon/tgmcp/actions)
[![bun](https://img.shields.io/badge/bun-%3E%3D1.2-f472b6)](https://bun.sh)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP server that automates **one Telegram user account** through the Telegram user API ([mtcute](https://mtcute.dev)). It is not a bot.

The public tool list is an inbox: list chats, read, send, and search. Everything else lives in an action catalog behind `telegram` search / describe / invoke. Empty catalog search shows inbox and lookup actions only. Join, leave, and profile edits stay hidden until you search for them.

tgmcp needs [Bun](https://bun.sh). `npx` works if Bun is on your `PATH`. `bunx` is the direct path.

## Install

One-shot (no global install):

```bash
bunx tgmcp login
```

```bash
npx tgmcp login
```

Global install:

```bash
bun add -g tgmcp
# or
npm install -g tgmcp
```

From a clone:

```bash
git clone https://github.com/watzon/tgmcp.git
cd tgmcp
bun install
bun run login
```

## Sign in

1. Create an application at [my.telegram.org](https://my.telegram.org) and copy `api_id` / `api_hash`.
2. Run `tgmcp login` (or `bun run login` in a clone).
3. Finish the page that opens on `127.0.0.1`. The hash, login code, and 2FA stay in the browser. They never enter the model.

Both login paths write `storage/credentials.json` (api id, hash, owner id) and the mtcute session under the [data home](#data-home).

> [!TIP]
> Local browser login is the one you want. On a remote host, start the MCP server unsigned and use the `auth` tool: `set_credentials`, then `send_code` / `sign_in`, or `start_qr`. You can also call `auth` with `browser` and open that URL on the machine that runs tgmcp (SSH port-forward if you are not on that host).

Optional: put `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in `.env` in the data home. Env values override the credentials file.

Check the session with `tgmcp status`.

## Run the MCP server

```bash
tgmcp
# same thing:
tgmcp serve
```

The process speaks MCP on stdio. Point your host at that command.

### Claude Code / Cursor / other stdio hosts

```json
{
  "mcpServers": {
    "telegram": {
      "command": "bunx",
      "args": ["tgmcp"]
    }
  }
}
```

`npx -y tgmcp` works the same way if Bun is installed.

### OpenClaw

```json
{
  "mcpServers": {
    "telegram": {
      "command": "bunx",
      "args": ["tgmcp"]
    }
  }
}
```

### Hermes

```yaml
mcp_servers:
  telegram:
    command: "bunx"
    args: ["tgmcp"]
```

To pin a data directory, set `TGMCP_HOME` in the host env. From a clone, you can still run `bun src/index.ts` with `cwd` set to the repo.

## Tools

| Tool | Role |
| --- | --- |
| `list_chats` | Resolve a title to a numeric `chatId` |
| `read_messages` | Recent history. Does not mark read |
| `send_message` | Send or reply in a chat |
| `search_messages` | Find messages inside one chat |
| `telegram` | Catalog knife: `search`, `describe`, `invoke` |
| `auth` | Sign-in. Prefer `browser` locally. Use `set_credentials` + phone/QR on a remote host. |

Chat-scoped work needs an explicit numeric `chatId`. Use `list_chats` first.

Example catalog flow:

```text
telegram { command: "search", query: "pin topic" }
telegram { command: "describe", name: "pin" }
telegram { command: "invoke", name: "pin", params: { chatId: "-100123", messageId: 42 } }
```

Empty `telegram` search lists inbox and lookup actions (react, edit, pin, media, user info, topics). Search for `join`, `leave`, `folder`, or `profile` when you need those.

## Data home

Published runs store state in `~/.tgmcp` unless you say otherwise:

| Path | What |
| --- | --- |
| `tgmcp.config.json` | Denylist, rate limits, relative paths |
| `storage/credentials.json` | api id, hash, owner id (mode 0600) |
| `storage/session` | mtcute SQLite session |
| `data/tgmcp.db` | Append-only action ledger |
| `data/downloads/` | Saved media |

Resolution order:

1. `TGMCP_HOME` if set
2. The current directory, if it already has `tgmcp.config.json` (this is how a clone works)
3. `~/.tgmcp`, created on first run

Copy `.env.example` to `.env` in that directory if you want env overrides.

## Config

`tgmcp.config.json` looks like this:

```json
{
  "ownerId": "",
  "telegram": {
    "sessionPath": "storage/session",
    "credentialsPath": "storage/credentials.json"
  },
  "ledgerPath": "data/tgmcp.db",
  "downloadsDir": "data/downloads",
  "denylist": [],
  "rateLimits": {
    "perChatMs": 2000,
    "globalPerHour": 120
  }
}
```

`ownerId` is filled in after the first login. If you set it yourself, tgmcp refuses to start as a different account.

## Safety

- Mutations go through a denylist, per-chat spacing, a global hourly cap, one flood-wait retry, and an append-only ledger.
- Secrets stay on disk or in `.env`. The MCP transport is stdio, so logs go to stderr only.
- This process does not run an agent loop and does not ingest incoming chats on its own.
- Treat `storage/session` like a logged-in browser profile. Do not commit it.

## Development

```bash
bun install
bun test
bun run typecheck
bun run login
bun src/index.ts
```

`CONTEXT.md` has the project vocabulary and boundaries.
