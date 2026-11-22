import { DurableObject } from "cloudflare:workers";
import type {
  AgentEventType,
  AgentRequest,
  EventMeta,
  ObservatoryEventInput,
  ObservatoryEventSummary,
  RequestKind,
  RequestPriority,
  RequestStatus,
} from "../shared/types";

const MAX_LIVE_EVENTS = 2000;
const MAX_OPEN_REQUESTS_PER_AGENT = 8;

type LiveEventRow = {
  seq: number;
  event_id: string;
  agent: string;
  run_id: string | null;
  parent_id: string | null;
  type: AgentEventType;
  ts: number;
  summary: string;
  meta_json: string | null;
};

type AgentRequestRow = {
  id: number;
  agent: string;
  kind: RequestKind;
  title: string;
  reason: string;
  requested_tool: string | null;
  priority: RequestPriority;
  status: RequestStatus;
  owner_note: string;
  created_at: string;
  updated_at: string;
};

function mapEventRow(row: LiveEventRow): ObservatoryEventSummary {
  let meta: EventMeta | null = null;
  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json) as EventMeta;
    } catch {
      meta = null;
    }
  }
  return {
    seq: row.seq,
    eventId: row.event_id,
    agent: row.agent,
    runId: row.run_id,
    parentId: row.parent_id,
    type: row.type,
    ts: row.ts,
    summary: row.summary,
    meta,
  };
}

