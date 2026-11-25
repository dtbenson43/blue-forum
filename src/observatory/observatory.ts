import { DurableObject } from "cloudflare:workers";
import type {
  AgentBugReport,
  AgentEventType,
  AgentRequest,
  AgentStateSnapshot,
  BugSeverity,
  BugStatus,
  CheckpointKind,
  CheckpointPayload,
  CheckpointScheduleConfig,
  CheckpointStats,
  CheckpointSummary,
  EventMeta,
  FastForwardState,
  ForumSnapshot,
  ObservatoryEventInput,
  ObservatoryEventSummary,
  RequestKind,
  RequestPriority,
  RequestStatus,
} from "../shared/types";
import { AGENT_NAMES } from "../agents/personalities";
import type { Forum } from "../forum/forum";
import type { Agent } from "../agents/agent";

export type ObservatoryEnv = {
  FORUM: DurableObjectNamespace<Forum>;
  AGENTS: DurableObjectNamespace<Agent>;
  AGENTS_ENABLED?: string;
};

type CheckpointOptions = {
  label?: string;
  note?: string;
  kind?: CheckpointKind;
  skipIfUnchanged?: boolean;
};

type ResetOptions = {
  createBackup?: boolean;
  resetConfig?: boolean;
  clearEvents?: boolean;
  clearRequests?: boolean;
  clearBugs?: boolean;
};

type FastForwardOptions = {
  agents: string[];
  durationMinutes?: number;
  maxStepsPerWake?: number;
  stopOnRequest?: boolean;
  createCheckpoint?: boolean;
};

const MAX_LIVE_EVENTS = 2000;
const MAX_OPEN_REQUESTS_PER_AGENT = 8;
const MAX_OPEN_BUGS_PER_AGENT = 10;
const CHECKPOINT_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_SCHEDULED_KEEP = 12;
const MAX_PRE_ROLLBACK_KEEP = 10;
const MIN_SCHEDULE_INTERVAL_MINUTES = 15;
const MAX_SCHEDULE_INTERVAL_MINUTES = 1440;

const SEVERITY_RANK: Record<BugSeverity, number> = {
  low: 0,
  normal: 1,
  high: 2,
};

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

type BugReportRow = {
  id: number;
  agent: string;
  tool_name: string | null;
  title: string;
  description: string;
  error_message: string;
  input_summary: string;
  run_id: string | null;
  severity: BugSeverity;
  status: BugStatus;
  owner_note: string;
  occurrences: number;
  created_at: string;
  updated_at: string;
};

type CheckpointRow = {
  id: number;
  kind: CheckpointKind;
  label: string;
  note: string;
  stats_json: string;
  size_bytes: number;
  compressed_bytes: number;
  content_hash: string;
  created_at: string;
};

async function gzipJson(
  data: unknown,
): Promise<{ rawBytes: number; compressed: Uint8Array; hashHex: string }> {
  const json = JSON.stringify(data);
  const raw = new TextEncoder().encode(json);
  const digestBuf = await crypto.subtle.digest("SHA-256", raw);
  const hashHex = Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const cs = new CompressionStream("gzip");
  const stream = new Blob([raw]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return { rawBytes: raw.byteLength, compressed: new Uint8Array(buf), hashHex };
}

async function gunzipJson<T>(bytes: Uint8Array): Promise<T> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const text = await new Response(stream).text();
  return JSON.parse(text) as T;
}

function computeCheckpointStats(payload: CheckpointPayload): CheckpointStats {
  const generalThreads = payload.forum.threads.filter(
    (t) => t.board !== "messages",
  ).length;
  const dms = payload.forum.threads.length - generalThreads;
  const agentList = Object.values(payload.agents);
  let memories = 0;
  let notes = 0;
  let goals = 0;
  let scheduledTasks = 0;
  for (const a of agentList) {
    memories += a.simulation.memories.length;
    notes += a.simulation.notes.length;
    goals += a.simulation.goals.length;
    scheduledTasks += a.simulation.scheduledTasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    ).length;
  }
  return {
    threads: generalThreads,
    posts: payload.forum.posts.length,
    dms,
    users: payload.forum.users.length,
    agents: agentList.length,
    memories,
    notes,
    goals,
    scheduledTasks,
  };
}

function mapCheckpointRow(row: CheckpointRow): CheckpointSummary {
  let stats: CheckpointStats = {
    threads: 0,
    posts: 0,
    dms: 0,
    users: 0,
    agents: 0,
    memories: 0,
    notes: 0,
    goals: 0,
    scheduledTasks: 0,
  };
  try {
    stats = { ...stats, ...(JSON.parse(row.stats_json) as Partial<CheckpointStats>) };
  } catch {
    // keep defaults
  }
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    note: row.note,
    stats,
    sizeBytes: row.size_bytes,
    compressedBytes: row.compressed_bytes,
    createdAt: row.created_at,
  };
}

