"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentState } from "@/features/agents/state/store";
import {
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  resolveExecApprovalAgentId,
} from "@/features/agents/approvals/execApprovalEvents";
import type { ExecApprovalDecision } from "@/features/agents/approvals/types";
import type { GatewayClient, GatewayStatus } from "@/lib/gateway/GatewayClient";

type OfficeApproval = {
  id: string;
  agentId: string | null;
  command: string;
  expiresAtMs: number;
  resolving: boolean;
  error: string | null;
};

const DECISIONS: Array<{ decision: ExecApprovalDecision; label: string; className: string }> = [
  { decision: "allow-once", label: "Allow once", className: "border-emerald-500/60 text-emerald-200 hover:bg-emerald-900/40" },
  { decision: "allow-always", label: "Allow this session", className: "border-amber-500/50 text-amber-100 hover:bg-amber-900/40" },
  { decision: "deny", label: "Deny", className: "border-red-500/60 text-red-200 hover:bg-red-900/40" },
];

/**
 * Pending command approvals from the runtime, shown over the office. The Agents page has its own
 * approval cards; the office had none, so an agent set to "ask" would wait with nothing to answer.
 */
export function OfficeApprovalsPanel({
  client,
  status,
  agents,
}: {
  client: GatewayClient;
  status: GatewayStatus;
  agents: AgentState[];
}) {
  const [approvals, setApprovals] = useState<OfficeApproval[]>([]);
  const agentsRef = useRef(agents);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    if (status !== "connected") return;
    return client.onEvent((event) => {
      const requested = parseExecApprovalRequested(event);
      if (requested) {
        const agentId = resolveExecApprovalAgentId({ requested, agents: agentsRef.current });
        const next: OfficeApproval = {
          id: requested.id,
          agentId,
          command: requested.request.command,
          expiresAtMs: requested.expiresAtMs,
          resolving: false,
          error: null,
        };
        setApprovals((current) => [next, ...current.filter((entry) => entry.id !== requested.id)]);
        return;
      }
      const resolved = parseExecApprovalResolved(event);
      if (resolved) {
        setApprovals((current) => current.filter((entry) => entry.id !== resolved.id));
      }
    });
  }, [client, status]);

  // Expired requests have already been denied by the runtime.
  useEffect(() => {
    if (approvals.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setApprovals((current) => current.filter((entry) => entry.expiresAtMs > now));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [approvals.length]);

  const resolve = async (id: string, decision: ExecApprovalDecision) => {
    setApprovals((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, resolving: true, error: null } : entry)),
    );
    try {
      await client.call("exec.approval.resolve", { id, decision });
      setApprovals((current) => current.filter((entry) => entry.id !== id));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not send the decision.";
      setApprovals((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, resolving: false, error: message } : entry)),
      );
    }
  };

  if (approvals.length === 0) return null;

  const nameFor = (agentId: string | null) =>
    agents.find((agent) => agent.agentId === agentId)?.name ?? agentId ?? "An agent";

  return (
    <div
      className="pointer-events-auto absolute right-4 top-16 z-40 flex w-[380px] max-w-[calc(100%-2rem)] flex-col gap-2"
      role="region"
      aria-label="Command approvals"
    >
      {approvals.map((approval) => (
        <div
          key={approval.id}
          className="rounded-lg border border-amber-600/60 bg-[#1a1008]/95 p-3 shadow-2xl"
        >
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-amber-300">
            Approval needed · {nameFor(approval.agentId)}
          </div>
          <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[12px] text-amber-50">
            {approval.command}
          </pre>
          {approval.error ? (
            <div className="mt-2 text-[12px] text-red-300">{approval.error}</div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {DECISIONS.map(({ decision, label, className }) => (
              <button
                key={decision}
                type="button"
                disabled={approval.resolving}
                onClick={() => void resolve(approval.id, decision)}
                className={`rounded-md border bg-black/30 px-2.5 py-1 font-mono text-[12px] transition disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
