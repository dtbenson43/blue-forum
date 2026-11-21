import { DurableObject } from "cloudflare:workers";
import type {
  AgentEventType,
  EventMeta,
  ObservatoryEventInput,
  ObservatoryEventSummary,
} from "../shared/types";

const MAX_LIVE_EVENTS = 2000;

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

function mapRow(row: LiveEventRow): ObservatoryEventSummary {
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

/**
 * Aggregated live event stream for BLUE//SIGNAL agents.
 * Stores a compact ring buffer of event summaries in SQLite and uses
 * Cloudflare WebSocket Hibernation to stream live updates with reconnect replay.
 * Full payloads remain inside each Agent DO and are fetched on demand.
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
    `);
  }

  private getLatestSeq(): number {
    return (
      this.sql
        .exec<{ latest: number | null }>(`SELECT MAX(seq) AS latest FROM live_events`)
        .toArray()[0]?.latest ?? 0
    );
  }

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
      return mapRow(existing);
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

    // Keep ring buffer bounded
    if (row.seq % 50 === 0) {
      this.sql.exec(
        `DELETE FROM live_events
         WHERE seq <= (SELECT MAX(seq) - ? FROM live_events)`,
        MAX_LIVE_EVENTS,
      );
    }

    const summary = mapRow(row);
    const frame = JSON.stringify({ type: "event", event: summary });

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
      return { events: rows.map(mapRow), latestSeq };
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

    return { events: rows.map(mapRow), latestSeq };
  }

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
        server.send(JSON.stringify({ type: "replay", events, latestSeq }));
      } catch {
        // ignore if client closed immediately
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return Response.json({ error: "WebSocket upgrade expected" }, { status: 426 });
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

  override webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): void {
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