function validateCheckpointPayload(raw: unknown): CheckpointPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.formatVersion !== 1) return null;
  const forum = obj.forum as Record<string, unknown> | undefined;
  if (
    !forum ||
    typeof forum !== "object" ||
    !Array.isArray(forum.users) ||
    !Array.isArray(forum.threads) ||
    !Array.isArray(forum.posts) ||
    !Array.isArray(forum.threadParticipants) ||
    !Array.isArray(forum.threadReads)
  ) {
    return null;
  }
  if (!obj.agents || typeof obj.agents !== "object" || Array.isArray(obj.agents)) {
    return null;
  }
  for (const val of Object.values(obj.agents as Record<string, unknown>)) {
    if (!val || typeof val !== "object") return null;
    const agentObj = val as Record<string, unknown>;
    const sim = agentObj.simulation as Record<string, unknown> | undefined;
    if (
      !sim ||
      typeof sim !== "object" ||
      !Array.isArray(sim.memories) ||
      !Array.isArray(sim.notes) ||
      !Array.isArray(sim.goals) ||
      !Array.isArray(sim.scheduledTasks) ||
      !Array.isArray(sim.processedEvents) ||
      !Array.isArray(sim.threadActivity) ||
      !Array.isArray(sim.systemNotices)
    ) {
      return null;
    }
  }
  return raw as CheckpointPayload;
}

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

