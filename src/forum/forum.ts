import { DurableObject } from "cloudflare:workers";
import type {
  BoardKind,
  ForumEvent,
  InboxItem,
  MessageSummary,
  Post,
  PostMeta,
  ThreadDetail,
  ThreadSummary,
  User,
  UserKind,
} from "../shared/types";
import {
  agentUserId,
  extractMentions,
  isValidHandle,
  makeDmKey,
  normalizeHandle,
  OWNER_USER_ID,
  RESERVED_HANDLES,
  SYSTEM_HANDLE,
  SYSTEM_USER_ID,
} from "../shared/handles";
import { AGENT_NAMES } from "../agents/personalities";
import { generateUniqueDisplayName } from "./names";
import type { Agent } from "../agents/agent";

export type ForumEnv = {
  FORUM: DurableObjectNamespace<Forum>;
  AGENTS: DurableObjectNamespace<Agent>;
  AGENTS_ENABLED?: string;
};

type PostRow = {
  id: number;
  threadId: number;
  body: string;
  authorId: string;
  authorName: string;
  authorKind: UserKind;
  createdAt: string;
  metaJson: string | null;
};

function parseMeta(raw: string | null): PostMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PostMeta;
  } catch {
    return null;
  }
}

function mapPostRow(row: PostRow): Post {
  return {
    id: row.id,
    threadId: row.threadId,
    body: row.body,
    authorId: row.authorId,
    authorName: row.authorName,
    authorKind: row.authorKind,
    createdAt: row.createdAt,
    meta: parseMeta(row.metaJson),
  };
}

/**
 * Single source of truth for the forum ("general" board + "messages" DMs).
 * Uses a transactional SQLite outbox + DO alarm to reliably wake Agent DOs.
 */
export class Forum extends DurableObject<ForumEnv> {
  private sql = this.ctx.storage.sql;
  private flushing = false;
  private flushQueued = false;

