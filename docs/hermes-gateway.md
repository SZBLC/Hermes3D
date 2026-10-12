# Hermes Gateway Adapter

> **Connecting to a `hermes-agent` backend?** Use the direct path instead — it
> speaks that backend's JSON-RPC gateway from inside the Studio server, so no
> adapter process runs anywhere. See
> [`hermes-agent-tailscale.md`](hermes-agent-tailscale.md). This page covers the
> older adapter path, which is still what the Hermes HTTP API integration uses.

Hermes3D runs against the Hermes HTTP API by using the bundled adapter in
[`server/hermes-gateway-adapter.js`](../server/hermes-gateway-adapter.js).

It uses the runtime seam in Studio while Hermes is exposed through a
Hermes3D-compatible WebSocket adapter.

## Architecture

```text
Browser UI <-> Studio runtime/client <-> Hermes gateway adapter <-> Hermes HTTP API
```

The frontend keeps using the Hermes3D gateway protocol. The Hermes adapter
translates that protocol into Hermes HTTP calls and streams the results
back as gateway events.

## Quick start

### 1. Start Hermes

Start your Hermes API server. The default expected endpoint is:

```text
http://localhost:8642
```

### 2. Configure environment

Copy `.env.example` to `.env` and set the Hermes values:

```env
NEXT_PUBLIC_GATEWAY_URL=ws://localhost:18789

HERMES_API_URL=http://localhost:8642
HERMES_API_KEY=
HERMES_ADAPTER_PORT=18789
HERMES_MODEL=hermes
HERMES_AGENT_NAME=Hermes
```

### 3. Start Hermes3D and the adapter

In separate terminals:

```bash
npm run hermes-adapter
npm run dev
```

Then open `http://localhost:3000` and connect to:

```text
ws://localhost:18789
```

In the connect screen, select `Hermes backend`. Hermes3D will persist that
selection in Studio settings and show `Hermes` as the active backend once
the adapter hello response is received.

### 4. Remote Hermes on another machine

The adapter and Hermes3D do not have to run where Hermes runs. Pick whichever
side of the link you would rather keep private.

**Adapter next to Hermes3D.** Only the Hermes HTTP API crosses the network, and
nothing extra runs on the Hermes host:

```text
Browser <-> Studio <-> adapter (localhost:18789) <-> Hermes HTTP API (remote:8642)
```

Bind the Hermes API to the tailnet on the Hermes host, then on the Hermes3D
machine set `HERMES_API_URL` to the remote address and connect to
`ws://localhost:18789`.

**Adapter next to Hermes.** The gateway protocol crosses the network, so the
adapter needs to be published. Keep it on loopback and expose it with Tailscale
Serve, then connect to `wss://<tailnet-host>` with no port. Full walkthrough in
[`TUTORIAL.md`](../TUTORIAL.md).

With this adapter, do not point the gateway URL at port `9119`. That is the
hermes-agent dashboard's JSON-RPC endpoint, not a Hermes3D gateway, and the two
protocols are not compatible. See the troubleshooting section of the tutorial.

To talk to that JSON-RPC endpoint on purpose, switch the backend to
**Hermes Agent (direct)** and follow
[`hermes-agent-tailscale.md`](hermes-agent-tailscale.md). Note that a dashboard
bound to a public address is gated and rejects token auth, so that guide binds
the backend to loopback and tunnels it.

### 5. Optional all-in-one local startup

The repo also includes:

```bash
bash scripts/hermes3d-start.sh
```

That script now resolves the repo root dynamically from the script
location instead of assuming a machine-specific checkout path.

## What this adapter supports

The adapter currently supports the Hermes3D surfaces needed for normal
office use:

- Agent listing, creation, update, and deletion
- Session listing, preview, patch, reset, and history lookup
- Chat send, targeted abort, and run wait
- Config get/set/patch shims needed by the Studio UI
- Models and skills status
- Exec approvals surfaces used by the current UI
- Cron list/add/remove/patch/run
- Multi-agent orchestration tools on the Hermes side

## Hermes orchestration tools

The main Hermes agent acts as an orchestrator with these tools:

| Tool | Description |
|---|---|
| `spawn_agent` | Create a specialist sub-agent |
| `delegate_task` | Send work to a specific agent |
| `list_team` | List active agents, names, and roles |
| `configure_agent` | Update agent name, role, instructions, or settings |
| `dismiss_agent` | Remove an agent from the team |
| `read_agent_context` | Read another agent's recent conversation history for coordination |

