# tgmcp

[![npm](https://img.shields.io/npm/v/@watzon/tgmcp.svg)](https://www.npmjs.com/package/@watzon/tgmcp)
[![ci](https://img.shields.io/github/actions/workflow/status/watzon/tgmcp/ci.yml?branch=main)](https://github.com/watzon/tgmcp/actions)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP server that automates **one Telegram user account** through the Telegram user API ([mtcute](https://mtcute.dev)). It is not a bot.

The public tool list is an inbox: list chats, read, send, and search. Everything else lives in an action catalog behind `telegram` search / describe / invoke. Empty catalog search shows inbox and lookup actions only. Join, leave, and profile edits stay hidden until you search for them.

tgmcp runs on [Node.js](https://nodejs.org) 20 or newer. `npx` and `bunx` both work.

## Install

One-shot (no global install):

```bash
npx @watzon/tgmcp login
```

```bash
bunx @watzon/tgmcp login
```

Global install:

```bash
npm install -g @watzon/tgmcp
# or
bun add -g @watzon/tgmcp
```

That puts `tgmcp` on your `PATH`.

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

The process speaks MCP on stdio. Point your host at that command. Host snippets for Claude Code, Cursor, OpenClaw, and Hermes are in [agent instructions](#agent-instructions).

## Agent instructions

<details>
<summary>Read this if you are an agent installing tgmcp</summary>

You are installing tgmcp. It is an MCP server that automates one Telegram user account through the Telegram user API. It is not a bot. Do not ask for a bot token.

### Requirements

- Node.js 20 or newer on the machine that will run the server. Prefer `npx -y @watzon/tgmcp`. `bunx @watzon/tgmcp` also works.
- An `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org). The user already has these, or they get them there.

Do not clone the repo unless the user asked for a development checkout.

### Wire the host

Generic stdio, Claude Code, Cursor, and OpenClaw:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "@watzon/tgmcp"]
    }
  }
}
```

`bunx @watzon/tgmcp` is the same command if you prefer Bun.

Hermes:

```yaml
mcp_servers:
  telegram:
    command: "npx"
    args: ["-y", "@watzon/tgmcp"]
```

Default data home is `~/.tgmcp`. Set `TGMCP_HOME` in the host env only if the user wants a different directory. From a clone, `bun src/index.ts` with `cwd` set to the repo still works.

### Sign in

1. On the same machine as the server, run `npx @watzon/tgmcp login` (or `tgmcp login` if it is installed). A page binds to `127.0.0.1`. The user finishes it in a browser. Do not ask them to paste `apiHash`, the login code, or a 2FA password into chat.
2. On a remote host, start the server unsigned. Call `auth` with `command: "status"` first. Then `set_credentials`, then `send_code` / `sign_in`, or `start_qr`. Prefer `auth` `command: "browser"` if they can open or port-forward that URL.
3. Never echo `apiHash`, login codes, or 2FA passwords in tool results, logs, or later messages.

### After it is connected

- Call `auth` with `command: "status"` once per session before other tools. The tool list does not change with auth state.
- Use `list_chats` to get a numeric `chatId`. Pass that `chatId` on every chat-scoped call. Groups and channels are negative.
- Inbox tools: `list_chats`, `read_messages`, `send_message`, `search_messages`.
- Longer tail goes through `telegram` with `command` `search`, `describe`, or `invoke`. Empty search lists inbox and lookup actions only. Search `join`, `leave`, `folder`, or `profile` for account-admin actions.

Example:

```text
telegram { command: "search", query: "pin topic" }
telegram { command: "describe", name: "pin" }
telegram { command: "invoke", name: "pin", params: { chatId: "-100123", messageId: 42 } }
```

</details>

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
bun run build
node dist/cli.js help
bun run login
bun src/index.ts
```

`CONTEXT.md` has the project vocabulary and boundaries.