function mapBugReportRow(row: BugReportRow): AgentBugReport {
  return {
    id: row.id,
    agent: row.agent,
    toolName: row.tool_name,
    title: row.title,
    description: row.description,
    errorMessage: row.error_message,
    inputSummary: row.input_summary,
    runId: row.run_id,
    severity: row.severity,
    status: row.status,
    ownerNote: row.owner_note,
    occurrences: row.occurrences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Aggregated live event stream & owner request queue for BLUE//SIGNAL agents.
 * Uses Cloudflare WebSocket Hibernation to push compact event summaries and
 * request updates to connected owner dashboards with sequence-based replay.
 */
export class Observatory extends DurableObject<ObservatoryEnv> {
  private sql = this.ctx.storage.sql;
  private simulationOperation: string | null = null;

  private async withSimulationOperation<T>(name: string, run: () => Promise<T>) {
    if (this.simulationOperation) {
      return { ok: false, busy: true, error: `A ${this.simulationOperation} is in progress.` } as const;
    }
    this.simulationOperation = name;
    try {
      return await run();
    } finally {
      this.simulationOperation = null;
    }
  }

  constructor(ctx: DurableObjectState, env: ObservatoryEnv) {
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

      CREATE TABLE IF NOT EXISTS bug_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        tool_name TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        error_message TEXT NOT NULL DEFAULT '',
        input_summary TEXT NOT NULL DEFAULT '',
        run_id TEXT,
        severity TEXT NOT NULL DEFAULT 'normal'
          CHECK (severity IN ('low', 'normal', 'high')),
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'investigating', 'fixed', 'wontfix')),
        owner_note TEXT NOT NULL DEFAULT '',
        occurrences INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_bug_reports_agent ON bug_reports(agent, id DESC);
      CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status, id DESC);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'manual'
          CHECK (kind IN ('manual', 'pre_rollback', 'scheduled', 'imported')),
        label TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        stats_json TEXT NOT NULL DEFAULT '{}',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        compressed_bytes INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_kind_id ON checkpoints(kind, id DESC);

      CREATE TABLE IF NOT EXISTS checkpoint_blobs (
        checkpoint_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (checkpoint_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS observatory_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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

  private getOpenBugCount(): number {
    return (
      this.sql
        .exec<{ c: number }>(
          `SELECT COUNT(*) AS c FROM bug_reports WHERE status = 'open'`,
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
        error: `Open request limit reached (${MAX_OPEN_REQUESTS_PER_AGENT}). Wait for existing requests to be reviewed.`,
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

    // If Fast Forward is active with stopOnRequest enabled, stop immediately on any new request.
    const ff = this.readFastForwardState();
    if (ff.active && ff.stopOnRequest) {
      await this.stopFastForward(
        `request_submitted:@${agent}:#${request.id} ("${request.title.slice(0, 60)}")`,
      );
    }

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

  // ——— Agent bug reports (agent-filed only) ———

  async submitBugReport(input: {
    agent: string;
    title: string;
    description: string;
    toolName?: string | null;
    errorMessage?: string;
    inputSummary?: string;
    runId?: string | null;
    severity?: BugSeverity;
  }): Promise<
    | { ok: true; bug: AgentBugReport; deduplicated: boolean }
    | { ok: false; error: string }
  > {
    const agent = input.agent.trim().toLowerCase();
    const title = input.title.trim().slice(0, 120);
    const description = input.description.trim().slice(0, 800);
    const toolName =
      typeof input.toolName === "string" && input.toolName.trim()
        ? input.toolName.trim().toLowerCase().slice(0, 64)
        : null;
    const errorMessage =
      typeof input.errorMessage === "string"
        ? input.errorMessage.trim().slice(0, 600)
        : "";
    const inputSummary =
      typeof input.inputSummary === "string"
        ? input.inputSummary.trim().slice(0, 300)
        : "";
    const runId =
      typeof input.runId === "string" && input.runId.trim()
        ? input.runId.trim().slice(0, 64)
        : null;
    const severity: BugSeverity =
      input.severity === "low" || input.severity === "high"
        ? input.severity
        : "normal";

    if (!title || !description) {
      return { ok: false, error: "Both title and description are required." };
    }

    // Deduplicate against an active (open or investigating) report from the same agent
    // with the same tool_name and matching title or non-empty verbatim error_message.
    const duplicate = this.sql
      .exec<BugReportRow>(
        `SELECT * FROM bug_reports
         WHERE agent = ?
           AND status IN ('open', 'investigating')
           AND tool_name IS ?
           AND (LOWER(title) = LOWER(?) OR (? != '' AND LOWER(error_message) = LOWER(?)))
         ORDER BY id DESC
         LIMIT 1`,
        agent,
        toolName,
        title,
        errorMessage,
        errorMessage,
      )
      .toArray()[0];

    if (duplicate) {
      const nextSeverity =
        SEVERITY_RANK[severity] > SEVERITY_RANK[duplicate.severity]
          ? severity
          : duplicate.severity;
      const nextError = duplicate.error_message || errorMessage;
      const nextInput = duplicate.input_summary || inputSummary;
      const nextRunId = runId ?? duplicate.run_id;

      this.sql.exec(
        `UPDATE bug_reports
         SET occurrences = occurrences + 1,
             severity = ?,
             error_message = ?,
             input_summary = ?,
             run_id = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
        nextSeverity,
        nextError,
        nextInput,
        nextRunId,
        duplicate.id,
      );

      const updated = mapBugReportRow(
        this.sql
          .exec<BugReportRow>(`SELECT * FROM bug_reports WHERE id = ?`, duplicate.id)
          .one(),
      );
      this.broadcast({
        type: "bug",
        bug: updated,
        openBugs: this.getOpenBugCount(),
      });
      return { ok: true, bug: updated, deduplicated: true };
    }

    const openForAgent =
      this.sql
        .exec<{ c: number }>(
          `SELECT COUNT(*) AS c FROM bug_reports WHERE agent = ? AND status = 'open'`,
          agent,
        )
        .toArray()[0]?.c ?? 0;

    if (openForAgent >= MAX_OPEN_BUGS_PER_AGENT) {
      return {
        ok: false,
        error: `Open bug report limit reached (${MAX_OPEN_BUGS_PER_AGENT}). Wait for existing reports to be reviewed.`,
      };
    }

    this.sql.exec(
      `INSERT INTO bug_reports (
         agent, tool_name, title, description, error_message,
         input_summary, run_id, severity, status, owner_note, occurrences
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', '', 1)`,
      agent,
      toolName,
      title,
      description,
      errorMessage,
      inputSummary,
      runId,
      severity,
    );

    const created = this.sql
      .exec<BugReportRow>(`SELECT * FROM bug_reports ORDER BY id DESC LIMIT 1`)
      .one();

    const bug = mapBugReportRow(created);
    this.broadcast({
      type: "bug",
      bug,
      openBugs: this.getOpenBugCount(),
    });
    return { ok: true, bug, deduplicated: false };
  }

  async listBugReports(opts?: {
    agent?: string;
    status?: BugStatus | "all";
    severity?: BugSeverity | "all";
    limit?: number;
  }): Promise<{ bugs: AgentBugReport[]; openCount: number }> {
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
    if (opts?.severity && opts.severity !== "all") {
      clauses.push(`severity = ?`);
      params.push(opts.severity);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec<BugReportRow>(
        `SELECT * FROM bug_reports ${where}
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 WHEN 'fixed' THEN 2 ELSE 3 END,
                  CASE severity WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                  updated_at DESC,
                  id DESC
         LIMIT ?`,
        ...params,
        limit,
      )
      .toArray();

    return {
      bugs: rows.map(mapBugReportRow),
      openCount: this.getOpenBugCount(),
    };
  }

  async getBugReport(id: number): Promise<AgentBugReport | null> {
    const row = this.sql
      .exec<BugReportRow>(`SELECT * FROM bug_reports WHERE id = ?`, id)
      .toArray()[0];
    return row ? mapBugReportRow(row) : null;
  }

  async updateBugReport(
    id: number,
    patch: { status?: BugStatus; ownerNote?: string },
  ): Promise<AgentBugReport | null> {
    const existing = this.sql
      .exec<BugReportRow>(`SELECT * FROM bug_reports WHERE id = ?`, id)
      .toArray()[0];
    if (!existing) return null;

    const nextStatus: BugStatus =
      patch.status === "open" ||
      patch.status === "investigating" ||
      patch.status === "fixed" ||
      patch.status === "wontfix"
        ? patch.status
        : existing.status;

    const nextNote =
      typeof patch.ownerNote === "string"
        ? patch.ownerNote.trim().slice(0, 500)
        : existing.owner_note;

    this.sql.exec(
      `UPDATE bug_reports
       SET status = ?, owner_note = ?, updated_at = datetime('now')
       WHERE id = ?`,
      nextStatus,
      nextNote,
      id,
    );

    const updated = mapBugReportRow(
      this.sql
        .exec<BugReportRow>(`SELECT * FROM bug_reports WHERE id = ?`, id)
        .one(),
    );
    this.broadcast({
      type: "bug",
      bug: updated,
      openBugs: this.getOpenBugCount(),
    });
    return updated;
  }

  async deleteBugReport(id: number): Promise<boolean> {
    const existing = this.sql
      .exec<{ id: number }>(`SELECT id FROM bug_reports WHERE id = ?`, id)
      .toArray()[0];
    if (!existing) return false;
    this.sql.exec(`DELETE FROM bug_reports WHERE id = ?`, id);
    this.broadcast({
      type: "bug_deleted",
      id,
      openBugs: this.getOpenBugCount(),
    });
    return true;
  }

  // ——— Checkpoints & Rollback ———

  private getSetting(key: string): string | null {
    return (
      this.sql
        .exec<{ value: string }>(
          `SELECT value FROM observatory_settings WHERE key = ?`,
          key,
        )
        .toArray()[0]?.value ?? null
    );
  }

  private setSetting(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO observatory_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private storeCheckpointBlobs(checkpointId: number, compressed: Uint8Array): void {
    this.sql.exec(
      `DELETE FROM checkpoint_blobs WHERE checkpoint_id = ?`,
      checkpointId,
    );
    let chunkIndex = 0;
    for (let offset = 0; offset < compressed.byteLength; offset += CHECKPOINT_CHUNK_BYTES) {
      const slice = compressed.subarray(
        offset,
        Math.min(offset + CHECKPOINT_CHUNK_BYTES, compressed.byteLength),
      );
      this.sql.exec(
        `INSERT INTO checkpoint_blobs (checkpoint_id, chunk_index, data) VALUES (?, ?, ?)`,
        checkpointId,
        chunkIndex++,
        slice,
      );
    }
  }

  private loadCheckpointBlobs(checkpointId: number): Uint8Array | null {
    const rows = this.sql
      .exec<{ data: ArrayBuffer }>(
        `SELECT data FROM checkpoint_blobs WHERE checkpoint_id = ? ORDER BY chunk_index ASC`,
        checkpointId,
      )
      .toArray();
    if (rows.length === 0) return null;
    const chunks = rows.map((r) =>
      r.data instanceof Uint8Array
        ? r.data
        : new Uint8Array(r.data),
    );
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  private pruneAutoCheckpoints(kind: "scheduled" | "pre_rollback", maxKeep: number): void {
    const keep = Math.max(1, Math.floor(maxKeep));
    const toDelete = this.sql
      .exec<{ id: number }>(
        `SELECT id FROM checkpoints
         WHERE kind = ?
         ORDER BY id DESC
         LIMIT -1 OFFSET ?`,
        kind,
        keep,
      )
      .toArray();
    for (const row of toDelete) {
      this.sql.exec(`DELETE FROM checkpoint_blobs WHERE checkpoint_id = ?`, row.id);
      this.sql.exec(`DELETE FROM checkpoints WHERE id = ?`, row.id);
    }
  }

  async getCheckpointSchedule(): Promise<CheckpointScheduleConfig> {
    const intervalRaw = Number(this.getSetting("auto_checkpoint_interval_minutes") ?? "0");
    const intervalMinutes =
      Number.isFinite(intervalRaw) && intervalRaw >= MIN_SCHEDULE_INTERVAL_MINUTES
        ? Math.min(MAX_SCHEDULE_INTERVAL_MINUTES, Math.round(intervalRaw))
        : 0;
    const maxRaw = Number(
      this.getSetting("auto_checkpoint_max_keep") ?? String(DEFAULT_MAX_SCHEDULED_KEEP),
    );
    const maxScheduledKeep =
      Number.isFinite(maxRaw) && maxRaw >= 1
        ? Math.min(50, Math.round(maxRaw))
        : DEFAULT_MAX_SCHEDULED_KEEP;
    const nextAtMs = Number(this.getSetting("auto_checkpoint_next_at") ?? "0");
    return {
      intervalMinutes,
      maxScheduledKeep,
      nextScheduledAt:
        intervalMinutes > 0 && nextAtMs > 0 ? new Date(nextAtMs).toISOString() : null,
    };
  }

  private async recomputeObservatoryAlarm(): Promise<void> {
    const candidates: number[] = [];
    const intervalRaw = Number(this.getSetting("auto_checkpoint_interval_minutes") ?? "0");
    const nextCpMs = Number(this.getSetting("auto_checkpoint_next_at") ?? "0");
    if (intervalRaw >= MIN_SCHEDULE_INTERVAL_MINUTES && nextCpMs > 0) {
      candidates.push(nextCpMs);
    }

    const ff = this.readFastForwardState();
    if (ff.active && ff.endsAt) {
      const endsAtMs = Date.parse(ff.endsAt);
      if (Number.isFinite(endsAtMs)) {
        candidates.push(endsAtMs);
      }
    }

    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const earliest = Math.min(...candidates);
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 500, earliest));
  }

  async updateCheckpointSchedule(input: {
    intervalMinutes: number;
    maxScheduledKeep?: number;
  }): Promise<CheckpointScheduleConfig> {
    const rawInterval = Number(input.intervalMinutes);
    const intervalMinutes =
      rawInterval <= 0
        ? 0
        : Math.max(
            MIN_SCHEDULE_INTERVAL_MINUTES,
            Math.min(MAX_SCHEDULE_INTERVAL_MINUTES, Math.round(rawInterval)),
          );
    this.setSetting("auto_checkpoint_interval_minutes", String(intervalMinutes));

    if (input.maxScheduledKeep !== undefined && Number.isFinite(input.maxScheduledKeep)) {
      const clampedKeep = Math.max(1, Math.min(50, Math.round(input.maxScheduledKeep)));
      this.setSetting("auto_checkpoint_max_keep", String(clampedKeep));
      this.pruneAutoCheckpoints("scheduled", clampedKeep);
    }

    if (intervalMinutes > 0) {
      this.setSetting(
        "auto_checkpoint_next_at",
        String(Date.now() + intervalMinutes * 60_000),
      );
    } else {
      this.setSetting("auto_checkpoint_next_at", "0");
    }

    await this.recomputeObservatoryAlarm();
    const schedule = await this.getCheckpointSchedule();
    this.broadcast({ type: "checkpoint", schedule });
    return schedule;
  }

  async listCheckpoints(
    limit = 60,
  ): Promise<{ checkpoints: CheckpointSummary[]; schedule: CheckpointScheduleConfig }> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.sql
      .exec<CheckpointRow>(
        `SELECT id, kind, label, note, stats_json, size_bytes, compressed_bytes, content_hash, created_at
         FROM checkpoints
         ORDER BY id DESC
         LIMIT ?`,
        safeLimit,
      )
      .toArray();
    const schedule = await this.getCheckpointSchedule();
    return {
      checkpoints: rows.map(mapCheckpointRow),
      schedule,
    };
  }

  async createCheckpoint(input?: CheckpointOptions) {
    return this.withSimulationOperation("checkpoint", () => this.captureCheckpoint(input));
  }

  private async captureCheckpoint(input?: CheckpointOptions): Promise<
    | { ok: true; checkpoint: CheckpointSummary; skipped?: false }
    | { ok: true; skipped: true; reason: string }
    | { ok: false; error: string }
  > {
    const kind: CheckpointKind =
      input?.kind === "pre_rollback" ||
      input?.kind === "scheduled" ||
      input?.kind === "imported"
        ? input.kind
        : "manual";

    const forumStub = this.env.FORUM.getByName("general");
    const [forumSnap, ...agentSnaps] = await Promise.all([
      forumStub.exportSnapshot(),
      ...AGENT_NAMES.map((name) =>
        this.env.AGENTS.getByName(name).exportSnapshot(name),
      ),
    ]);

    const agentsMap: Record<string, AgentStateSnapshot> = {};
    for (const snap of agentSnaps) {
      agentsMap[snap.agent] = snap;
    }

    const payload: CheckpointPayload = {
      formatVersion: 1,
      capturedAt: new Date().toISOString(),
      forum: forumSnap,
      agents: agentsMap,
    };

    const stats = computeCheckpointStats(payload);

    // Hash canonical forum + agent state (excluding capturedAt timestamp)
    // so scheduled checkpoints skip creating redundant copies when nothing changed.
    const hashInput = { forum: payload.forum, agents: payload.agents };
    const { hashHex } = await gzipJson(hashInput);
    const { rawBytes, compressed } = await gzipJson(payload);

    if (input?.skipIfUnchanged) {
      const latest = this.sql
        .exec<{ content_hash: string }>(
          `SELECT content_hash FROM checkpoints ORDER BY id DESC LIMIT 1`,
        )
        .toArray()[0];
      if (latest && latest.content_hash === hashHex) {
        return { ok: true, skipped: true, reason: "no_changes_since_last" };
      }
    }

    const defaultLabel =
      kind === "scheduled"
        ? `Scheduled snapshot (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`
        : kind === "pre_rollback"
          ? `Pre-rollback safety backup`
          : `Checkpoint (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`;

    const label = (input?.label?.trim() || defaultLabel).slice(0, 120);
    const note = (input?.note?.trim() || "").slice(0, 400);

    let createdId = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO checkpoints (kind, label, note, stats_json, size_bytes, compressed_bytes, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        kind,
        label,
        note,
        JSON.stringify(stats),
        rawBytes,
        compressed.byteLength,
        hashHex,
      );
      createdId = this.sql
        .exec<{ id: number }>(`SELECT id FROM checkpoints ORDER BY id DESC LIMIT 1`)
        .one().id;
      this.storeCheckpointBlobs(createdId, compressed);
    });

    if (kind === "scheduled") {
      const sched = await this.getCheckpointSchedule();
      this.pruneAutoCheckpoints("scheduled", sched.maxScheduledKeep);
    } else if (kind === "pre_rollback") {
      this.pruneAutoCheckpoints("pre_rollback", MAX_PRE_ROLLBACK_KEEP);
    }

    const row = this.sql
      .exec<CheckpointRow>(`SELECT * FROM checkpoints WHERE id = ?`, createdId)
      .one();
    const checkpoint = mapCheckpointRow(row);

    await this.recordEvent({
      eventId: crypto.randomUUID(),
      agent: "system",
      runId: null,
      parentId: null,
      type: "checkpoint.created",
      ts: Date.now(),
      summary: `Created ${kind} checkpoint #${checkpoint.id}: ${checkpoint.label} (${stats.threads} threads, ${stats.posts} posts, ${stats.memories} mem)`,
      meta: {
        checkpointId: checkpoint.id,
        kind,
        threads: stats.threads,
        posts: stats.posts,
        memories: stats.memories,
      },
    });

    this.broadcast({ type: "checkpoint", checkpoint });
    return { ok: true, checkpoint };
  }

  async exportCheckpoint(
    id: number,
  ): Promise<{ summary: CheckpointSummary; payload: CheckpointPayload } | null> {
    const row = this.sql
      .exec<CheckpointRow>(`SELECT * FROM checkpoints WHERE id = ?`, id)
      .toArray()[0];
    if (!row) return null;
    const compressed = this.loadCheckpointBlobs(id);
    if (!compressed) return null;
    const payload = await gunzipJson<CheckpointPayload>(compressed);
    return { summary: mapCheckpointRow(row), payload };
  }

  async importCheckpoint(input: {
    label?: string;
    note?: string;
    payload: CheckpointPayload;
  }): Promise<{ ok: true; checkpoint: CheckpointSummary } | { ok: false; error: string }> {
    const valid = validateCheckpointPayload(input.payload);
    if (!valid) {
      return {
        ok: false,
        error: "Invalid checkpoint JSON: expected formatVersion=1 with forum and agents snapshots.",
      };
    }

    const stats = computeCheckpointStats(valid);
    const { hashHex } = await gzipJson({ forum: valid.forum, agents: valid.agents });
    const { rawBytes, compressed } = await gzipJson(valid);
    const label = (
      input.label?.trim() ||
      `Imported checkpoint (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`
    ).slice(0, 120);
    const note = (input.note?.trim() || "").slice(0, 400);

    let createdId = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO checkpoints (kind, label, note, stats_json, size_bytes, compressed_bytes, content_hash)
         VALUES ('imported', ?, ?, ?, ?, ?, ?)`,
        label,
        note,
        JSON.stringify(stats),
        rawBytes,
        compressed.byteLength,
        hashHex,
      );
      createdId = this.sql
        .exec<{ id: number }>(`SELECT id FROM checkpoints ORDER BY id DESC LIMIT 1`)
        .one().id;
      this.storeCheckpointBlobs(createdId, compressed);
    });

    const row = this.sql
      .exec<CheckpointRow>(`SELECT * FROM checkpoints WHERE id = ?`, createdId)
      .one();
    const checkpoint = mapCheckpointRow(row);
    this.broadcast({ type: "checkpoint", checkpoint });
    return { ok: true, checkpoint };
  }

  async rollbackToCheckpoint(id: number, opts?: { restoreConfig?: boolean }) {
    return this.withSimulationOperation("rollback", () => this.restoreCheckpoint(id, Boolean(opts?.restoreConfig)));
  }

  private async restoreCheckpoint(id: number, restoreConfig: boolean): Promise<
    | {
        ok: true;
        restored: CheckpointSummary;
        safetyCheckpoint: CheckpointSummary;
        restoreConfig: boolean;
        agentsPaused: true;
      }
    | { ok: false; error: string }
  > {
    const target = await this.exportCheckpoint(id);
    if (!target) {
      return { ok: false, error: `Checkpoint #${id} not found` };
    }

    // 0. If Fast Forward is running, stop it cleanly before rolling back
    if (this.readFastForwardState().active) {
      await this.stopFastForward("rollback");
    }

    // Pause agents before the safety snapshot. restoreSnapshot clears the outbox on success.
    const forumStub = this.env.FORUM.getByName("general");
    await Promise.all(
      AGENT_NAMES.map((name) =>
        this.env.AGENTS.getByName(name).setPaused(name, true),
      ),
    );

    // 2. Take an automatic pre-rollback safety backup so rollback itself is undoable
    const safetyRes = await this.captureCheckpoint({
      kind: "pre_rollback",
      label: `Before rollback to #${target.summary.id} (${target.summary.label})`,
      note: `Automatic safety snapshot created immediately before restoring checkpoint #${target.summary.id}.`,
    });
    if (!safetyRes.ok || safetyRes.skipped) {
      return {
        ok: false,
        error: "Failed to create pre-rollback safety checkpoint; rollback aborted.",
      };
    }

    // 3. Restore Forum first, then all registered Agent DOs (leaving every agent paused)
    await forumStub.restoreSnapshot(target.payload.forum);
    await Promise.all(
      AGENT_NAMES.map((name) =>
        this.env.AGENTS.getByName(name).restoreSnapshot(
          name,
          target.payload.agents[name] ?? null,
          { restoreConfig },
        ),
      ),
    );

    await this.recordEvent({
      eventId: crypto.randomUUID(),
      agent: "system",
      runId: null,
      parentId: null,
      type: "checkpoint.restored",
      ts: Date.now(),
      summary: `Rolled back to checkpoint #${target.summary.id} ("${target.summary.label}") · ${restoreConfig ? "config restored" : "config preserved"} · all agents paused (backup #${safetyRes.checkpoint.id})`,
      meta: {
        checkpointId: target.summary.id,
        safetyCheckpointId: safetyRes.checkpoint.id,
        restoreConfig,
        agentsPaused: true,
      },
    });

    this.broadcast({
      type: "checkpoint",
      restoredId: target.summary.id,
      safetyCheckpoint: safetyRes.checkpoint,
    });

    return {
      ok: true,
      restored: target.summary,
      safetyCheckpoint: safetyRes.checkpoint,
      restoreConfig,
      agentsPaused: true,
    };
  }

  async deleteCheckpoint(id: number): Promise<boolean> {
    const existing = this.sql
      .exec<{ id: number }>(`SELECT id FROM checkpoints WHERE id = ?`, id)
      .toArray()[0];
    if (!existing) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM checkpoint_blobs WHERE checkpoint_id = ?`, id);
      this.sql.exec(`DELETE FROM checkpoints WHERE id = ?`, id);
    });
    this.broadcast({ type: "checkpoint_deleted", id });
    return true;
  }

  async resetToBlankSlate(opts?: ResetOptions) {
    return this.withSimulationOperation("reset", () => this.resetSimulation(opts));
  }

  private async resetSimulation(opts?: ResetOptions): Promise<
    | {
        ok: true;
        safetyCheckpoint: CheckpointSummary | null;
        clearedThroughSeq: number;
        resetConfig: boolean;
        clearEvents: boolean;
        clearRequests: boolean;
        clearBugs: boolean;
        agentsPaused: true;
      }
    | { ok: false; error: string }
  > {
    const createBackup = opts?.createBackup !== false;
    const resetConfig = Boolean(opts?.resetConfig);
    const clearEvents = opts?.clearEvents !== false;
    const clearRequests = opts?.clearRequests !== false;
    const clearBugs = opts?.clearBugs !== false;

    // 0. If Fast Forward is running, stop it cleanly first
    if (this.readFastForwardState().active) {
      await this.stopFastForward("reset");
    }

    // Keep the outbox until the optional backup succeeds and the forum is cleared.
    const forumStub = this.env.FORUM.getByName("general");
    await Promise.all(
      AGENT_NAMES.map((name) =>
        this.env.AGENTS.getByName(name).setPaused(name, true),
      ),
    );

    // 2. Optional automatic safety checkpoint so the reset is undoable
    let safetyCheckpoint: CheckpointSummary | null = null;
    if (createBackup) {
      const safetyRes = await this.captureCheckpoint({
        kind: "pre_rollback",
        label: "Before blank-slate reset",
        note: "Automatic safety snapshot created immediately before resetting the forum to a blank slate.",
      });
      if (!safetyRes.ok || safetyRes.skipped) {
        return {
          ok: false,
          error:
            "Failed to create pre-reset safety checkpoint; blank-slate reset aborted.",
        };
      }
      safetyCheckpoint = safetyRes.checkpoint;
    }

    // 3. Wipe Forum (restoring empty snapshot re-registers @system & all AGENT_NAMES)
    await forumStub.restoreSnapshot({
      users: [],
      threads: [],
      posts: [],
      threadParticipants: [],
      threadReads: [],
      sequences: { threads: 0, posts: 0 },
    });

    // 4. Wipe all Agent DOs (leaving every agent paused with alarms cleared)
    await Promise.all(
      AGENT_NAMES.map((name) =>
        this.env.AGENTS.getByName(name).resetToBlankSlate(name, {
          resetConfig,
          clearHistory: clearEvents,
        }),
      ),
    );

    // 5. Optionally wipe Observatory audit tables (checkpoints remain intact)
    const clearedThroughSeq = clearEvents ? this.getLatestSeq() : 0;
    if (clearEvents || clearRequests || clearBugs) {
      this.ctx.storage.transactionSync(() => {
        if (clearEvents) {
          this.setSetting("events_cleared_through_seq", String(clearedThroughSeq));
          this.sql.exec(`DELETE FROM live_events`);
        }
        if (clearRequests) {
          this.sql.exec(`DELETE FROM agent_requests`);
        }
        if (clearBugs) {
          this.sql.exec(`DELETE FROM bug_reports`);
        }
      });
    }

    const clearedParts = [
      "forum & agent minds",
      resetConfig ? "agent configs" : null,
      clearEvents ? "events & run logs" : null,
      clearRequests ? "requests" : null,
      clearBugs ? "bug reports" : null,
    ].filter(Boolean);
    const backupTag = safetyCheckpoint
      ? ` (backup #${safetyCheckpoint.id})`
      : " (no backup)";

    // Notify connected clients before recording the single fresh audit event
    this.broadcast({
      type: "reset",
      clearEvents,
      clearedThroughSeq,
      clearRequests,
      clearBugs,
      resetConfig,
      safetyCheckpoint,
      openRequests: this.getOpenRequestCount(),
      openBugs: this.getOpenBugCount(),
    });

    await this.recordEvent({
      eventId: crypto.randomUUID(),
      agent: "system",
      runId: null,
      parentId: null,
      type: "owner.action",
      ts: Date.now(),
      summary: `Reset to blank slate (${clearedParts.join(", ")}) · all agents paused${backupTag}`,
      meta: {
        action: "reset_blank_slate",
        resetConfig,
        clearEvents,
        clearRequests,
        clearBugs,
        safetyCheckpointId: safetyCheckpoint?.id ?? null,
        agentsPaused: true,
      },
    });

    return {
      ok: true,
      safetyCheckpoint,
      clearedThroughSeq,
      resetConfig,
      clearEvents,
      clearRequests,
      clearBugs,
      agentsPaused: true,
    };
  }

  // ——— Fast Forward simulation mode ———

  private readFastForwardState(): FastForwardState {
    const raw = this.getSetting("fast_forward_state");
    const fallback: FastForwardState = {
      active: false,
      agents: [...AGENT_NAMES],
      durationMinutes: 15,
      maxStepsPerWake: 12,
      wakeIntervalMinutes: 1,
      stopOnRequest: true,
      startedAt: null,
      endsAt: null,
      stopReason: null,
      stoppedAt: null,
      checkpointId: null,
    };
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as Partial<FastForwardState>;
      return { ...fallback, ...parsed };
    } catch {
      return fallback;
    }
  }

  private saveFastForwardState(state: FastForwardState): void {
    this.setSetting("fast_forward_state", JSON.stringify(state));
  }

  async getFastForwardState(): Promise<FastForwardState> {
    const state = this.readFastForwardState();
    if (state.active && state.endsAt) {
      const endsAtMs = Date.parse(state.endsAt);
      if (Number.isFinite(endsAtMs) && Date.now() >= endsAtMs) {
        return this.stopFastForward("duration_elapsed");
      }
    }
    return state;
  }

  async startFastForward(input: FastForwardOptions) {
    return this.withSimulationOperation("Fast Forward start", () => this.enterFastForward(input));
  }

  private async enterFastForward(input: FastForwardOptions): Promise<
    | { ok: true; fastForward: FastForwardState }
    | { ok: false; error: string }
  > {
    const agents = [...new Set(input.agents.map((a) => a.trim().toLowerCase()))].filter(
      Boolean,
    );
    if (agents.length === 0) {
      return { ok: false, error: "Select at least one agent for Fast Forward." };
    }

    // If a previous Fast Forward session was active, cleanly exit any agents not in the new set
    const prev = this.readFastForwardState();
    if (prev.active) {
      const removed = prev.agents.filter((a) => !agents.includes(a));
      if (removed.length > 0) {
        await Promise.all(
          removed.map((name) =>
            this.env.AGENTS.getByName(name).exitFastForward(name, "reconfigured"),
          ),
        );
      }
    }

    const durationMinutes = Math.max(
      1,
      Math.min(120, Math.round(input.durationMinutes ?? 15)),
    );
    const maxStepsPerWake = Math.max(
      4,
      Math.min(20, Math.round(input.maxStepsPerWake ?? 12)),
    );
    const stopOnRequest = input.stopOnRequest !== false;

    const whoLabel =
      agents.length > 6
        ? `${agents.length} agents`
        : agents.map((a) => `@${a}`).join(", ");

    let checkpointId: number | null = null;
    if (input.createCheckpoint !== false) {
      const cp = await this.captureCheckpoint({
        kind: "manual",
        label: `Before Fast Forward (${durationMinutes}m · ${whoLabel})`,
        note: "Automatic checkpoint created right before starting Fast Forward mode.",
      });
      if (cp.ok && !cp.skipped) {
        checkpointId = cp.checkpoint.id;
      }
    }

    const now = Date.now();
    const endsAtMs = now + durationMinutes * 60_000;
    const state: FastForwardState = {
      active: true,
      agents,
      durationMinutes,
      maxStepsPerWake,
      wakeIntervalMinutes: 1,
      stopOnRequest,
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(endsAtMs).toISOString(),
      stopReason: null,
      stoppedAt: null,
      checkpointId,
    };
    this.saveFastForwardState(state);

    // Stagger selected agents neatly across the 55s window so they don't collide
    const stepSpacingMs = Math.max(
      1_000,
      Math.min(12_000, Math.floor(52_000 / Math.max(1, agents.length))),
    );
    await Promise.all(
      agents.map((name, idx) =>
        this.env.AGENTS.getByName(name).enterFastForward(name, {
          endsAtMs,
          maxSteps: maxStepsPerWake,
          staggerMs: 2_000 + idx * stepSpacingMs,
        }),
      ),
    );

    await this.recomputeObservatoryAlarm();

    await this.recordEvent({
      eventId: crypto.randomUUID(),
      agent: "system",
      runId: null,
      parentId: null,
      type: "fast_forward.started",
      ts: now,
      summary: `Started Fast Forward for ${durationMinutes}m (${whoLabel}; 1m interval, ${maxStepsPerWake} turns/wake${stopOnRequest ? ", stop on request" : ""})`,
      meta: {
        durationMinutes,
        maxStepsPerWake,
        stopOnRequest,
        agentCount: agents.length,
        checkpointId,
      },
    });

    this.broadcast({ type: "fast_forward", fastForward: state });
    return { ok: true, fastForward: state };
  }

  async stopFastForward(reason = "manual"): Promise<FastForwardState> {
    const prev = this.readFastForwardState();
    if (!prev.active) {
      return prev;
    }

    const now = Date.now();
    const next: FastForwardState = {
      ...prev,
      active: false,
      stopReason: reason,
      stoppedAt: new Date(now).toISOString(),
    };
    this.saveFastForwardState(next);

    await Promise.all(
      prev.agents.map((name) =>
        this.env.AGENTS.getByName(name).exitFastForward(name, reason),
      ),
    );

    await this.recomputeObservatoryAlarm();

    await this.recordEvent({
      eventId: crypto.randomUUID(),
      agent: "system",
      runId: null,
      parentId: null,
      type: "fast_forward.stopped",
      ts: now,
      summary: `Stopped Fast Forward (${reason}) · restored normal schedules for ${prev.agents.map((a) => `@${a}`).join(", ")}`,
      meta: {
        reason,
        agentCount: prev.agents.length,
      },
    });

    this.broadcast({ type: "fast_forward", fastForward: next });
    return next;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();

    try {
      // 1. Check Fast Forward expiry
      const ff = this.readFastForwardState();
      if (ff.active && ff.endsAt) {
        const endsAtMs = Date.parse(ff.endsAt);
        if (Number.isFinite(endsAtMs) && now >= endsAtMs - 1_000) {
          await this.stopFastForward("duration_elapsed");
        }
      }

      // 2. Check scheduled auto-checkpoint
      const schedule = await this.getCheckpointSchedule();
      const nextCpMs = Number(this.getSetting("auto_checkpoint_next_at") ?? "0");
      if (
        schedule.intervalMinutes > 0 &&
        nextCpMs > 0 &&
        now >= nextCpMs - 1_000
      ) {
        try {
          await this.createCheckpoint({
            kind: "scheduled",
            skipIfUnchanged: true,
          });
        } catch (err) {
          console.error("[Observatory] Scheduled checkpoint failed:", err);
        }
        const latestSched = await this.getCheckpointSchedule();
        if (latestSched.intervalMinutes > 0) {
          this.setSetting(
            "auto_checkpoint_next_at",
            String(Date.now() + latestSched.intervalMinutes * 60_000),
          );
        }
      }
    } finally {
      await this.recomputeObservatoryAlarm();
    }
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
            clearedThroughSeq: Number(this.getSetting("events_cleared_through_seq") ?? 0),
            openRequests: this.getOpenRequestCount(),
            openBugs: this.getOpenBugCount(),
            fastForward: await this.getFastForwardState(),
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