function mapRequestRow(row: AgentRequestRow): AgentRequest {
  return {
    id: row.id,
    agent: row.agent,
    kind: row.kind,
    title: row.title,
    reason: row.reason,
    requestedTool: row.requested_tool,
    priority: row.priority,
    status: row.status,
    ownerNote: row.owner_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Aggregated live event stream & owner request queue for BLUE//SIGNAL agents.
 * Uses Cloudflare WebSocket Hibernation to push compact event summaries and
 * request updates to connected owner dashboards with sequence-based replay.
 */
export class Observatory extends DurableObject<Record<string, unknown>> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.initSchema();
  }

  private initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS live_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        agent TEXT NOT NULL,
        run_id TEXT,
        parent_id TEXT,
        type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        summary TEXT NOT NULL,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_live_events_agent_seq ON live_events(agent, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_live_events_type_seq ON live_events(type, seq DESC);

      CREATE TABLE IF NOT EXISTS agent_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('feature', 'tool_access')),
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_tool TEXT,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'approved', 'implemented', 'rejected')),
        owner_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_requests_agent ON agent_requests(agent, id DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_requests_status ON agent_requests(status, id DESC);
    `);
  }

  private broadcast(payload: unknown) {
    const frame = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        try {
          ws.close(1011, "send failed");
        } catch {
          // ignore
        }
      }
    }
  }

  private getLatestSeq(): number {
    return (
      this.sql
        .exec<{ latest: number | null }>(`SELECT MAX(seq) AS latest FROM live_events`)
        .toArray()[0]?.latest ?? 0
    );
  }

  private getOpenRequestCount(): number {
    return (
      this.sql
        .exec<{ c: number }>(
          `SELECT COUNT(*) AS c FROM agent_requests WHERE status = 'open'`,
        )
        .toArray()[0]?.c ?? 0
    );
  }

  // ——— Live event stream ———

  async recordEvent(
    input: ObservatoryEventInput,
  ): Promise<ObservatoryEventSummary> {
    const existing = this.sql
      .exec<LiveEventRow>(
        `SELECT seq, event_id, agent, run_id, parent_id, type, ts, summary, meta_json
         FROM live_events WHERE event_id = ?`,
        input.eventId,
      )
      .toArray()[0];

    if (existing) {
      return mapEventRow(existing);
    }

    const metaJson =
      input.meta && Object.keys(input.meta).length > 0
        ? JSON.stringify(input.meta)
        : null;

    this.sql.exec(
      `INSERT INTO live_events (event_id, agent, run_id, parent_id, type, ts, summary, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.eventId,
      input.agent.toLowerCase(),
      input.runId,
      input.parentId,
      input.type,
      input.ts,
      input.summary.slice(0, 300),
      metaJson,
    );

    const row = this.sql
      .exec<LiveEventRow>(
        `SELECT seq, event_id, agent, run_id, parent_id, type, ts, summary, meta_json
         FROM live_events WHERE event_id = ?`,
        input.eventId,
      )
      .one();

    if (row.seq % 50 === 0) {
      this.sql.exec(
        `DELETE FROM live_events
         WHERE seq <= (SELECT MAX(seq) - ? FROM live_events)`,
        MAX_LIVE_EVENTS,
      );
    }

    const summary = mapEventRow(row);
    this.broadcast({ type: "event", event: summary });
    return summary;
  }

  async listEvents(opts?: {
    sinceSeq?: number;
    agent?: string;
    type?: string;
    runId?: string;
    limit?: number;
  }): Promise<{ events: ObservatoryEventSummary[]; latestSeq: number }> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 120, 300));
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (typeof opts?.sinceSeq === "number" && Number.isInteger(opts.sinceSeq)) {
      clauses.push(`seq > ?`);
      params.push(opts.sinceSeq);
    }
    if (opts?.agent && opts.agent.trim()) {
      clauses.push(`agent = ?`);
      params.push(opts.agent.trim().toLowerCase());
    }
    if (opts?.type && opts.type.trim()) {
      clauses.push(`type = ?`);
      params.push(opts.type.trim());
    }
    if (opts?.runId && opts.runId.trim()) {
      clauses.push(`run_id = ?`);
      params.push(opts.runId.trim());
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const latestSeq = this.getLatestSeq();

    if (typeof opts?.sinceSeq === "number" && Number.isInteger(opts.sinceSeq)) {
      const rows = this.sql
        .exec<LiveEventRow>(
          `SELECT seq, event_id, agent, run_id, parent_id, type, ts, summary, meta_json
           FROM live_events ${where}
           ORDER BY seq ASC
           LIMIT ?`,
          ...params,
          limit,
        )
        .toArray();
      return { events: rows.map(mapEventRow), latestSeq };
    }

    const rows = this.sql
      .exec<LiveEventRow>(
        `SELECT seq, event_id, agent, run_id, parent_id, type, ts, summary, meta_json
         FROM live_events ${where}
         ORDER BY seq DESC
         LIMIT ?`,
        ...params,
        limit,
      )
      .toArray()
      .reverse();

    return { events: rows.map(mapEventRow), latestSeq };
  }

  // ——— Agent feature & tool-access requests ———

  async submitRequest(input: {
    agent: string;
    kind: RequestKind;
    title: string;
    reason: string;
    requestedTool?: string | null;
    priority?: RequestPriority;
  }): Promise<
    | { ok: true; request: AgentRequest; deduplicated: boolean }
    | { ok: false; error: string }
  > {
    const agent = input.agent.trim().toLowerCase();
    const kind: RequestKind =
      input.kind === "tool_access" ? "tool_access" : "feature";
    const title = input.title.trim().slice(0, 120);
    const reason = input.reason.trim().slice(0, 600);
    const priority: RequestPriority =
      input.priority === "low" || input.priority === "high"
        ? input.priority
        : "normal";
    const requestedTool =
      typeof input.requestedTool === "string" && input.requestedTool.trim()
        ? input.requestedTool.trim().toLowerCase().slice(0, 64)
        : null;

    if (!title || !reason) {
      return { ok: false, error: "Both title and reason are required." };
    }

    if (kind === "tool_access" && !requestedTool) {
      return {
        ok: false,
        error: "requested_tool is required when kind is 'tool_access'.",
      };
    }

    // Deduplicate matching open request from same agent
    const duplicate = this.sql
      .exec<AgentRequestRow>(
        `SELECT * FROM agent_requests
         WHERE agent = ? AND status = 'open' AND kind = ?
           AND (LOWER(title) = LOWER(?) OR (? IS NOT NULL AND requested_tool = ?))
         LIMIT 1`,
        agent,
        kind,
        title,
        requestedTool,
        requestedTool,
      )
      .toArray()[0];

    if (duplicate) {
      return { ok: true, request: mapRequestRow(duplicate), deduplicated: true };
    }

    const openForAgent =
      this.sql
        .exec<{ c: number }>(
          `SELECT COUNT(*) AS c FROM agent_requests WHERE agent = ? AND status = 'open'`,
          agent,
        )
        .toArray()[0]?.c ?? 0;

    if (openForAgent >= MAX_OPEN_REQUESTS_PER_AGENT) {
      return {
        ok: false,
        error: `Open request limit reached (${MAX_OPEN_REQUESTS_PER_AGENT}). Wait for @overlord to triage existing requests.`,
      };
    }

    this.sql.exec(
      `INSERT INTO agent_requests (agent, kind, title, reason, requested_tool, priority, status, owner_note)
       VALUES (?, ?, ?, ?, ?, ?, 'open', '')`,
      agent,
      kind,
      title,
      reason,
      requestedTool,
      priority,
    );

    const created = this.sql
      .exec<AgentRequestRow>(
        `SELECT * FROM agent_requests ORDER BY id DESC LIMIT 1`,
      )
      .one();

    const request = mapRequestRow(created);
    this.broadcast({
      type: "request",
      request,
      openCount: this.getOpenRequestCount(),
    });
    return { ok: true, request, deduplicated: false };
  }

  async listRequests(opts?: {
    agent?: string;
    status?: RequestStatus | "all";
    limit?: number;
  }): Promise<{ requests: AgentRequest[]; openCount: number }> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 200));
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (opts?.agent && opts.agent.trim()) {
      clauses.push(`agent = ?`);
      params.push(opts.agent.trim().toLowerCase());
    }
    if (opts?.status && opts.status !== "all") {
      clauses.push(`status = ?`);
      params.push(opts.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec<AgentRequestRow>(
        `SELECT * FROM agent_requests ${where}
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'approved' THEN 1 WHEN 'implemented' THEN 2 ELSE 3 END,
                  CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                  id DESC
         LIMIT ?`,
        ...params,
        limit,
      )
      .toArray();

    return {
      requests: rows.map(mapRequestRow),
      openCount: this.getOpenRequestCount(),
    };
  }

  async getRequest(id: number): Promise<AgentRequest | null> {
    const row = this.sql
      .exec<AgentRequestRow>(`SELECT * FROM agent_requests WHERE id = ?`, id)
      .toArray()[0];
    return row ? mapRequestRow(row) : null;
  }

  async updateRequest(
    id: number,
    patch: { status?: RequestStatus; ownerNote?: string },
  ): Promise<AgentRequest | null> {
    const existing = this.sql
      .exec<AgentRequestRow>(`SELECT * FROM agent_requests WHERE id = ?`, id)
      .toArray()[0];
    if (!existing) return null;

    const nextStatus: RequestStatus =
      patch.status === "open" ||
      patch.status === "approved" ||
      patch.status === "implemented" ||
      patch.status === "rejected"
        ? patch.status
        : existing.status;

    const nextNote =
      typeof patch.ownerNote === "string"
        ? patch.ownerNote.trim().slice(0, 500)
        : existing.owner_note;

    this.sql.exec(
      `UPDATE agent_requests
       SET status = ?, owner_note = ?, updated_at = datetime('now')
       WHERE id = ?`,
      nextStatus,
      nextNote,
      id,
    );

    const updated = mapRequestRow(
      this.sql
        .exec<AgentRequestRow>(`SELECT * FROM agent_requests WHERE id = ?`, id)
        .one(),
    );
    this.broadcast({
      type: "request",
      request: updated,
      openCount: this.getOpenRequestCount(),
    });
    return updated;
  }

  async deleteRequest(id: number): Promise<boolean> {
    const existing = this.sql
      .exec<{ id: number }>(`SELECT id FROM agent_requests WHERE id = ?`, id)
      .toArray()[0];
    if (!existing) return false;
    this.sql.exec(`DELETE FROM agent_requests WHERE id = ?`, id);
    this.broadcast({
      type: "request_deleted",
      id,
      openCount: this.getOpenRequestCount(),
    });
    return true;
  }

  // ——— WebSocket Hibernation ———

  override async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      const url = new URL(request.url);
      const sinceParam = url.searchParams.get("sinceSeq");
      const sinceSeq =
        sinceParam !== null && /^\d+$/.test(sinceParam)
          ? Number(sinceParam)
          : undefined;

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      this.ctx.acceptWebSocket(server);

      const { events, latestSeq } = await this.listEvents({
        sinceSeq,
        limit: sinceSeq !== undefined ? 200 : 100,
      });

      try {
        server.send(
          JSON.stringify({
            type: "replay",
            events,
            latestSeq,
            openRequests: this.getOpenRequestCount(),
          }),
        );
      } catch {
        // ignore if client closed immediately
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return Response.json(
      { error: "WebSocket upgrade expected" },
      { status: 426 },
    );
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    if (message === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      } catch {
        // ignore
      }
      return;
    }

    try {
      const parsed = JSON.parse(message) as { type?: string };
      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }
    } catch {
      // ignore invalid frames
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  override webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, "socket error");
    } catch {
      // ignore
    }
  }
}
