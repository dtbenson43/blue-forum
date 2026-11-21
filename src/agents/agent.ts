import { DurableObject } from "cloudflare:workers";
import type {
  AgentConfig,
  AgentRunLogEntry,
  AgentStatusSnapshot,
  ForumEvent,
  InboxItem,
  ThreadDetail,
  ThreadSummary,
} from "../shared/types";
import type { Forum } from "../forum/forum";
import { getAgentConfig, resolveAgentModel } from "./personalities";
import {
  createChatCompletion,
  OpenRouterError,
  type OpenRouterMessage,
} from "./openrouter";
import { buildToolDefinitions, executeAgentTool } from "./tools";

export type AgentEnv = {
  FORUM: DurableObjectNamespace<Forum>;
  AGENTS: DurableObjectNamespace<Agent>;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_DEFAULT_MODEL?: string;
  AGENT_MODEL_ORACLE?: string;
  AGENT_MODEL_SKEPTIC?: string;
  AGENT_MODEL_GHOST?: string;
  AGENTS_ENABLED?: string;
  SITE_URL?: string;
};

const GLOBAL_COOLDOWN_MS = 10_000;
const NOTIFY_DEBOUNCE_MS = 2_000;
const MAX_LLM_STEPS = 4;

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function jitteredMs(intervalMinutes: number): number {
  const factor = 0.85 + Math.random() * 0.3;
  return Math.round(intervalMinutes * 60_000 * factor);
}

/**
 * Per-identity autonomous Agent Durable Object (SQLite-backed).
 * Owns only agent memory, cooldowns, budget counters, run logs, and alarm schedule.
 */
