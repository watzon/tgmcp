# tgmcp

An MCP server that automates one Telegram **user account** through the Telegram **user API**. It is not a Telegram bot. Agents such as OpenClaw or Hermes call a small public tool list. The rest of the Telegram surface lives in an **action catalog** behind search, describe, and invoke.

## Ubiquitous language

| Term | Meaning |
| --- | --- |
| Account | The authenticated Telegram user whose session this process holds. |
| Session | mtcute SQLite authorization file. Separate from the ledger and from the credentials file. |
| Hot-path tool | A first-class MCP tool always visible to the host: `list_chats`, `read_messages`, `send_message`, `search_messages`. Inbox and lookup only. |
| Knife | The `telegram` MCP tool. Commands: `search`, `describe`, `invoke`. |
| Catalog / action | One curated Telegram capability stored as data inside the knife. Not an MCP tool-list entry. |
| Guard | Rate-limit, denylist, flood-wait, and ledger wrapper around every mutating Telegram call. |
| Ledger | Append-only audit of guarded actions. |
| Denylist | Hard block on chats. The process must never send or mutate those chats. |
| chatId | Numeric marked Telegram peer id as a string. Groups and channels are negative. Required for chat-scoped work. |
| Credentials file | JSON file with `apiId`, `apiHash`, and `ownerId`. Default `storage/credentials.json`. Mode 0600. |
| Browser login | Local 127.0.0.1 page. Preferred on the machine that runs tgmcp. Secrets stay out of the model. |
| Agent login | MCP `auth` tool: `set_credentials`, `send_code` / `sign_in`, or `start_qr`. For remote hosts. |
| Home | Directory that holds config, session, credentials, ledger, and downloads. `TGMCP_HOME` if set, else a cwd that already has `tgmcp.config.json`, else `~/.tgmcp`. |

## Boundaries

- Route Telegram work through the hot-path tools or the knife. Do not expose raw mtcute to the host.
- Mutations go through `TelegramActions.guard`.
- Secrets stay in environment and config. They must not appear in tool results or stdout.
- Stdio is the MCP transport. Log only to stderr.
- This process does not run an agent loop, memory, workspace, or inbound prefix ingest.
- The public tool list is an inbox, not an autonomous account manager. Join, leave, profile edits, folders, and invites stay in the catalog behind a search query.
- Prefer browser login on a local machine. Use the agent `auth` tool only when the host is remote. Never put `apiHash`, login codes, or 2FA passwords in tool results or logs.
- Published installs write state under the home directory. A clone with `tgmcp.config.json` in cwd keeps using that directory.
- Runtime is Node.js. Do not import `bun:*` modules or the `Bun` global in shipped code. Tests may use `bun:test`.
- The public tool list is static. Do not hide tools based on auth state. Hosts often cache the list at connect and ignore `tools/list_changed`. Call `auth` (command `status`) once per session before other tools. Unsigned inbox calls must tell the host to use the `auth` tool to authenticate.

## Runtime flow

```text
MCP host (OpenClaw / Hermes)
  -> stdio tools/call
  -> hot-path tool or telegram knife
  -> catalog action (search / describe / invoke)
  -> guarded mtcute call
  -> ToolResult as MCP content
```