  constructor(ctx: DurableObjectState, env: ForumEnv) {
    super(ctx, env);
    this.migrate();
    this.ensureSystemAndAgents();
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const versionRow = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM schema_meta WHERE key = 'version'`,
      )
      .toArray()[0];
    let version = versionRow ? Number(versionRow.value) : 0;

    if (version < 2) {
      this.migrateToThreads();
      this.setSchemaVersion(2);
      version = 2;
    }

    if (version < 3) {
      this.ctx.storage.transactionSync(() => {
        this.migrateToMultiAgent();
        this.setSchemaVersion(3);
      });
    }
  }

  private setSchemaVersion(version: number) {
    this.sql.exec(
      `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(version),
    );
  }

  private hasColumn(table: string, column: string): boolean {
    const cols = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    return cols.some((c) => c.name === column);
  }

  private migrateToThreads() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        bumped_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);

    const tables = this.sql
      .exec<{ name: string }>(`PRAGMA table_list`)
      .toArray()
      .map((t) => t.name);

    if (tables.includes("posts")) {
      if (this.hasColumn("posts", "title")) {
        this.sql.exec(`ALTER TABLE posts RENAME TO posts_legacy`);
        this.sql.exec(`
          CREATE TABLE posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (thread_id) REFERENCES threads(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
          );
        `);

        const legacy = this.sql
          .exec<{
            id: number;
            user_id: string;
            title: string;
            body: string;
            created_at: string;
          }>(
            `SELECT id, user_id, title, body, created_at FROM posts_legacy ORDER BY id ASC`,
          )
          .toArray();

        for (const row of legacy) {
          this.sql.exec(
            `INSERT INTO threads (user_id, title, created_at, bumped_at)
             VALUES (?, ?, ?, ?)`,
            row.user_id,
            row.title,
            row.created_at,
            row.created_at,
          );
          const thread = this.sql
            .exec<{ id: number }>(
              `SELECT id FROM threads ORDER BY id DESC LIMIT 1`,
            )
            .one();
          this.sql.exec(
            `INSERT INTO posts (thread_id, user_id, body, created_at)
             VALUES (?, ?, ?, ?)`,
            thread.id,
            row.user_id,
            row.body,
            row.created_at,
          );
        }

        this.sql.exec(`DROP TABLE posts_legacy`);
      }
    } else {
      this.sql.exec(`
        CREATE TABLE posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (thread_id) REFERENCES threads(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `);
    }

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_threads_bumped ON threads(bumped_at DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, id ASC);
    `);
  }

  private migrateToMultiAgent() {
    // 1. Add users.kind and normalize/deduplicate existing usernames
    if (!this.hasColumn("users", "kind")) {
      this.sql.exec(
        `ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'`,
      );
    }

    const reserved = new Set<string>([
      ...RESERVED_HANDLES,
      ...AGENT_NAMES.map((n) => n.toLowerCase()),
    ]);
    const existingUsers = this.sql
      .exec<{ id: string; name: string; kind: string }>(
        `SELECT id, name, kind FROM users ORDER BY created_at ASC, id ASC`,
      )
      .toArray();

    const taken = new Set<string>();
    for (const row of existingUsers) {
      const isSystem = row.id === SYSTEM_USER_ID;
      const isAgent = row.id.startsWith("agent:");
      let candidate = normalizeHandle(row.name);

      if (!isSystem && !isAgent) {
        if (!isValidHandle(candidate) || reserved.has(candidate)) {
          candidate = `user-${row.id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`;
        }
        let unique = candidate;
        let suffix = 2;
        while (taken.has(unique) || reserved.has(unique)) {
          const base = candidate.slice(0, 20);
          unique = `${base}-${suffix++}`;
        }
        candidate = unique;
      }

      taken.add(candidate);
      if (candidate !== row.name) {
        this.sql.exec(
          `UPDATE users SET name = ? WHERE id = ?`,
          candidate,
          row.id,
        );
      }
    }

    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_nocase
        ON users(name COLLATE NOCASE);
    `);

    // 2. Extend threads with board + canonical dm_key
    if (!this.hasColumn("threads", "board")) {
      this.sql.exec(
        `ALTER TABLE threads ADD COLUMN board TEXT NOT NULL DEFAULT 'general'`,
      );
    }
    if (!this.hasColumn("threads", "dm_key")) {
      this.sql.exec(`ALTER TABLE threads ADD COLUMN dm_key TEXT`);
    }

    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_dm_key
        ON threads(dm_key) WHERE dm_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_threads_board_bumped
        ON threads(board, bumped_at DESC, id DESC);
    `);

    // 3. Extend posts with structured metadata + idempotency key
    if (!this.hasColumn("posts", "meta_json")) {
      this.sql.exec(`ALTER TABLE posts ADD COLUMN meta_json TEXT`);
    }
    if (!this.hasColumn("posts", "operation_id")) {
      this.sql.exec(`ALTER TABLE posts ADD COLUMN operation_id TEXT`);
    }

    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_operation_id
        ON posts(operation_id) WHERE operation_id IS NOT NULL;
    `);

    // 4. Thread participants for DMs & unread tracking
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS thread_participants (
        thread_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        last_read_post_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, user_id),
        FOREIGN KEY (thread_id) REFERENCES threads(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_participants_user
        ON thread_participants(user_id, thread_id);
    `);

    // 5. Transactional event outbox for reliable agent wake-ups
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private ensureSystemAndAgents() {
    this.sql.exec(
      `INSERT INTO users (id, name, kind) VALUES (?, ?, 'system')
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = 'system'`,
      SYSTEM_USER_ID,
      SYSTEM_HANDLE,
    );

    for (const rawName of AGENT_NAMES) {
      const name = rawName.toLowerCase();
      const id = agentUserId(name);
      this.sql.exec(
        `INSERT INTO users (id, name, kind) VALUES (?, ?, 'agent')
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = 'agent'`,
        id,
        name,
      );
    }
  }

  private isHandleTaken(candidate: string): boolean {
    const lower = candidate.toLowerCase();
    if (RESERVED_HANDLES.has(lower)) return true;
    const row = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM users WHERE name = ? COLLATE NOCASE LIMIT 1`,
        lower,
      )
      .toArray()[0];
    return Boolean(row);
  }

  private getUserById(userId: string): User | null {
    return (
      this.sql
        .exec<User>(`SELECT id, name, kind FROM users WHERE id = ?`, userId)
        .toArray()[0] ?? null
    );
  }

  private getUserByName(name: string): User | null {
    const normalized = normalizeHandle(name);
    if (!normalized) return null;
    return (
      this.sql
        .exec<User>(
          `SELECT id, name, kind FROM users WHERE name = ? COLLATE NOCASE`,
          normalized,
        )
        .toArray()[0] ?? null
    );
  }

  ensureUser(userId: string): User {
    const existing = this.getUserById(userId);
    if (existing) return existing;

    const name = generateUniqueDisplayName((candidate) =>
      this.isHandleTaken(candidate),
    );
    this.sql.exec(
      `INSERT INTO users (id, name, kind) VALUES (?, ?, 'human')`,
      userId,
      name,
    );
    return { id: userId, name, kind: "human" };
  }

  ensureOwner(desiredHandle: string): User {
    const normalized = normalizeHandle(desiredHandle);
    const agentSet = new Set(AGENT_NAMES.map((n) => n.toLowerCase()));
    const safeHandle =
      isValidHandle(normalized) &&
      !RESERVED_HANDLES.has(normalized) &&
      !agentSet.has(normalized)
        ? normalized
        : "owner";

    const existing = this.getUserById(OWNER_USER_ID);
    const conflict = this.sql
      .exec<{ id: string; kind: UserKind }>(
        `SELECT id, kind FROM users WHERE name = ? COLLATE NOCASE AND id != ?`,
        safeHandle,
        OWNER_USER_ID,
      )
      .toArray()[0];

    if (existing) {
      if (existing.name.toLowerCase() === safeHandle) {
        return existing;
      }
      if (!conflict) {
        this.sql.exec(
          `UPDATE users SET name = ? WHERE id = ?`,
          safeHandle,
          OWNER_USER_ID,
        );
        return { ...existing, name: safeHandle };
      }
      return existing;
    }

    if (conflict && conflict.kind === "human") {
      // Displace an older anonymous handle so the owner gets their configured handle
      const fallback = generateUniqueDisplayName(
        (candidate) =>
          candidate === safeHandle || this.isHandleTaken(candidate),
      );
      this.sql.exec(
        `UPDATE users SET name = ? WHERE id = ?`,
        fallback,
        conflict.id,
      );
    }

    const finalHandle =
      conflict && conflict.kind !== "human" ? "owner" : safeHandle;

    this.sql.exec(
      `INSERT INTO users (id, name, kind) VALUES (?, ?, 'human')`,
      OWNER_USER_ID,
      finalHandle,
    );
    return { id: OWNER_USER_ID, name: finalHandle, kind: "human" };
  }

  private getOrCreateDMInTx(userA: User, userB: User): number {
    const dmKey = makeDmKey(userA.id, userB.id);
    const existing = this.sql
      .exec<{ id: number }>(`SELECT id FROM threads WHERE dm_key = ?`, dmKey)
      .toArray()[0];

    if (existing) {
      return existing.id;
    }

    const title =
      userA.id === SYSTEM_USER_ID || userB.id === SYSTEM_USER_ID
        ? "Notifications"
        : `DM: @${[userA.name, userB.name].sort().join(" ↔ @")}`;

    this.sql.exec(
      `INSERT INTO threads (board, dm_key, user_id, title)
       VALUES ('messages', ?, ?, ?)`,
      dmKey,
      userA.id,
      title,
    );

    const thread = this.sql
      .exec<{ id: number }>(`SELECT id FROM threads WHERE dm_key = ?`, dmKey)
      .one();

    this.sql.exec(
      `INSERT OR IGNORE INTO thread_participants (thread_id, user_id, last_read_post_id)
       VALUES (?, ?, 0), (?, ?, 0)`,
      thread.id,
      userA.id,
      thread.id,
      userB.id,
    );

    return thread.id;
  }

  private enqueueEventInTx(event: ForumEvent) {
    this.sql.exec(
      `INSERT INTO event_outbox (event_json) VALUES (?)`,
      JSON.stringify(event),
    );
  }

  /**
   * Shared post-processing inside the active SQLite transaction:
   * - In 'general': @mentions create a @system notification DM + agent event.
   * - In 'messages': notifies other agent participant(s) directly (no 3rd-party leak).
   */
  private postProcessPostInTx(params: {
    board: BoardKind;
    threadId: number;
    threadTitle: string;
    postId: number;
    author: User;
    body: string;
  }): boolean {
    if (params.author.kind === "system") {
      return false;
    }

    let enqueued = false;

    if (params.board === "general") {
      const handles = extractMentions(params.body, 5);
      if (handles.length === 0) return false;

      const systemUser = this.getUserById(SYSTEM_USER_ID);
      if (!systemUser) return false;

      for (const handle of handles) {
        if (handle === SYSTEM_HANDLE) continue;
        const target = this.getUserByName(handle);
        if (!target || target.id === params.author.id || target.kind === "system") {
          continue;
        }

        const dmThreadId = this.getOrCreateDMInTx(systemUser, target);
        const noticeBody = [
          `You were mentioned by @${params.author.name} in "${params.threadTitle}".`,
          `Reference: #/thread/${params.threadId}?post=${params.postId}`,
        ].join("\n");
        const meta: PostMeta = {
          type: "mention_notice",
          sourceThreadId: params.threadId,
          sourcePostId: params.postId,
          sourceThreadTitle: params.threadTitle,
          mentionedBy: params.author.name,
        };

        this.sql.exec(
          `INSERT INTO posts (thread_id, user_id, body, meta_json)
           VALUES (?, ?, ?, ?)`,
          dmThreadId,
          SYSTEM_USER_ID,
          noticeBody,
          JSON.stringify(meta),
        );

        const noticePost = this.sql
          .exec<{ id: number }>(
            `SELECT id FROM posts WHERE thread_id = ? ORDER BY id DESC LIMIT 1`,
            dmThreadId,
          )
          .one();

        this.sql.exec(
          `UPDATE threads SET bumped_at = datetime('now') WHERE id = ?`,
          dmThreadId,
        );

        if (target.kind === "agent") {
          this.enqueueEventInTx({
            type: "dm.received",
            recipient: target.name,
            threadId: dmThreadId,
            postId: noticePost.id,
          });
          enqueued = true;
        }
      }
      return enqueued;
    }

    // board === 'messages': notify other agent participants directly
    const others = this.sql
      .exec<User>(
        `SELECT u.id, u.name, u.kind
         FROM thread_participants tp
         JOIN users u ON u.id = tp.user_id
         WHERE tp.thread_id = ? AND tp.user_id != ?`,
        params.threadId,
        params.author.id,
      )
      .toArray();

    for (const other of others) {
      if (other.kind === "agent") {
        this.enqueueEventInTx({
          type: "dm.received",
          recipient: other.name,
          threadId: params.threadId,
          postId: params.postId,
        });
        enqueued = true;
      }
    }

    return enqueued;
  }

  private scheduleOutboxFlush() {
    if (this.flushing) {
      this.flushQueued = true;
      return;
    }
    this.ctx.waitUntil(this.flushOutbox());
  }

  async flushOutbox(): Promise<void> {
    if (this.flushing) {
      this.flushQueued = true;
      return;
    }
    this.flushing = true;

    try {
      do {
        this.flushQueued = false;
        const rows = this.sql
          .exec<{ id: number; event_json: string; attempts: number }>(
            `SELECT id, event_json, attempts
             FROM event_outbox
             ORDER BY id ASC
             LIMIT 25`,
          )
          .toArray();

        if (rows.length === 0) break;

        let maxAttempts = 0;
        let hadFailure = false;

        for (const row of rows) {
          let event: ForumEvent;
          try {
            event = JSON.parse(row.event_json) as ForumEvent;
          } catch {
            this.sql.exec(`DELETE FROM event_outbox WHERE id = ?`, row.id);
            continue;
          }

          if (this.env.AGENTS_ENABLED === "false") {
            // Drain notifications without waking agents while globally paused
            this.sql.exec(`DELETE FROM event_outbox WHERE id = ?`, row.id);
            continue;
          }

          try {
            const stub = this.env.AGENTS.getByName(event.recipient.toLowerCase());
            await stub.notify(event);
            this.sql.exec(`DELETE FROM event_outbox WHERE id = ?`, row.id);
          } catch (err) {
            const nextAttempts = row.attempts + 1;
            console.error(
              `[Forum] Failed to dispatch event #${row.id} to @${event.recipient} (attempt ${nextAttempts}):`,
              err,
            );
            if (nextAttempts >= 8) {
              this.sql.exec(`DELETE FROM event_outbox WHERE id = ?`, row.id);
            } else {
              this.sql.exec(
                `UPDATE event_outbox SET attempts = ? WHERE id = ?`,
                nextAttempts,
                row.id,
              );
              hadFailure = true;
              maxAttempts = Math.max(maxAttempts, nextAttempts);
            }
          }
        }

        if (hadFailure) {
          const delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(maxAttempts, 5));
          await this.ctx.storage.setAlarm(Date.now() + delayMs);
          break;
        }
      } while (this.flushQueued);
    } finally {
      this.flushing = false;
    }
  }

  override async alarm(): Promise<void> {
    await this.flushOutbox();
  }

  private getPostByOperationId(operationId: string): Post | null {
    const row = this.sql
      .exec<PostRow>(
        `SELECT
           p.id AS id,
           p.thread_id AS threadId,
           p.body AS body,
           p.user_id AS authorId,
           u.name AS authorName,
           u.kind AS authorKind,
           p.created_at AS createdAt,
           p.meta_json AS metaJson
         FROM posts p
         JOIN users u ON u.id = p.user_id
         WHERE p.operation_id = ?
         LIMIT 1`,
        operationId,
      )
      .toArray()[0];
    return row ? mapPostRow(row) : null;
  }

  private isParticipant(threadId: number, userId: string): boolean {
    const row = this.sql
      .exec<{ thread_id: number }>(
        `SELECT thread_id FROM thread_participants WHERE thread_id = ? AND user_id = ?`,
        threadId,
        userId,
      )
      .toArray()[0];
    return Boolean(row);
  }

  private getCounterparty(threadId: number, viewerId: string): User | null {
    return (
      this.sql
        .exec<User>(
          `SELECT u.id, u.name, u.kind
           FROM thread_participants tp
           JOIN users u ON u.id = tp.user_id
           WHERE tp.thread_id = ? AND tp.user_id != ?
           LIMIT 1`,
          threadId,
          viewerId,
        )
        .toArray()[0] ?? null
    );
  }

  countUnreadMessages(userId: string): number {
    const row = this.sql
      .exec<{ total: number }>(
        `SELECT COUNT(*) AS total
         FROM thread_participants tp
         JOIN threads t ON t.id = tp.thread_id
         JOIN posts p ON p.thread_id = tp.thread_id
         WHERE tp.user_id = ?
           AND t.board = 'messages'
           AND p.id > tp.last_read_post_id
           AND p.user_id != ?`,
        userId,
        userId,
      )
      .toArray()[0];
    return row?.total ?? 0;
  }

  listThreads(limit = 100): ThreadSummary[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    return this.sql
      .exec<ThreadSummary>(
        `SELECT
           t.id AS id,
           t.board AS board,
           t.title AS title,
           t.user_id AS authorId,
           u.name AS authorName,
           u.kind AS authorKind,
           t.created_at AS createdAt,
           t.bumped_at AS bumpedAt,
           MAX(0, (SELECT COUNT(*) - 1 FROM posts p WHERE p.thread_id = t.id)) AS replyCount
         FROM threads t
         JOIN users u ON u.id = t.user_id
         WHERE t.board = 'general'
         ORDER BY t.bumped_at DESC, t.id DESC
         LIMIT ?`,
        safeLimit,
      )
      .toArray();
  }

  listMessages(userId: string): MessageSummary[] {
    const rows = this.sql
      .exec<{
        id: number;
        board: BoardKind;
        title: string;
        authorId: string;
        authorName: string;
        authorKind: UserKind;
        createdAt: string;
        bumpedAt: string;
        messageCount: number;
        unreadCount: number;
        lastBody: string | null;
      }>(
        `SELECT
           t.id AS id,
           t.board AS board,
           t.title AS title,
           t.user_id AS authorId,
           u.name AS authorName,
           u.kind AS authorKind,
           t.created_at AS createdAt,
           t.bumped_at AS bumpedAt,
           (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id) AS messageCount,
           (SELECT COUNT(*) FROM posts p
            WHERE p.thread_id = t.id
              AND p.id > tp.last_read_post_id
              AND p.user_id != ?) AS unreadCount,
           (SELECT p.body FROM posts p
            WHERE p.thread_id = t.id
            ORDER BY p.id DESC LIMIT 1) AS lastBody
         FROM thread_participants tp
         JOIN threads t ON t.id = tp.thread_id
         JOIN users u ON u.id = t.user_id
         WHERE tp.user_id = ? AND t.board = 'messages'
         ORDER BY t.bumped_at DESC, t.id DESC
         LIMIT 100`,
        userId,
        userId,
      )
      .toArray();

    return rows.map((row) => {
      const counterparty = this.getCounterparty(row.id, userId);
      const preview = (row.lastBody || "").replace(/\s+/g, " ").trim().slice(0, 120);
      return {
        id: row.id,
        board: "messages",
        title:
          counterparty?.kind === "system"
            ? "Notifications"
            : counterparty
              ? `@${counterparty.name}`
              : row.title,
        authorId: row.authorId,
        authorName: row.authorName,
        authorKind: row.authorKind,
        createdAt: row.createdAt,
        bumpedAt: row.bumpedAt,
        replyCount: Math.max(0, row.messageCount - 1),
        messageCount: row.messageCount,
        unreadCount: row.unreadCount,
        counterparty,
        lastMessagePreview: preview,
        readOnly: counterparty?.kind === "system",
      };
    });
  }

  getThread(
    threadId: number,
    viewerId: string,
    opts?: { markRead?: boolean; maxPosts?: number },
  ): ThreadDetail | null {
    const thread = this.sql
      .exec<ThreadSummary>(
        `SELECT
           t.id AS id,
           t.board AS board,
           t.title AS title,
           t.user_id AS authorId,
           u.name AS authorName,
           u.kind AS authorKind,
           t.created_at AS createdAt,
           t.bumped_at AS bumpedAt,
           MAX(0, (SELECT COUNT(*) - 1 FROM posts p WHERE p.thread_id = t.id)) AS replyCount
         FROM threads t
         JOIN users u ON u.id = t.user_id
         WHERE t.id = ?`,
        threadId,
      )
      .toArray()[0];

    if (!thread) return null;

    let counterparty: User | null | undefined;
    let readOnly: boolean | undefined;

    if (thread.board === "messages") {
      if (!this.isParticipant(threadId, viewerId)) {
        return null;
      }
      counterparty = this.getCounterparty(threadId, viewerId);
      readOnly = counterparty?.kind === "system";
      if (counterparty) {
        thread.title =
          counterparty.kind === "system"
            ? "Notifications"
            : `DM with @${counterparty.name}`;
      }
    }

    const postRows = opts?.maxPosts
      ? this.sql
          .exec<PostRow>(
            `SELECT * FROM (
               SELECT
                 p.id AS id,
                 p.thread_id AS threadId,
                 p.body AS body,
                 p.user_id AS authorId,
                 u.name AS authorName,
                 u.kind AS authorKind,
                 p.created_at AS createdAt,
                 p.meta_json AS metaJson
               FROM posts p
               JOIN users u ON u.id = p.user_id
               WHERE p.thread_id = ?
               ORDER BY p.id DESC
               LIMIT ?
             ) ORDER BY id ASC`,
            threadId,
            Math.max(1, Math.min(opts.maxPosts, 200)),
          )
          .toArray()
      : this.sql
          .exec<PostRow>(
            `SELECT
               p.id AS id,
               p.thread_id AS threadId,
               p.body AS body,
               p.user_id AS authorId,
               u.name AS authorName,
               u.kind AS authorKind,
               p.created_at AS createdAt,
               p.meta_json AS metaJson
             FROM posts p
             JOIN users u ON u.id = p.user_id
             WHERE p.thread_id = ?
             ORDER BY p.id ASC`,
            threadId,
          )
          .toArray();

    const posts = postRows.map(mapPostRow);

    if (opts?.markRead && thread.board === "messages" && posts.length > 0) {
      const latestId = posts[posts.length - 1]!.id;
      this.sql.exec(
        `UPDATE thread_participants
         SET last_read_post_id = MAX(last_read_post_id, ?)
         WHERE thread_id = ? AND user_id = ?`,
        latestId,
        threadId,
        viewerId,
      );
    }

    return {
      ...thread,
      posts,
      ...(counterparty !== undefined ? { counterparty } : {}),
      ...(readOnly !== undefined ? { readOnly } : {}),
    };
  }

  createThread(
    userId: string,
    title: string,
    body: string,
    operationId?: string,
  ): ThreadDetail {
    const cleanTitle = title.trim().slice(0, 120);
    const cleanBody = body.trim().slice(0, 5000);
    if (!cleanTitle || !cleanBody) {
      throw new Error("Title and body are required");
    }

    if (operationId) {
      const existing = this.getPostByOperationId(operationId);
      if (existing) {
        const detail = this.getThread(existing.threadId, userId);
        if (detail) return detail;
      }
    }

    let threadId = 0;
    let shouldFlush = false;

    this.ctx.storage.transactionSync(() => {
      const author = this.ensureUser(userId);
      this.sql.exec(
        `INSERT INTO threads (board, user_id, title) VALUES ('general', ?, ?)`,
        author.id,
        cleanTitle,
      );
      const threadRow = this.sql
        .exec<{ id: number }>(`SELECT id FROM threads ORDER BY id DESC LIMIT 1`)
        .one();
      threadId = threadRow.id;

      this.sql.exec(
        `INSERT INTO posts (thread_id, user_id, body, operation_id)
         VALUES (?, ?, ?, ?)`,
        threadId,
        author.id,
        cleanBody,
        operationId ?? null,
      );
      const postRow = this.sql
        .exec<{ id: number }>(
          `SELECT id FROM posts WHERE thread_id = ? ORDER BY id DESC LIMIT 1`,
          threadId,
        )
        .one();

      shouldFlush = this.postProcessPostInTx({
        board: "general",
        threadId,
        threadTitle: cleanTitle,
        postId: postRow.id,
        author,
        body: cleanBody,
      });
    });

    if (shouldFlush) {
      this.scheduleOutboxFlush();
    }

    const detail = this.getThread(threadId, userId);
    if (!detail) throw new Error("Failed to create thread");
    return detail;
  }

  replyToThread(
    userId: string,
    threadId: number,
    body: string,
    operationId?: string,
  ): Post {
    const cleanBody = body.trim().slice(0, 5000);
    if (!cleanBody) {
      throw new Error("Body is required");
    }

    if (operationId) {
      const existing = this.getPostByOperationId(operationId);
      if (existing) return existing;
    }

    const thread = this.sql
      .exec<{ id: number; board: BoardKind; title: string }>(
        `SELECT id, board, title FROM threads WHERE id = ?`,
        threadId,
      )
      .toArray()[0];

    if (!thread) {
      throw new Error("Thread not found");
    }

    if (thread.board === "messages") {
      if (!this.isParticipant(threadId, userId)) {
        throw new Error("Thread not found");
      }
      const counterparty = this.getCounterparty(threadId, userId);
      if (counterparty?.kind === "system") {
        throw new Error("Notifications thread is read-only");
      }
    }

    let createdPost!: Post;
    let shouldFlush = false;

    this.ctx.storage.transactionSync(() => {
      const author = this.ensureUser(userId);
      this.sql.exec(
        `INSERT INTO posts (thread_id, user_id, body, operation_id)
         VALUES (?, ?, ?, ?)`,
        threadId,
        author.id,
        cleanBody,
        operationId ?? null,
      );
      this.sql.exec(
        `UPDATE threads SET bumped_at = datetime('now') WHERE id = ?`,
        threadId,
      );

      const row = this.sql
        .exec<{ id: number; createdAt: string }>(
          `SELECT id, created_at AS createdAt
           FROM posts
           WHERE thread_id = ?
           ORDER BY id DESC
           LIMIT 1`,
          threadId,
        )
        .one();

      if (thread.board === "messages") {
        this.sql.exec(
          `UPDATE thread_participants
           SET last_read_post_id = MAX(last_read_post_id, ?)
           WHERE thread_id = ? AND user_id = ?`,
          row.id,
          threadId,
          author.id,
        );
      }

      shouldFlush = this.postProcessPostInTx({
        board: thread.board,
        threadId,
        threadTitle: thread.title,
        postId: row.id,
        author,
        body: cleanBody,
      });

      createdPost = {
        id: row.id,
        threadId,
        body: cleanBody,
        authorId: author.id,
        authorName: author.name,
        authorKind: author.kind,
        createdAt: row.createdAt,
        meta: null,
      };
    });

    if (shouldFlush) {
      this.scheduleOutboxFlush();
    }

    return createdPost;
  }

  sendDM(
    senderUserId: string,
    recipientHandle: string,
    body: string,
    operationId?: string,
  ): { threadId: number; post: Post } {
    const cleanBody = body.trim().slice(0, 5000);
    if (!cleanBody) {
      throw new Error("Message body is required");
    }

    if (operationId) {
      const existing = this.getPostByOperationId(operationId);
      if (existing) {
        return { threadId: existing.threadId, post: existing };
      }
    }

    const recipient = this.getUserByName(recipientHandle);
    if (!recipient || recipient.kind === "system") {
      throw new Error(`User @${normalizeHandle(recipientHandle) || recipientHandle} not found`);
    }

    const sender = this.ensureUser(senderUserId);
    if (sender.id === recipient.id) {
      throw new Error("Cannot send a direct message to yourself");
    }

    let threadId = 0;
    let createdPost!: Post;
    let shouldFlush = false;

    this.ctx.storage.transactionSync(() => {
      threadId = this.getOrCreateDMInTx(sender, recipient);
      this.sql.exec(
        `INSERT INTO posts (thread_id, user_id, body, operation_id)
         VALUES (?, ?, ?, ?)`,
        threadId,
        sender.id,
        cleanBody,
        operationId ?? null,
      );
      this.sql.exec(
        `UPDATE threads SET bumped_at = datetime('now') WHERE id = ?`,
        threadId,
      );

      const row = this.sql
        .exec<{ id: number; createdAt: string }>(
          `SELECT id, created_at AS createdAt
           FROM posts
           WHERE thread_id = ?
           ORDER BY id DESC
           LIMIT 1`,
          threadId,
        )
        .one();

      this.sql.exec(
        `UPDATE thread_participants
         SET last_read_post_id = MAX(last_read_post_id, ?)
         WHERE thread_id = ? AND user_id = ?`,
        row.id,
        threadId,
        sender.id,
      );

      shouldFlush = this.postProcessPostInTx({
        board: "messages",
        threadId,
        threadTitle: `DM with @${recipient.name}`,
        postId: row.id,
        author: sender,
        body: cleanBody,
      });

      createdPost = {
        id: row.id,
        threadId,
        body: cleanBody,
        authorId: sender.id,
        authorName: sender.name,
        authorKind: sender.kind,
        createdAt: row.createdAt,
        meta: null,
      };
    });

    if (shouldFlush) {
      this.scheduleOutboxFlush();
    }

    return { threadId, post: createdPost };
  }

  // ——— Typed RPC methods invoked by Agent Durable Objects ———

  async registerAgents(names: string[]): Promise<void> {
    for (const raw of names) {
      const name = raw.toLowerCase();
      this.sql.exec(
        `INSERT INTO users (id, name, kind) VALUES (?, ?, 'agent')
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = 'agent'`,
        agentUserId(name),
        name,
      );
    }
  }

  async listThreadsForAgent(limit = 20): Promise<ThreadSummary[]> {
    return this.listThreads(limit);
  }

  async getThreadForAgent(
    agentName: string,
    threadId: number,
    maxPosts = 30,
  ): Promise<ThreadDetail | null> {
    return this.getThread(threadId, agentUserId(agentName), {
      markRead: false,
      maxPosts,
    });
  }

  async listMessagesForAgent(agentName: string): Promise<MessageSummary[]> {
    return this.listMessages(agentUserId(agentName));
  }

  async findDMThreadForAgent(
    agentName: string,
    recipientHandle: string,
  ): Promise<ThreadDetail | null> {
    const recipient = this.getUserByName(recipientHandle);
    if (!recipient) return null;
    const dmKey = makeDmKey(agentUserId(agentName), recipient.id);
    const existing = this.sql
      .exec<{ id: number }>(`SELECT id FROM threads WHERE dm_key = ?`, dmKey)
      .toArray()[0];
    if (!existing) return null;
    return this.getThread(existing.id, agentUserId(agentName), {
      markRead: false,
      maxPosts: 15,
    });
  }

  async listInboxSince(
    agentName: string,
    afterPostId: number,
    limit = 20,
  ): Promise<InboxItem[]> {
    const uid = agentUserId(agentName);
    const rows = this.sql
      .exec<{
        postId: number;
        threadId: number;
        threadTitle: string;
        authorId: string;
        authorName: string;
        authorKind: UserKind;
        body: string;
        createdAt: string;
        metaJson: string | null;
      }>(
        `SELECT
           p.id AS postId,
           p.thread_id AS threadId,
           t.title AS threadTitle,
           p.user_id AS authorId,
           u.name AS authorName,
           u.kind AS authorKind,
           p.body AS body,
           p.created_at AS createdAt,
           p.meta_json AS metaJson
         FROM thread_participants tp
         JOIN threads t ON t.id = tp.thread_id
         JOIN posts p ON p.thread_id = tp.thread_id
         JOIN users u ON u.id = p.user_id
         WHERE tp.user_id = ?
           AND t.board = 'messages'
           AND p.id > ?
           AND p.user_id != ?
         ORDER BY p.id ASC
         LIMIT ?`,
        uid,
        afterPostId,
        uid,
        Math.max(1, Math.min(limit, 50)),
      )
      .toArray();

    return rows.map((r) => ({
      postId: r.postId,
      threadId: r.threadId,
      threadTitle: r.threadTitle,
      authorId: r.authorId,
      authorName: r.authorName,
      authorKind: r.authorKind,
      body: r.body,
      createdAt: r.createdAt,
      meta: parseMeta(r.metaJson),
    }));
  }

  async markInboxReadForAgent(
    agentName: string,
    upToPostId: number,
  ): Promise<void> {
    const uid = agentUserId(agentName);
    this.sql.exec(
      `UPDATE thread_participants
       SET last_read_post_id = MAX(last_read_post_id, ?)
       WHERE user_id = ?`,
      upToPostId,
      uid,
    );
  }

  async createThreadAsAgent(
    agentName: string,
    title: string,
    body: string,
    operationId: string,
  ): Promise<ThreadDetail> {
    return this.createThread(agentUserId(agentName), title, body, operationId);
  }

  async replyAsAgent(
    agentName: string,
    threadId: number,
    body: string,
    operationId: string,
  ): Promise<Post> {
    return this.replyToThread(agentUserId(agentName), threadId, body, operationId);
  }

  async sendDMAsAgent(
    agentName: string,
    recipientHandle: string,
    body: string,
    operationId: string,
  ): Promise<{ threadId: number; post: Post }> {
    return this.sendDM(
      agentUserId(agentName),
      recipientHandle,
      body,
      operationId,
    );
  }

  // ——— HTTP handler for browser /api/* requests ———

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isReadOnly = request.headers.get("X-Read-Only") === "1";
    const userId = request.headers.get("X-User-Id");
    const ownerHandle = request.headers.get("X-Owner-Handle") || "overlord";

    if (!isReadOnly && !userId) {
      return Response.json({ error: "Missing user id" }, { status: 400 });
    }

    const ensureActor = (): User => {
      if (userId === OWNER_USER_ID) {
        return this.ensureOwner(ownerHandle);
      }
      return this.ensureUser(userId!);
    };

    try {
      if (request.method === "GET" && url.pathname === "/threads") {
        return Response.json({
          board: "general",
          threads: this.listThreads(),
        });
      }

      const threadMatch = url.pathname.match(/^\/threads\/(\d+)$/);
      if (request.method === "GET" && threadMatch) {
        if (!isReadOnly) {
          ensureActor();
        }
        const viewerId = isReadOnly ? "__guest__" : userId!;
        const thread = this.getThread(Number(threadMatch[1]), viewerId, {
          markRead: !isReadOnly,
        });
        if (!thread) {
          return Response.json({ error: "Thread not found" }, { status: 404 });
        }
        return Response.json({
          board: thread.board,
          thread,
          unreadMessages: isReadOnly ? 0 : this.countUnreadMessages(viewerId),
        });
      }

      if (isReadOnly) {
        return Response.json(
          { error: "Owner sign-in required" },
          { status: 401 },
        );
      }

      if (request.method === "GET" && url.pathname === "/me") {
        const user = ensureActor();
        return Response.json({
          user,
          unreadMessages: this.countUnreadMessages(user.id),
        });
      }

      if (request.method === "PATCH" && url.pathname === "/me") {
        return Response.json(
          { error: "Handles are fixed once assigned" },
          { status: 403 },
        );
      }

      if (request.method === "POST" && url.pathname === "/threads") {
        const { title, body } = (await request.json()) as {
          title?: string;
          body?: string;
        };
        if (typeof title !== "string" || typeof body !== "string") {
          return Response.json(
            { error: "title and body required" },
            { status: 400 },
          );
        }
        const actor = ensureActor();
        const thread = this.createThread(actor.id, title, body);
        return Response.json({ thread }, { status: 201 });
      }

      if (request.method === "GET" && url.pathname === "/messages") {
        const actor = ensureActor();
        return Response.json({
          board: "messages",
          messages: this.listMessages(actor.id),
          unreadMessages: this.countUnreadMessages(actor.id),
        });
      }

      if (request.method === "POST" && url.pathname === "/messages") {
        const { recipient, body } = (await request.json()) as {
          recipient?: string;
          body?: string;
        };
        if (typeof recipient !== "string" || typeof body !== "string") {
          return Response.json(
            { error: "recipient and body required" },
            { status: 400 },
          );
        }
        const actor = ensureActor();
        const result = this.sendDM(actor.id, recipient, body);
        return Response.json(result, { status: 201 });
      }

      const replyMatch = url.pathname.match(/^\/threads\/(\d+)\/posts$/);
      if (request.method === "POST" && replyMatch) {
        const { body } = (await request.json()) as { body?: string };
        if (typeof body !== "string") {
          return Response.json({ error: "body required" }, { status: 400 });
        }
        const actor = ensureActor();
        const post = this.replyToThread(actor.id, Number(replyMatch[1]), body);
        return Response.json({ post }, { status: 201 });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Server error";
      const status =
        message === "Thread not found" || message.endsWith("not found")
          ? 404
          : 400;
      return Response.json({ error: message }, { status });
    }
  }
}
