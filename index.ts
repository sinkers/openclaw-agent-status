/**
 * agent-status — OpenClaw plugin
 *
 * Registers GET /v1/agents/status on the OpenClaw gateway.
 * Returns live status for all configured agents: last activity time, status
 * classification, and a snippet of what they were last doing.
 *
 * Endpoints:
 *   GET /v1/agents/status             — all agents
 *   GET /v1/agents/status/:agentId    — single agent (404 if not found)
 *
 * Response shape:
 *   { "object": "list", "data": [{ "id": "...", "name": "...", "status": "active|idle|stale", ... }] }
 *
 * Status thresholds (configurable via openclaw.json plugin config):
 *   activeThresholdSeconds  — default 300   (5 min)
 *   idleThresholdSeconds    — default 1800  (30 min)
 */

import type { IncomingMessage, ServerResponse } from "http";
import { readFile, open } from "fs/promises";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentConfig {
  id: string;
  name?: string;
  identity?: { name?: string };
}

interface SessionEntry {
  sessionId?: string;
  updatedAt?: number;
  sessionFile?: string;
}

interface SessionStore {
  [sessionKey: string]: SessionEntry;
}

interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

interface AgentStatusEntry {
  id: string;
  name: string;
  status: "active" | "idle" | "stale";
  last_active: string | null;
  last_active_ago_seconds: number | null;
  current_task: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getAgentDisplayName(agent: AgentConfig): string {
  // Priority: identity.name > capitalize(name) > capitalize(id)
  return (
    agent.identity?.name ??
    (agent.name ? capitalize(agent.name) : capitalize(agent.id))
  );
}

/**
 * Read the last `maxBytes` of a file efficiently using a seek + read.
 * Returns the content as a string. Safe to call on missing/empty files.
 */
async function readFileTail(filePath: string, maxBytes = 16384): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(filePath, "r");
    const stat = await fh.stat();
    const fileSize = stat.size;
    if (fileSize === 0) return "";

    const readBytes = Math.min(maxBytes, fileSize);
    const offset = fileSize - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    await fh.read(buf, 0, readBytes, offset);
    return buf.toString("utf8");
  } catch (err) {
    // File missing or unreadable — treat as empty
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.debug("[agent-status] readFileTail error:", (err as Error).message);
    }
    return "";
  } finally {
    await fh?.close().catch(() => { /* ignore close errors */ });
  }
}

/**
 * Scan a JSONL transcript tail and return the last assistant text message
 * (truncated to 100 chars), or null if none found.
 */
async function getLastAssistantText(sessionFile: string): Promise<string | null> {
  const tail = await readFileTail(sessionFile, 16384);
  if (!tail) return null;

  // Split into lines — first line may be partial; skip it
  const lines = tail.split("\n");
  const safeLines = tail.startsWith("{") ? lines : lines.slice(1);

  for (let i = safeLines.length - 1; i >= 0; i--) {
    const line = safeLines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      if (entry.type !== "message") continue;
      if (entry.message?.role !== "assistant") continue;

      const content = entry.message.content;
      if (!Array.isArray(content)) continue;

      const textBlock = content.find((c) => c.type === "text" && c.text);
      if (!textBlock?.text) continue;

      const text = textBlock.text.trim();
      if (!text) continue;

      return text.length > 100 ? text.slice(0, 100) + "…" : text;
    } catch {
      // Malformed line — skip
    }
  }

  return null;
}

/**
 * Read the agent's session store and return the most recently active session.
 */
async function getMostRecentSession(
  stateDir: string,
  agentId: string
): Promise<{ updatedAt: number; sessionFile: string | undefined } | null> {
  const sessionsPath = join(stateDir, "agents", agentId, "sessions", "sessions.json");

  let store: SessionStore;
  try {
    const raw = await readFile(sessionsPath, "utf8");
    store = JSON.parse(raw) as SessionStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.debug("[agent-status] sessions.json read error for", agentId, ":", (err as Error).message);
    }
    return null;
  }

  let bestUpdatedAt = 0;
  let bestSessionFile: string | undefined;

  for (const entry of Object.values(store)) {
    if (typeof entry.updatedAt === "number" && entry.updatedAt > bestUpdatedAt) {
      bestUpdatedAt = entry.updatedAt;
      bestSessionFile = entry.sessionFile;
    }
  }

  return bestUpdatedAt > 0
    ? { updatedAt: bestUpdatedAt, sessionFile: bestSessionFile }
    : null;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default function register(api: any) {
  // Configurable thresholds (seconds)
  const activeThresholdSeconds: number =
    api.pluginConfig?.activeThresholdSeconds ?? 300;   // 5 min
  const idleThresholdSeconds: number =
    api.pluginConfig?.idleThresholdSeconds ?? 1800;    // 30 min

  function computeStatus(
    updatedAtMs: number,
    nowMs: number
  ): "active" | "idle" | "stale" {
    const agoSeconds = (nowMs - updatedAtMs) / 1000;
    if (agoSeconds < activeThresholdSeconds) return "active";
    if (agoSeconds < idleThresholdSeconds) return "idle";
    return "stale";
  }

  async function buildAgentStatus(agent: AgentConfig, stateDir: string): Promise<AgentStatusEntry> {
    const now = Date.now();
    const session = await getMostRecentSession(stateDir, agent.id);

    if (!session) {
      return {
        id: agent.id,
        name: getAgentDisplayName(agent),
        status: "stale",
        last_active: null,
        last_active_ago_seconds: null,
        current_task: null,
      };
    }

    const agoSeconds = Math.floor((now - session.updatedAt) / 1000);
    const status = computeStatus(session.updatedAt, now);
    const current_task = session.sessionFile
      ? await getLastAssistantText(session.sessionFile)
      : null;

    return {
      id: agent.id,
      name: getAgentDisplayName(agent),
      status,
      last_active: new Date(session.updatedAt).toISOString(),
      last_active_ago_seconds: agoSeconds,
      current_task,
    };
  }

  api.registerHttpRoute({
    path: "/v1/agents/status",
    auth: "gateway",
    match: "prefix",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // Only handle GET
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: { message: "Method not allowed", type: "invalid_request_error" },
          })
        );
        return true;
      }

      const cfg = api.config;
      const agentList: AgentConfig[] = cfg?.agents?.list ?? [{ id: "main" }];
      const stateDir: string = api.runtime.state.resolveStateDir();

      // Determine if this is a single-agent or list request
      // /v1/agents/status        → list
      // /v1/agents/status/       → list
      // /v1/agents/status/elysse → single agent
      const reqPath = (req.url ?? "").split("?")[0]; // strip query string
      const basePath = "/v1/agents/status";
      const suffix = reqPath
        .slice(basePath.length)   // everything after the base
        .replace(/^\/+/, "")      // strip leading slashes
        .replace(/\/+$/, "");     // strip trailing slashes

      if (suffix) {
        // ── Single agent endpoint ──
        const agentId = suffix;
        const agent = agentList.find((a) => a.id === agentId);

        if (!agent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                message: `Agent '${agentId}' not found`,
                type: "not_found_error",
              },
            })
          );
          return true;
        }

        const data = await buildAgentStatus(agent, stateDir);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
        return true;
      }

      // ── All agents endpoint ──
      const data = await Promise.all(
        agentList.map((agent) => buildAgentStatus(agent, stateDir))
      );
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data }));
      return true;
    },
  });
}
