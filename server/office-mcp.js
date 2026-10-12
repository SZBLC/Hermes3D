/**
 * Office team tools as a minimal MCP server (Streamable HTTP, JSON responses only).
 *
 * Hermes Agent's API server runs its own toolset and ignores tools sent by the
 * client, so the adapter's TEAM_TOOLS never reach the model. Hermes can load MCP
 * servers, though, so the adapter exposes the same team operations here and
 * Hermes is configured to connect to it:
 *
 *   mcp_servers:
 *     office:
 *       url: "http://127.0.0.1:18789/mcp"
 *       headers: { Authorization: "Bearer ${HERMES3D_MCP_TOKEN}" }
 *
 * Every Hermes session sees these tools, including the ones that run delegated
 * work, so delegation is guarded: an agent can't take a second task while busy,
 * the orchestrator can't delegate to itself, and concurrent delegations are capped.
 */

const crypto = require("crypto");

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CONCURRENT_DELEGATIONS = 4;

const TOOLS = [
  {
    name: "list_team",
    description:
      "List the office team members (the characters in the Hermes3D office) with their IDs, names, and roles.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delegate_task",
    description:
      "Give a task or question to an office team member and wait for their answer. " +
      "Use this instead of built-in subagents whenever work belongs to a team member's role.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Team member ID or name, e.g. 'Reviewer'" },
        message: { type: "string", description: "The task, question, or instructions to send" },
      },
      required: ["agent", "message"],
    },
  },
  {
    name: "read_agent_context",
    description: "Read a team member's recent conversation history to see what they have done.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Team member ID or name" },
        last_n: { type: "number", description: "Number of recent messages (1-40, default 10)" },
      },
      required: ["agent"],
    },
  },
];

const tokensMatch = (expected, header) => {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  if (!match) return false;
  const a = Buffer.from(match[1].trim());
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * @param {{
 *   token: string,
 *   orchestratorId: string,
 *   findAgent: (idOrName: string) => ({ id: string, name: string } | undefined),
 *   listTeam: () => string,
 *   delegateTask: (args: { agent_id: string, message: string }) => Promise<string>,
 *   readAgentContext: (args: { agent_id: string, last_n?: number }) => string,
 *   log?: (msg: string) => void,
 * }} deps
 */
function createOfficeMcpHandler(deps) {
  const log = deps.log || (() => {});
  const busy = new Set();

  const toolResult = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

  async function callTool(name, args) {
    if (name === "list_team") return toolResult(deps.listTeam());

    const agent = typeof args.agent === "string" ? deps.findAgent(args.agent.trim()) : undefined;
    if (!agent) {
      return toolResult(`No team member matches "${args.agent}". Call list_team to see the team.`, true);
    }

    if (name === "read_agent_context") {
      return toolResult(deps.readAgentContext({ agent_id: agent.id, last_n: args.last_n }));
    }

    if (name === "delegate_task") {
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!message) return toolResult("message is required.", true);
      if (agent.id === deps.orchestratorId) {
        return toolResult("The orchestrator can't delegate to itself.", true);
      }
      if (busy.has(agent.id)) {
        return toolResult(`${agent.name} is already working on a task. Wait for it to finish or pick someone else.`, true);
      }
      if (busy.size >= MAX_CONCURRENT_DELEGATIONS) {
        return toolResult(`Too many delegated tasks are running (${busy.size}). Wait for one to finish.`, true);
      }
      busy.add(agent.id);
      log(`delegating to ${agent.name} (${agent.id})`);
      try {
        const raw = await deps.delegateTask({ agent_id: agent.id, message });
        const parsed = JSON.parse(raw);
        return parsed.ok
          ? toolResult(`${agent.name} replied:\n\n${parsed.response}`)
          : toolResult(`${agent.name} couldn't complete the task: ${parsed.error}`, true);
      } finally {
        busy.delete(agent.id);
      }
    }

    return toolResult(`Unknown tool: ${name}`, true);
  }

  async function handleMessage(msg) {
    const isRequest = msg && typeof msg === "object" && "id" in msg && typeof msg.method === "string";
    if (!isRequest) return null; // notifications and client responses need no reply

    const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "hermes3d-office", version: "1.0.0" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = msg.params?.name;
        const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
        try {
          return reply(await callTool(name, args));
        } catch (err) {
          return reply(toolResult(`Tool failed: ${err instanceof Error ? err.message : String(err)}`, true));
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  return async function handleOfficeMcp(req, res) {
    if (!deps.token) {
      sendJson(res, 503, { error: "Office MCP is disabled (HERMES3D_MCP_TOKEN is not set)." });
      return;
    }
    if (!tokensMatch(deps.token, req.headers.authorization)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      // No server-initiated stream; clients fall back to plain POST request/response.
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const messages = Array.isArray(payload) ? payload : [payload];
    const replies = (await Promise.all(messages.map(handleMessage))).filter(Boolean);
    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, Array.isArray(payload) ? replies : replies[0]);
  };
}

module.exports = { createOfficeMcpHandler };