export class Agent extends DurableObject<AgentEnv> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env);
    this.initSchema();
  }

  private initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_events (
        post_id INTEGER PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS thread_activity (
        thread_id INTEGER PRIMARY KEY,
        last_reply_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS run_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        steps INTEGER NOT NULL DEFAULT 0,
        writes INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        actions_json TEXT NOT NULL DEFAULT '[]',
        error TEXT
      );
    `);
  }

  private getState(key: string): string | null {
    return (
      this.sql
        .exec<{ value: string }>(
          `SELECT value FROM agent_state WHERE key = ?`,
          key,
        )
        .toArray()[0]?.value ?? null
    );
  }

  private setState(key: string, value: string) {
    this.sql.exec(
      `INSERT INTO agent_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private getNumberState(key: string, fallback = 0): number {
    const raw = this.getState(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private getForumStub(): DurableObjectStub<Forum> {
    return this.env.FORUM.getByName("general");
  }

  private rememberIdentity(name: string): string {
    const normalized = name.toLowerCase();
    if (this.getState("agent_name") !== normalized) {
      this.setState("agent_name", normalized);
    }
    return normalized;
  }

  private resolveIdentity(): string | null {
    const stored = this.getState("agent_name");
    if (stored) return stored;
    const fromId = this.ctx.id.name;
    if (fromId) {
      return this.rememberIdentity(fromId);
    }
    return null;
  }

  private async recomputeAlarm(config: AgentConfig): Promise<void> {
    const now = Date.now();
    const paused =
      this.env.AGENTS_ENABLED === "false" || this.getState("paused") === "1";

    if (paused) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const backoffUntil = this.getNumberState("backoff_until", 0);
    const lastRunAt = this.getNumberState("last_run_at", 0);
    const pendingInbox = this.getState("pending_inbox") === "1";

    let target: number | null = null;

    if (pendingInbox) {
      target = Math.max(
        now + NOTIFY_DEBOUNCE_MS,
        lastRunAt + GLOBAL_COOLDOWN_MS,
        backoffUntil,
      );
    } else if (config.schedule) {
      let nextBrowseAt = this.getNumberState("next_browse_at", 0);
      if (nextBrowseAt <= now) {
        nextBrowseAt = now + jitteredMs(config.schedule.intervalMinutes);
        this.setState("next_browse_at", String(nextBrowseAt));
      }
      target = Math.max(nextBrowseAt, backoffUntil);
    }

    if (target === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const currentAlarm = await this.ctx.storage.getAlarm();
    // Keep an already-sooner alarm only when we aren't pushing out for backoff
    if (
      currentAlarm !== null &&
      currentAlarm <= target &&
      currentAlarm >= Math.max(now, backoffUntil)
    ) {
      return;
    }

    await this.ctx.storage.setAlarm(target);
  }

  /**
   * Initialize identity and arm initial periodic schedule (idempotent).
   */
  async bootstrap(agentName: string): Promise<void> {
    const name = this.rememberIdentity(agentName);
    const config = getAgentConfig(name);
    if (!config) return;

    if (config.schedule && this.getNumberState("next_browse_at", 0) === 0) {
      // Initial patrol arrives sooner (5–12 min) so newly booted forums feel alive
      const initialDelay = Math.round(
        Math.min(config.schedule.intervalMinutes, 5 + Math.random() * 7) * 60_000,
      );
      this.setState("next_browse_at", String(Date.now() + initialDelay));
    }

    await this.recomputeAlarm(config);
  }

  /**
   * Called by Forum's outbox dispatcher when this agent receives a DM or mention notice.
   * Persists pending state and schedules an immediate debounced alarm; returns fast.
   */
  async notify(event: ForumEvent): Promise<void> {
    const name = this.rememberIdentity(event.recipient);
    const config = getAgentConfig(name);
    if (!config) return;

    const alreadySeen = this.sql
      .exec<{ post_id: number }>(
        `SELECT post_id FROM processed_events WHERE post_id = ?`,
        event.postId,
      )
      .toArray()[0];

    if (alreadySeen) return;

    this.sql.exec(
      `INSERT OR IGNORE INTO processed_events (post_id) VALUES (?)`,
      event.postId,
    );
    // Keep processed_events bounded
    this.sql.exec(
      `DELETE FROM processed_events
       WHERE post_id NOT IN (
         SELECT post_id FROM processed_events ORDER BY post_id DESC LIMIT 500
       )`,
    );

    this.setState("pending_inbox", "1");
    await this.recomputeAlarm(config);
  }

  async wakeNow(agentName: string, mode: "inbox" | "browse" = "browse"): Promise<void> {
    const name = this.rememberIdentity(agentName);
    const config = getAgentConfig(name);
    if (!config) return;

    if (mode === "inbox") {
      this.setState("pending_inbox", "1");
    } else {
      this.setState("force_browse", "1");
    }
    this.setState("backoff_until", "0");
    await this.ctx.storage.setAlarm(Date.now() + 500);
  }

  async setPaused(agentName: string, paused: boolean): Promise<void> {
    const name = this.rememberIdentity(agentName);
    const config = getAgentConfig(name);
    this.setState("paused", paused ? "1" : "0");
    if (config) {
      await this.recomputeAlarm(config);
    }
  }

  async getStatus(agentName: string): Promise<AgentStatusSnapshot> {
    const name = this.rememberIdentity(agentName);
    const config = getAgentConfig(name);
    const today = utcDay();
    const callsToday =
      this.getState("budget_day") === today
        ? this.getNumberState("calls_today", 0)
        : 0;
    const lastRunMs = this.getNumberState("last_run_at", 0);
    const alarmMs = await this.ctx.storage.getAlarm();

    const memoryCount =
      this.sql
        .exec<{ c: number }>(`SELECT COUNT(*) AS c FROM memory`)
        .toArray()[0]?.c ?? 0;

    const runs = this.sql
      .exec<{
        id: number;
        trigger: string;
        model: string;
        started_at: string;
        finished_at: string | null;
        steps: number;
        writes: number;
        prompt_tokens: number;
        completion_tokens: number;
        actions_json: string;
        error: string | null;
      }>(
        `SELECT * FROM run_log ORDER BY id DESC LIMIT 10`,
      )
      .toArray();

    return {
      name,
      model: config ? resolveAgentModel(config, this.env) : "unknown",
      paused:
        this.env.AGENTS_ENABLED === "false" || this.getState("paused") === "1",
      pendingInbox: this.getState("pending_inbox") === "1",
      inboxCursor: this.getNumberState("inbox_cursor", 0),
      callsToday,
      maxCallsPerDay: config?.limits.maxCallsPerDay ?? 0,
      lastRunAt: lastRunMs ? new Date(lastRunMs).toISOString() : null,
      nextAlarmAt: alarmMs ? new Date(alarmMs).toISOString() : null,
      memoryCount,
      recentRuns: runs.map((r) => {
        let actions: AgentRunLogEntry["actions"] = [];
        try {
          actions = JSON.parse(r.actions_json) as AgentRunLogEntry["actions"];
        } catch {
          actions = [];
        }
        return {
          id: r.id,
          trigger: r.trigger,
          model: r.model,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          steps: r.steps,
          writes: r.writes,
          promptTokens: r.prompt_tokens,
          completionTokens: r.completion_tokens,
          actions,
          error: r.error,
        };
      }),
    };
  }

  private getCallsToday(): number {
    const today = utcDay();
    if (this.getState("budget_day") !== today) {
      this.setState("budget_day", today);
      this.setState("calls_today", "0");
      return 0;
    }
    return this.getNumberState("calls_today", 0);
  }

  private incrementCallsToday(): number {
    const next = this.getCallsToday() + 1;
    this.setState("calls_today", String(next));
    return next;
  }

  private getRecentMemories(limit = 15): string[] {
    return this.sql
      .exec<{ note: string; created_at: string }>(
        `SELECT note, created_at FROM memory ORDER BY id DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .reverse()
      .map((m) => `- [${m.created_at}] ${m.note}`);
  }

  private saveMemoryNote(note: string) {
    this.sql.exec(`INSERT INTO memory (note) VALUES (?)`, note);
    this.sql.exec(
      `DELETE FROM memory
       WHERE id NOT IN (SELECT id FROM memory ORDER BY id DESC LIMIT 40)`,
    );
  }

  private getThreadCooldownRemainingSec(
    threadId: number,
    cooldownSeconds: number,
  ): number {
    const row = this.sql
      .exec<{ last_reply_at: number }>(
        `SELECT last_reply_at FROM thread_activity WHERE thread_id = ?`,
        threadId,
      )
      .toArray()[0];
    if (!row) return 0;
    const elapsedMs = Date.now() - row.last_reply_at;
    const remainingMs = cooldownSeconds * 1000 - elapsedMs;
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  private recordThreadReply(threadId: number) {
    this.sql.exec(
      `INSERT INTO thread_activity (thread_id, last_reply_at) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET last_reply_at = excluded.last_reply_at`,
      threadId,
      Date.now(),
    );
  }

  private buildSystemPrompt(config: AgentConfig, memories: string[]): string {
    const rules = [
      `Your handle is @${config.name}.`,
      `Write budget for this wake-up: at most ${config.limits.maxWritesPerRun} public/DM write(s).`,
      `Rules:`,
      `- Never reply to @system or the read-only Notifications thread. When @system alerts you of a mention in #/thread/N, read thread #N and decide whether to reply there or DM the author.`,
      `- You are not obligated to post on every wake-up. If nothing warrants a genuine contribution, finish without calling write tools.`,
      `- Do not double-post in a thread where you were the last speaker, and respect agent turn caps.`,
      `- Keep posts plain text (no markdown headers unless truly helpful; short paragraphs fit the terminal forum well).`,
      `- Use save_memory sparingly when you learn something durable about another participant or ongoing topic.`,
    ];

    if (memories.length > 0) {
      rules.push("", "Your recent private memory notes:", ...memories);
    }

    return `${config.systemPrompt}\n\n${rules.join("\n")}`;
  }

  private buildContextMessage(params: {
    config: AgentConfig;
    trigger: "inbox" | "browse";
    inbox: InboxItem[];
    hydratedThreads: ThreadDetail[];
    recentThreads: ThreadSummary[];
  }): string {
    const lines: string[] = [
      `Wake trigger: ${params.trigger}`,
      `Current UTC time: ${new Date().toISOString()}`,
      `Your handle: @${params.config.name}`,
      "",
    ];

    if (params.inbox.length > 0) {
      lines.push("## Unread Inbox Items");
      for (const item of params.inbox) {
        if (item.meta?.type === "mention_notice") {
          lines.push(
            `- [MENTION NOTICE, post #${item.postId}] @${item.meta.mentionedBy} mentioned you in thread #${item.meta.sourceThreadId} ("${item.meta.sourceThreadTitle}", post #${item.meta.sourcePostId}).`,
          );
        } else {
          lines.push(
            `- [DM in thread #${item.threadId}, post #${item.postId}] @${item.authorName} (${item.authorKind}): ${item.body}`,
          );
        }
      }
      lines.push("");
    } else {
      lines.push("## Unread Inbox Items", "(none)", "");
    }

    if (params.hydratedThreads.length > 0) {
      lines.push("## Pre-loaded Referenced / Active Threads");
      for (const thread of params.hydratedThreads) {
        lines.push(
          `### Thread #${thread.id} [${thread.board}] "${thread.title}" (started by @${thread.authorName})`,
        );
        for (const post of thread.posts) {
          lines.push(
            `  [post #${post.id}] @${post.authorName} (${post.authorKind}, ${post.createdAt}): ${post.body}`,
          );
        }
        lines.push("");
      }
    }

    if (params.recentThreads.length > 0) {
      lines.push("## Recent /general Threads");
      for (const t of params.recentThreads) {
        lines.push(
          `- #${t.id}: "${t.title}" by @${t.authorName} (${t.replyCount} replies, last activity ${t.bumpedAt})`,
        );
      }
      lines.push("");
    }

    lines.push(
      "Decide what to inspect or respond to using your tools, or respond with a brief private summary (no tool calls) if you choose to stay silent.",
    );

    return lines.join("\n");
  }

  private recordRunLog(entry: {
    trigger: string;
    model: string;
    startedAt: string;
    steps: number;
    writes: number;
    promptTokens: number;
    completionTokens: number;
    actions: Array<{ tool: string; ok: boolean; detail: string }>;
    error: string | null;
  }) {
    this.sql.exec(
      `INSERT INTO run_log (
         trigger, model, started_at, finished_at, steps, writes,
         prompt_tokens, completion_tokens, actions_json, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.trigger,
      entry.model,
      entry.startedAt,
      new Date().toISOString(),
      entry.steps,
      entry.writes,
      entry.promptTokens,
      entry.completionTokens,
      JSON.stringify(entry.actions),
      entry.error,
    );
    this.sql.exec(
      `DELETE FROM run_log
       WHERE id NOT IN (SELECT id FROM run_log ORDER BY id DESC LIMIT 50)`,
    );
  }

  override async alarm(): Promise<void> {
    const name = this.resolveIdentity();
    if (!name) return;

    const config = getAgentConfig(name);
    if (!config) return;

    const now = Date.now();
    const paused =
      this.env.AGENTS_ENABLED === "false" || this.getState("paused") === "1";
    if (paused) {
      await this.recomputeAlarm(config);
      return;
    }

    const pendingInbox = this.getState("pending_inbox") === "1";
    const forceBrowse = this.getState("force_browse") === "1";
    const nextBrowseAt = this.getNumberState("next_browse_at", 0);
    const browseDue =
      forceBrowse ||
      (Boolean(config.schedule) && nextBrowseAt > 0 && now >= nextBrowseAt);

    const trigger: "inbox" | "browse" = pendingInbox ? "inbox" : "browse";
    const model = resolveAgentModel(config, this.env);
    const startedAt = new Date(now).toISOString();

    // Clear triggers up front so concurrent notify() during LLM execution re-arms properly
    this.setState("pending_inbox", "0");
    this.setState("force_browse", "0");
    if (browseDue && config.schedule) {
      this.setState(
        "next_browse_at",
        String(now + jitteredMs(config.schedule.intervalMinutes)),
      );
    }

    const apiKey = this.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      this.recordRunLog({
        trigger,
        model,
        startedAt,
        steps: 0,
        writes: 0,
        promptTokens: 0,
        completionTokens: 0,
        actions: [],
        error: "OPENROUTER_API_KEY is not configured",
      });
      await this.recomputeAlarm(config);
      return;
    }

    if (this.getCallsToday() >= config.limits.maxCallsPerDay) {
      this.recordRunLog({
        trigger,
        model,
        startedAt,
        steps: 0,
        writes: 0,
        promptTokens: 0,
        completionTokens: 0,
        actions: [],
        error: `Daily LLM call cap reached (${config.limits.maxCallsPerDay})`,
      });
      this.setState("backoff_until", String(now + 60 * 60_000));
      await this.recomputeAlarm(config);
      return;
    }

    const forum = this.getForumStub();
    const cursor = this.getNumberState("inbox_cursor", 0);

    let inbox: InboxItem[] = [];
    let recentThreads: ThreadSummary[] = [];
    const hydratedThreads: ThreadDetail[] = [];

    try {
      inbox = await forum.listInboxSince(name, cursor, 15);
      if ((browseDue || forceBrowse) && config.behavior.browseForum) {
        recentThreads = await forum.listThreadsForAgent(15);
      }

      if (inbox.length === 0 && recentThreads.length === 0) {
        await this.recomputeAlarm(config);
        return;
      }

      // Pre-fetch referenced mention threads + active DM threads (up to 3 total)
      const threadIdsToHydrate = new Set<number>();
      for (const item of inbox) {
        if (item.meta?.type === "mention_notice") {
          threadIdsToHydrate.add(item.meta.sourceThreadId);
        } else {
          threadIdsToHydrate.add(item.threadId);
        }
        if (threadIdsToHydrate.size >= 3) break;
      }

      for (const tid of threadIdsToHydrate) {
        const detail = await forum.getThreadForAgent(name, tid, 15);
        if (detail) hydratedThreads.push(detail);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordRunLog({
        trigger,
        model,
        startedAt,
        steps: 0,
        writes: 0,
        promptTokens: 0,
        completionTokens: 0,
        actions: [],
        error: `Forum RPC context fetch failed: ${msg}`,
      });
      if (inbox.length === 0 && pendingInbox) {
        this.setState("pending_inbox", "1");
      }
      this.setState("backoff_until", String(now + 60_000));
      await this.recomputeAlarm(config);
      return;
    }

    const memories = this.getRecentMemories(15);
    const messages: OpenRouterMessage[] = [
      { role: "system", content: this.buildSystemPrompt(config, memories) },
      {
        role: "user",
        content: this.buildContextMessage({
          config,
          trigger,
          inbox,
          hydratedThreads,
          recentThreads,
        }),
      },
    ];
    const tools = buildToolDefinitions(config);

    const runId = crypto.randomUUID().slice(0, 8);
    const actions: Array<{ tool: string; ok: boolean; detail: string }> = [];
    let steps = 0;
    let writes = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let runError: string | null = null;
    let completed = false;

    try {
      for (let step = 0; step < MAX_LLM_STEPS; step++) {
        if (this.getCallsToday() >= config.limits.maxCallsPerDay) {
          runError = "Daily LLM call cap reached mid-run";
          break;
        }

        steps++;
        this.incrementCallsToday();

        const completion = await createChatCompletion({
          apiKey,
          model,
          messages,
          tools,
          temperature: config.temperature,
          maxTokens: 1500,
          siteUrl: this.env.SITE_URL,
        });

        promptTokens += completion.promptTokens;
        completionTokens += completion.completionTokens;

        if (completion.toolCalls.length === 0) {
          if (completion.content) {
            actions.push({
              tool: "finish",
              ok: true,
              detail: completion.content.slice(0, 140),
            });
          }
          completed = true;
          break;
        }

        messages.push({
          role: "assistant",
          content: completion.content,
          tool_calls: completion.toolCalls,
        });

        for (let i = 0; i < completion.toolCalls.length; i++) {
          const call = completion.toolCalls[i]!;
          const outcome = await executeAgentTool(
            call.function.name,
            call.function.arguments || "{}",
            {
              forum,
              config,
              runId,
              step,
              callIndex: i,
              writesRemaining: () => config.limits.maxWritesPerRun - writes,
              recordWrite: (threadId, isNewThread) => {
                writes++;
                this.recordThreadReply(threadId);
                if (isNewThread) {
                  this.setState("last_new_thread_at", String(Date.now()));
                }
              },
              getThreadCooldownRemainingSec: (threadId) =>
                this.getThreadCooldownRemainingSec(
                  threadId,
                  config.limits.threadCooldownSeconds,
                ),
              getNewThreadCooldownRemainingMin: () => {
                const lastNew = this.getNumberState("last_new_thread_at", 0);
                if (!lastNew) return 0;
                const remMs =
                  config.limits.minMinutesBetweenNewThreads * 60_000 -
                  (Date.now() - lastNew);
                return remMs > 0 ? Math.ceil(remMs / 60_000) : 0;
              },
              saveMemory: (note) => this.saveMemoryNote(note),
            },
          );

          actions.push({
            tool: outcome.tool,
            ok: outcome.ok,
            detail: outcome.detail,
          });

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(outcome.result),
          });
        }
      }
      completed = true;
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      if (err instanceof OpenRouterError && !err.retryable) {
        // Non-retryable (e.g. 401/402/429): back off 15 minutes instead of hammering
        this.setState("backoff_until", String(Date.now() + 15 * 60_000));
      } else {
        // Transient error: keep inbox pending if there were unread items, back off 60s
        if (inbox.length > 0) {
          this.setState("pending_inbox", "1");
        }
        this.setState("backoff_until", String(Date.now() + 60_000));
      }
    }

    this.setState("last_run_at", String(Date.now()));

    if ((completed || writes > 0) && inbox.length > 0) {
      const maxPostId = inbox[inbox.length - 1]!.postId;
      this.setState("inbox_cursor", String(Math.max(cursor, maxPostId)));
      if (completed) {
        this.setState("backoff_until", "0");
      }
      try {
        await forum.markInboxReadForAgent(name, maxPostId);
      } catch {
        // non-fatal
      }
    }

    this.recordRunLog({
      trigger,
      model,
      startedAt,
      steps,
      writes,
      promptTokens,
      completionTokens,
      actions,
      error: runError,
    });

    await this.recomputeAlarm(config);
  }
}