Sub-agents appear in the office as separate characters and keep their
own conversation state. Each agent's files (`IDENTITY.md`, `SOUL.md`,
`AGENTS.md`, `TOOLS.md`, `USER.md`, `HEARTBEAT.md`, `MEMORY.md`), such as
the ones the company builder writes, are appended to its system prompt.

### Using the team tools with Hermes Agent

Hermes Agent's API server runs its own toolset and ignores tools sent by
the client, so the tools above never reach the model through
`/v1/chat/completions`. The adapter also serves the team tools
(`list_team`, `delegate_task`, `read_agent_context`) as an MCP endpoint
at `/mcp` on the adapter port. Point Hermes at it:

1. Add a shared token to `~/.hermes/.env` and pass the same value to the
   adapter as `HERMES3D_MCP_TOKEN`:

   ```bash
   echo "HERMES3D_MCP_TOKEN=$(openssl rand -hex 32)" >> ~/.hermes/.env
   ```

2. Add the server to `~/.hermes/config.yaml`:

   ```yaml
   mcp_servers:
     office:
       url: "http://127.0.0.1:18789/mcp"
       headers:
         Authorization: "Bearer ${HERMES3D_MCP_TOKEN}"
       timeout: 900
   ```

3. Start the adapter before `hermes gateway`, so the endpoint is up when
   Hermes connects. `hermes mcp test office` should list three tools.

Hermes then sees `mcp_office_list_team`, `mcp_office_delegate_task`, and
`mcp_office_read_agent_context`, and delegated work runs as the office
agent (its prompt, history, and character in the office). Delegation is
guarded: a busy agent can't take a second task, the orchestrator can't
delegate to itself, and at most four delegations run at once.

### Command modes and approvals

Each agent's command mode from Studio (off / ask / auto) is applied to
Hermes' `approval.request` events for that agent's runs:

| Mode | Risky command flagged by Hermes |
|---|---|
| `auto` | Approved immediately |
| `ask` | Shown in the office approvals panel (Allow once / Allow this session / Deny) |
| `off` | Denied; the agent is also told not to run commands or change files |

Hermes only routes flagged commands to the client in `manual` approval
mode. In its default `smart` mode its own guardian approves low-risk
flagged commands before the adapter sees them, so set:

```bash
hermes config set approvals.mode manual
```

Routine commands that Hermes does not flag run without an approval in
every mode, and Hermes can't limit tools per request, so `off` relies on
the agent's instructions plus denial of anything flagged. Unanswered
approvals are denied after Hermes' `approvals.timeout` (300s by default).

## Production-readiness notes

The adapter behavior worth knowing about:

- `chat.abort` aborts only the requested `runId` or `sessionKey`
  instead of cancelling every active run
- history clears from `sessions.reset`, `agents.delete`, and
  `dismiss_agent` persist to disk immediately
- `scripts/hermes3d-start.sh` resolves the repo root dynamically instead of
  hardcoding one developer's local path

## ACP status

Hermes has a real ACP surface and that remains the preferred long-term
integration direction.

The adapter has not been replaced with ACP yet. The current path uses the
adapter because it works with the existing Hermes3D gateway contract today.

The runtime seam added in Studio is what makes an ACP-backed Hermes
provider feasible as a follow-up without reworking the whole UI again.

## Persistence

Conversation history is stored at:

```text
~/.hermes/hermes3d-history.json
```

It is loaded on startup and updated when conversations change.

Created agents, their files, and their command modes are stored at
`~/.hermes/hermes3d-agents.json`, so they survive adapter restarts.

## Current limitations

- Hermes is integrated through the adapter path today, not yet through a
  dedicated native Studio provider implementation
- Config and approvals behavior still matches the current adapter contract,
  not a fully Hermes-native settings model
- This path is intended to get Hermes working reliably now while the
  broader runtime-provider architecture continues to mature

## When to use demo mode instead

If you only want to see the office boot without installing Hermes, use:

```bash
npm run demo-gateway
npm run dev
```

That starts a bundled mock gateway for a no-framework Hermes3D demo. Both
adapters default to port `18789`, so run only one of them at a time.
