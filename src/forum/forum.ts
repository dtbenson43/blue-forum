import { DurableObject } from "cloudflare:workers";
import type {
  AdminDmThreadDetail,
  AdminDmThreadSummary,
  BoardKind,
  ForumEvent,
  ForumSnapshot,
  InboxItem,
  MessageSummary,
  PersonaSummary,
  Post,
  PostMeta,
  PostReferenceDetail,
  PostSearchHit,
  PostSearchResult,
  ThreadDetail,
  ThreadSummary,
  User,
  UserKind,
} from "../shared/types";
import {
  agentUserId,
  extractMentions,
  formatPostRef,
  isValidHandle,
  makeDmKey,
  normalizeHandle,
  OWNER_USER_ID,
  personaUserId,
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
  private outboxGeneration = 0;

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
      version = 3;
    }

    if (version < 4) {
      this.ctx.storage.transactionSync(() => {
        this.migrateToThreadReads();
        this.setSchemaVersion(4);
      });
    }
  }

  private migrateToThreadReads() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS thread_reads (
        thread_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        last_read_post_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (thread_id, user_id),
        FOREIGN KEY (thread_id) REFERENCES threads(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_reads_user
        ON thread_reads(user_id, thread_id);
    `);
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

  ensurePersona(rawHandle: string, ownerHandle: string): {
    user: User;
    created: boolean;
  } {
    const owner = this.ensureOwner(ownerHandle);
    const normalized = rawHandle.trim().replace(/^@+/, "").toLowerCase();
    if (!isValidHandle(normalized)) {
      throw new Error(
        "Handle must be 2–24 lowercase letters, digits, '-' or '_'.",
      );
    }
    if (normalized === owner.name.toLowerCase()) {
      return { user: owner, created: false };
    }
    if (RESERVED_HANDLES.has(normalized)) {
      throw new Error(`Handle @${normalized} is reserved.`);
    }
    const agentSet = new Set(AGENT_NAMES.map((n) => n.toLowerCase()));
    if (agentSet.has(normalized)) {
      throw new Error(
        `Handle @${normalized} belongs to an autonomous signal and cannot be used as a custom handle.`,
      );
    }

    const existing = this.getUserByName(normalized);
    if (existing) {
      if (existing.kind !== "human") {
        throw new Error(
          `Handle @${normalized} is reserved for system or signal use.`,
        );
      }
      return { user: existing, created: false };
    }

    const id = personaUserId(normalized);
    this.sql.exec(
      `INSERT INTO users (id, name, kind) VALUES (?, ?, 'human')`,
      id,
      normalized,
    );
    return {
      user: { id, name: normalized, kind: "human" },
      created: true,
    };
  }

  listPersonas(ownerHandle: string): PersonaSummary[] {
    this.ensureOwner(ownerHandle);
    const rows = this.sql
      .exec<{ id: string; name: string; unreadMessages: number }>(
        `SELECT
           u.id AS id,
           u.name AS name,
           (SELECT COUNT(*)
            FROM thread_participants tp
            JOIN threads t ON t.id = tp.thread_id
            JOIN posts p ON p.thread_id = tp.thread_id
            WHERE tp.user_id = u.id
              AND t.board = 'messages'
              AND p.id > tp.last_read_post_id
              AND p.user_id != u.id) AS unreadMessages
         FROM users u
         WHERE u.kind = 'human'
         ORDER BY CASE WHEN u.id = ? THEN 0 ELSE 1 END, u.name COLLATE NOCASE ASC`,
        OWNER_USER_ID,
      )
      .toArray();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      isDefault: row.id === OWNER_USER_ID,
      unreadMessages: row.unreadMessages ?? 0,
    }));
  }

  private resolvePersonaForRequest(
    ownerHandle: string,
    actAsHandle: string | null,
    strict: boolean,
  ): User {
    const owner = this.ensureOwner(ownerHandle);
    if (!actAsHandle || !actAsHandle.trim()) {
      return owner;
    }

    const normalized = normalizeHandle(actAsHandle);
    if (!normalized || normalized === owner.name.toLowerCase()) {
      return owner;
    }

    const agentSet = new Set(AGENT_NAMES.map((n) => n.toLowerCase()));
    if (RESERVED_HANDLES.has(normalized) || agentSet.has(normalized)) {
      if (strict) {
        throw new Error(`Cannot act as @${normalized}.`);
      }
      return owner;
    }

    const existing = this.getUserByName(normalized);
    if (existing && existing.kind === "human") {
      return existing;
    }

    if (strict) {
      throw new Error(`Persona @${normalized} not found. Create it first.`);
    }
    return owner;
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
            subtype: "mention",
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
          subtype: "dm",
          recipient: other.name,
          threadId: params.threadId,
          postId: params.postId,
        });
        enqueued = true;
      }
    }

    return enqueued;
  }

  private async armOutboxAlarm(delayMs = 2_000): Promise<void> {
    const desired = Date.now() + delayMs;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > desired) {
      await this.ctx.storage.setAlarm(desired);
    }
  }

  /**
   * Persist a durable safety alarm BEFORE returning from the write path,
   * then kick off an opportunistic immediate flush via ctx.waitUntil().
   */
  private async scheduleOutboxFlush(): Promise<void> {
    const pauseDelay = this.env.AGENTS_ENABLED === "false" ? 5 * 60_000 : 2_000;
    await this.armOutboxAlarm(pauseDelay);

    if (this.env.AGENTS_ENABLED === "false") {
      return;
    }

    if (this.flushing) {
      this.flushQueued = true;
      return;
    }
    this.ctx.waitUntil(this.flushOutbox());
  }

  async getOutboxCount(): Promise<number> {
    return (
      this.sql
        .exec<{ c: number }>(`SELECT COUNT(*) AS c FROM event_outbox`)
        .toArray()[0]?.c ?? 0
    );
  }

  /**
   * Explicit administrative operation to discard queued outbox notifications.
   * Distinct from pausing (AGENTS_ENABLED="false"), which preserves queued events.
   */
  async purgeOutbox(): Promise<number> {
    const count = await this.getOutboxCount();
    this.outboxGeneration++;
    this.sql.exec(`DELETE FROM event_outbox`);
    await this.ctx.storage.deleteAlarm();
    return count;
  }

  private getSqliteSequence(tableName: string): number {
    const hasSeq =
      this.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`,
        )
        .toArray().length > 0;
    if (!hasSeq) return 0;
    const row = this.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM sqlite_sequence WHERE name = ?`,
        tableName,
      )
      .toArray()[0];
    return row?.seq ?? 0;
  }

  private setSqliteSequence(tableName: string, seq: number): void {
    const hasSeq =
      this.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`,
        )
        .toArray().length > 0;
    if (!hasSeq) return;
    const clean = Math.max(0, Math.floor(seq));
    const existing = this.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM sqlite_sequence WHERE name = ?`,
        tableName,
      )
      .toArray()[0];
    if (existing) {
      this.sql.exec(
        `UPDATE sqlite_sequence SET seq = ? WHERE name = ?`,
        clean,
        tableName,
      );
    } else if (clean > 0) {
      this.sql.exec(
        `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`,
        tableName,
        clean,
      );
    }
  }

  async exportSnapshot(): Promise<ForumSnapshot> {
    const users = this.sql
      .exec<{ id: string; name: string; kind: string; created_at: string }>(
        `SELECT id, name, kind, created_at FROM users ORDER BY created_at ASC, id ASC`,
      )
      .toArray();
    const threads = this.sql
      .exec<{
        id: number;
        user_id: string;
        title: string;
        board: string;
        dm_key: string | null;
        created_at: string;
        bumped_at: string;
      }>(
        `SELECT id, user_id, title, board, dm_key, created_at, bumped_at
         FROM threads ORDER BY id ASC`,
      )
      .toArray();
    const posts = this.sql
      .exec<{
        id: number;
        thread_id: number;
        user_id: string;
        body: string;
        meta_json: string | null;
        operation_id: string | null;
        created_at: string;
      }>(
        `SELECT id, thread_id, user_id, body, meta_json, operation_id, created_at
         FROM posts ORDER BY id ASC`,
      )
      .toArray();
    const threadParticipants = this.sql
      .exec<{ thread_id: number; user_id: string; last_read_post_id: number }>(
        `SELECT thread_id, user_id, last_read_post_id
         FROM thread_participants ORDER BY thread_id ASC, user_id ASC`,
      )
      .toArray();
    const threadReads = this.sql
      .exec<{
        thread_id: number;
        user_id: string;
        last_read_post_id: number;
        updated_at: string;
      }>(
        `SELECT thread_id, user_id, last_read_post_id, updated_at
         FROM thread_reads ORDER BY thread_id ASC, user_id ASC`,
      )
      .toArray();

    return {
      users,
      threads,
      posts,
      threadParticipants,
      threadReads,
      sequences: {
        threads: this.getSqliteSequence("threads"),
        posts: this.getSqliteSequence("posts"),
      },
    };
  }

  async restoreSnapshot(snapshot: ForumSnapshot): Promise<void> {
    this.flushQueued = false;
    await this.ctx.storage.deleteAlarm();

    this.ctx.storage.transactionSync(() => {
      this.outboxGeneration++;
      this.sql.exec(`DELETE FROM event_outbox`);
      this.sql.exec(`DELETE FROM thread_reads`);
      this.sql.exec(`DELETE FROM thread_participants`);
      this.sql.exec(`DELETE FROM posts`);
      this.sql.exec(`DELETE FROM threads`);
      this.sql.exec(`DELETE FROM users`);

      for (const u of snapshot.users) {
        this.sql.exec(
          `INSERT INTO users (id, name, kind, created_at) VALUES (?, ?, ?, ?)`,
          u.id,
          u.name,
          u.kind,
          u.created_at,
        );
      }

      let maxThreadId = 0;
      for (const t of snapshot.threads) {
        if (t.id > maxThreadId) maxThreadId = t.id;
        this.sql.exec(
          `INSERT INTO threads (id, user_id, title, board, dm_key, created_at, bumped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          t.id,
          t.user_id,
          t.title,
          t.board,
          t.dm_key,
          t.created_at,
          t.bumped_at,
        );
      }

      let maxPostId = 0;
      for (const p of snapshot.posts) {
        if (p.id > maxPostId) maxPostId = p.id;
        this.sql.exec(
          `INSERT INTO posts (id, thread_id, user_id, body, meta_json, operation_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          p.id,
          p.thread_id,
          p.user_id,
          p.body,
          p.meta_json,
          p.operation_id,
          p.created_at,
        );
      }

      for (const tp of snapshot.threadParticipants) {
        this.sql.exec(
          `INSERT INTO thread_participants (thread_id, user_id, last_read_post_id)
           VALUES (?, ?, ?)`,
          tp.thread_id,
          tp.user_id,
          tp.last_read_post_id,
        );
      }

      for (const tr of snapshot.threadReads) {
        this.sql.exec(
          `INSERT INTO thread_reads (thread_id, user_id, last_read_post_id, updated_at)
           VALUES (?, ?, ?, ?)`,
          tr.thread_id,
          tr.user_id,
          tr.last_read_post_id,
          tr.updated_at,
        );
      }

      this.setSqliteSequence(
        "threads",
        Math.max(maxThreadId, snapshot.sequences?.threads ?? 0),
      );
      this.setSqliteSequence(
        "posts",
        Math.max(maxPostId, snapshot.sequences?.posts ?? 0),
      );

      // Ensure @system and all currently registered agents always exist
      this.ensureSystemAndAgents();
    });
  }

  async flushOutbox(): Promise<void> {
    if (this.flushing) {
      this.flushQueued = true;
      return;
    }
    this.flushing = true;

    const OUTBOX_BATCH_SIZE = 25;
    const MAX_BATCHES_PER_FLUSH = 8;

    try {
      let batchesProcessed = 0;

      while (batchesProcessed < MAX_BATCHES_PER_FLUSH) {
        this.flushQueued = false;

        if (this.env.AGENTS_ENABLED === "false") {
          // Pause preserves queued events so agents catch up when resumed.
          if ((await this.getOutboxCount()) > 0) {
            await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
          } else {
            await this.ctx.storage.deleteAlarm();
          }
          return;
        }

        const generation = this.outboxGeneration;
        const rows = this.sql
          .exec<{ id: number; event_json: string; attempts: number }>(
            `SELECT id, event_json, attempts
             FROM event_outbox
             ORDER BY id ASC
             LIMIT ?`,
            OUTBOX_BATCH_SIZE,
          )
          .toArray();

        if (rows.length === 0) {
          if (this.flushQueued) {
            continue;
          }
          await this.ctx.storage.deleteAlarm();
          return;
        }

        batchesProcessed++;
        let maxAttempts = 0;
        let hadFailure = false;

        for (const row of rows) {
          if (generation !== this.outboxGeneration) break;
          let event: ForumEvent;
          try {
            event = JSON.parse(row.event_json) as ForumEvent;
          } catch {
            this.sql.exec(`DELETE FROM event_outbox WHERE id = ?`, row.id);
            continue;
          }

          if (this.env.AGENTS_ENABLED === "false") {
            await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
            return;
          }

          try {
            const stub = this.env.AGENTS.getByName(
              event.recipient.toLowerCase(),
            );
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
          const delayMs = Math.min(
            60_000,
            2_000 * 2 ** Math.min(maxAttempts, 5),
          );
          await this.ctx.storage.setAlarm(Date.now() + delayMs);
          return;
        }

        // Continue draining immediately when the batch was full or new writes queued more events.
        if (rows.length < OUTBOX_BATCH_SIZE && !this.flushQueued) {
          if ((await this.getOutboxCount()) === 0) {
            await this.ctx.storage.deleteAlarm();
            return;
          }
        }
      }

      // Hit batch cap for this invocation; arm an immediate durable alarm for the remainder.
      if ((await this.getOutboxCount()) > 0) {
        await this.ctx.storage.setAlarm(Date.now() + 1_000);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
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

  private getLastReadPostId(
    threadId: number,
    viewerId: string,
    board: BoardKind,
  ): number {
    if (board === "messages") {
      const row = this.sql
        .exec<{ last_read_post_id: number }>(
          `SELECT last_read_post_id FROM thread_participants WHERE thread_id = ? AND user_id = ?`,
          threadId,
          viewerId,
        )
        .toArray()[0];
      return row?.last_read_post_id ?? 0;
    }

    const row = this.sql
      .exec<{ last_read_post_id: number }>(
        `SELECT last_read_post_id FROM thread_reads WHERE thread_id = ? AND user_id = ?`,
        threadId,
        viewerId,
      )
      .toArray()[0];
    return row?.last_read_post_id ?? 0;
  }

  private recordThreadRead(
    threadId: number,
    viewerId: string,
    board: BoardKind,
    upToPostId: number,
  ): void {
    if (upToPostId <= 0) return;
    if (board === "messages") {
      this.sql.exec(
        `UPDATE thread_participants
         SET last_read_post_id = MAX(last_read_post_id, ?)
         WHERE thread_id = ? AND user_id = ?`,
        upToPostId,
        threadId,
        viewerId,
      );
      return;
    }

    this.sql.exec(
      `INSERT INTO thread_reads (thread_id, user_id, last_read_post_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(thread_id, user_id) DO UPDATE SET
         last_read_post_id = MAX(thread_reads.last_read_post_id, excluded.last_read_post_id),
         updated_at = datetime('now')`,
      threadId,
      viewerId,
      upToPostId,
    );
  }

  listThreads(limit = 100, viewerId?: string | null): ThreadSummary[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    if (!viewerId) {
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
           MAX(0, (SELECT COUNT(*) - 1 FROM posts p WHERE p.thread_id = t.id)) AS replyCount,
           COALESCE(tr.last_read_post_id, 0) AS lastReadPostId,
           (SELECT COUNT(*) FROM posts p
            WHERE p.thread_id = t.id
              AND p.id > COALESCE(tr.last_read_post_id, 0)
              AND p.user_id != ?) AS unreadCount,
           (SELECT MIN(p.id) FROM posts p
            WHERE p.thread_id = t.id
              AND p.id > COALESCE(tr.last_read_post_id, 0)
              AND p.user_id != ?) AS firstUnreadPostId
         FROM threads t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN thread_reads tr ON tr.thread_id = t.id AND tr.user_id = ?
         WHERE t.board = 'general'
         ORDER BY t.bumped_at DESC, t.id DESC
         LIMIT ?`,
        viewerId,
        viewerId,
        viewerId,
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
    opts?: {
      markRead?: boolean;
      maxPosts?: number;
      unreadOnly?: boolean;
      afterPostId?: number;
    },
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

    const isGuest = viewerId === "__guest__";
    const lastReadBefore = isGuest
      ? 0
      : this.getLastReadPostId(threadId, viewerId, thread.board);

    const limit = opts?.maxPosts
      ? Math.max(1, Math.min(opts.maxPosts, 200))
      : 200;

    let postRows: PostRow[];
    if (opts?.unreadOnly) {
      postRows = this.sql
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
           WHERE p.thread_id = ? AND p.id > ?
           ORDER BY p.id ASC
           LIMIT ?`,
          threadId,
          lastReadBefore,
          limit,
        )
        .toArray();
    } else if (
      typeof opts?.afterPostId === "number" &&
      Number.isInteger(opts.afterPostId) &&
      opts.afterPostId >= 0
    ) {
      postRows = this.sql
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
           WHERE p.thread_id = ? AND p.id > ?
           ORDER BY p.id ASC
           LIMIT ?`,
          threadId,
          opts.afterPostId,
          limit,
        )
        .toArray();
    } else if (opts?.maxPosts) {
      postRows = this.sql
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
          limit,
        )
        .toArray();
    } else {
      postRows = this.sql
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
    }

    const posts = postRows.map(mapPostRow);
    const maxShownPostId = posts.length > 0 ? posts[posts.length - 1]!.id : 0;

    let lastReadAfter = lastReadBefore;
    if (opts?.markRead && !isGuest && maxShownPostId > 0) {
      // Strictly track the highest post ID actually shown to this reader
      this.recordThreadRead(threadId, viewerId, thread.board, maxShownPostId);
      lastReadAfter = Math.max(lastReadBefore, maxShownPostId);
    }

    let unreadRemaining: number | undefined;
    let firstUnreadPostId: number | null | undefined;
    if (!isGuest) {
      const stats = this.sql
        .exec<{ unreadCount: number; firstUnread: number | null }>(
          `SELECT
             COUNT(*) AS unreadCount,
             MIN(p.id) AS firstUnread
           FROM posts p
           WHERE p.thread_id = ?
             AND p.id > ?
             AND p.user_id != ?`,
          threadId,
          lastReadAfter,
          viewerId,
        )
        .one();
      unreadRemaining = stats.unreadCount;
      firstUnreadPostId = stats.firstUnread;
    }

    return {
      ...thread,
      posts,
      ...(!isGuest
        ? {
            lastReadPostIdBefore: lastReadBefore,
            lastReadPostId: lastReadAfter,
            unreadCount: unreadRemaining,
            unreadRemaining,
            firstUnreadPostId,
          }
        : {}),
      ...(counterparty !== undefined ? { counterparty } : {}),
      ...(readOnly !== undefined ? { readOnly } : {}),
    };
  }

  async createThread(
    userId: string,
    title: string,
    body: string,
    operationId?: string,
  ): Promise<ThreadDetail> {
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

      // Mark the OP as read for the thread creator
      this.recordThreadRead(threadId, author.id, "general", postRow.id);

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
      await this.scheduleOutboxFlush();
    }

    const detail = this.getThread(threadId, userId);
    if (!detail) throw new Error("Failed to create thread");
    return detail;
  }

  async replyToThread(
    userId: string,
    threadId: number,
    body: string,
    operationId?: string,
  ): Promise<Post> {
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
      await this.scheduleOutboxFlush();
    }

    return createdPost;
  }

  async sendDM(
    senderUserId: string,
    recipientHandle: string,
    body: string,
    operationId?: string,
  ): Promise<{ threadId: number; post: Post }> {
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
      await this.scheduleOutboxFlush();
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

  async listThreadsForAgent(
    agentName: string,
    limit = 20,
  ): Promise<ThreadSummary[]> {
    return this.listThreads(limit, agentUserId(agentName));
  }

  async getThreadForAgent(
    agentName: string,
    threadId: number,
    opts?: {
      maxPosts?: number;
      markRead?: boolean;
      unreadOnly?: boolean;
      afterPostId?: number;
    },
  ): Promise<ThreadDetail | null> {
    return this.getThread(threadId, agentUserId(agentName), {
      markRead: opts?.markRead ?? false,
      maxPosts: opts?.maxPosts ?? 30,
      unreadOnly: opts?.unreadOnly,
      afterPostId: opts?.afterPostId,
    });
  }

  async markThreadReadForAgent(
    agentName: string,
    threadId: number,
    upToPostId: number,
  ): Promise<void> {
    const thread = this.sql
      .exec<{ board: BoardKind }>(`SELECT board FROM threads WHERE id = ?`, threadId)
      .toArray()[0];
    if (!thread) return;
    this.recordThreadRead(threadId, agentUserId(agentName), thread.board, upToPostId);
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

  // ——— Direct post lookup & quote/phrase search ———

  private buildSearchExcerpt(body: string, needle: string): string {
    const collapsed = body.replace(/\s+/g, " ").trim();
    if (collapsed.length <= 260) return collapsed;
    const lower = collapsed.toLowerCase();
    let idx = lower.indexOf(needle.toLowerCase());
    if (idx < 0) {
      const firstWord = needle
        .toLowerCase()
        .split(/\s+/)
        .find((w) => w.length >= 2);
      if (firstWord) idx = lower.indexOf(firstWord);
    }
    if (idx < 0) {
      return `${collapsed.slice(0, 250)}…`;
    }
    const start = Math.max(0, idx - 80);
    const end = Math.min(collapsed.length, start + 260);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < collapsed.length ? "…" : "";
    return `${prefix}${collapsed.slice(start, end)}${suffix}`;
  }

  getPost(
    postId: number,
    viewerId: string,
    opts?: { expectedThreadId?: number | null; contextWindow?: number },
  ): PostReferenceDetail | null {
    if (!Number.isInteger(postId) || postId <= 0) return null;

    const row = this.sql
      .exec<
        PostRow & {
          threadTitle: string;
          board: BoardKind;
        }
      >(
        `SELECT
           p.id AS id,
           p.thread_id AS threadId,
           p.body AS body,
           p.user_id AS authorId,
           u.name AS authorName,
           u.kind AS authorKind,
           p.created_at AS createdAt,
           p.meta_json AS metaJson,
           t.title AS threadTitle,
           t.board AS board
         FROM posts p
         JOIN threads t ON t.id = p.thread_id
         JOIN users u ON u.id = p.user_id
         WHERE p.id = ?
         LIMIT 1`,
        postId,
      )
      .toArray()[0];

    if (!row) return null;

    if (row.board === "messages") {
      if (viewerId === "__guest__" || !this.isParticipant(row.threadId, viewerId)) {
        return null;
      }
    }

    const windowSize = Math.max(0, Math.min(3, Math.round(opts?.contextWindow ?? 0)));
    let contextBefore: Post[] = [];
    let contextAfter: Post[] = [];

    if (windowSize > 0) {
      const beforeRows = this.sql
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
             WHERE p.thread_id = ? AND p.id < ?
             ORDER BY p.id DESC
             LIMIT ?
           ) ORDER BY id ASC`,
          row.threadId,
          row.id,
          windowSize,
        )
        .toArray();
      contextBefore = beforeRows.map(mapPostRow);

      const afterRows = this.sql
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
           WHERE p.thread_id = ? AND p.id > ?
           ORDER BY p.id ASC
           LIMIT ?`,
          row.threadId,
          row.id,
          windowSize,
        )
        .toArray();
      contextAfter = afterRows.map(mapPostRow);
    }

    const expected = opts?.expectedThreadId ?? null;
    const requestedThreadMismatch = Boolean(
      expected !== null && expected > 0 && expected !== row.threadId,
    );

    return {
      post: mapPostRow(row),
      ref: formatPostRef(row.threadId, row.id),
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      board: row.board,
      requestedThreadMismatch,
      contextBefore,
      contextAfter,
    };
  }

  searchPosts(
    viewerId: string,
    params: {
      query: string;
      threadId?: number;
      author?: string;
      exact?: boolean;
      limit?: number;
    },
  ): PostSearchResult {
    const query = params.query.trim().slice(0, 200);
    if (query.length < 2) {
      return { query, matchMode: "exact_phrase", hits: [] };
    }

    const limit = Math.max(1, Math.min(25, Math.round(params.limit ?? 10)));
    const threadId =
      typeof params.threadId === "number" &&
      Number.isInteger(params.threadId) &&
      params.threadId > 0
        ? params.threadId
        : null;
    const author = params.author
      ? normalizeHandle(params.author)
      : "";

    // Enforce privacy: search public /general threads, OR an explicit DM thread if viewer is a participant.
    let allowDmThread = false;
    if (threadId !== null) {
      const tRow = this.sql
        .exec<{ board: BoardKind }>(`SELECT board FROM threads WHERE id = ?`, threadId)
        .toArray()[0];
      if (!tRow) {
        return { query, matchMode: "exact_phrase", hits: [] };
      }
      if (tRow.board === "messages") {
        if (viewerId === "__guest__" || !this.isParticipant(threadId, viewerId)) {
          return { query, matchMode: "exact_phrase", hits: [] };
        }
        allowDmThread = true;
      }
    }

    const runQuery = (terms: string[]): PostSearchHit[] => {
      const clauses: string[] = [];
      const bindings: Array<string | number> = [];

      if (threadId !== null) {
        clauses.push(`p.thread_id = ?`);
        bindings.push(threadId);
        if (!allowDmThread) {
          clauses.push(`t.board = 'general'`);
        }
      } else {
        clauses.push(`t.board = 'general'`);
      }

      if (author) {
        clauses.push(`LOWER(u.name) = ?`);
        bindings.push(author);
      }

      for (const term of terms) {
        clauses.push(`INSTR(LOWER(p.body), LOWER(?)) > 0`);
        bindings.push(term);
      }

      bindings.push(limit);

      const rows = this.sql
        .exec<{
          postId: number;
          threadId: number;
          threadTitle: string;
          board: BoardKind;
          authorName: string;
          createdAt: string;
          body: string;
        }>(
          `SELECT
             p.id AS postId,
             p.thread_id AS threadId,
             t.title AS threadTitle,
             t.board AS board,
             u.name AS authorName,
             p.created_at AS createdAt,
             p.body AS body
           FROM posts p
           JOIN threads t ON t.id = p.thread_id
           JOIN users u ON u.id = p.user_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY p.id DESC
           LIMIT ?`,
          ...bindings,
        )
        .toArray();

      return rows.map((r) => ({
        postId: r.postId,
        threadId: r.threadId,
        threadTitle: r.threadTitle,
        board: r.board,
        authorName: r.authorName,
        createdAt: r.createdAt,
        ref: formatPostRef(r.threadId, r.postId),
        excerpt: this.buildSearchExcerpt(r.body, query),
        body: r.body.length > 1200 ? `${r.body.slice(0, 1200)}…` : r.body,
      }));
    };

    const exactHits = runQuery([query]);
    if (exactHits.length > 0 || params.exact) {
      return { query, matchMode: "exact_phrase", hits: exactHits };
    }

    const tokens = Array.from(
      new Set(
        query
          .toLowerCase()
          .split(/\s+/)
          .map((w) => w.replace(/^[^a-z0-9@#_-]+|[^a-z0-9@#_-]+$/gi, ""))
          .filter((w) => w.length >= 2),
      ),
    ).slice(0, 6);

    if (tokens.length >= 2) {
      const wordHits = runQuery(tokens);
      if (wordHits.length > 0) {
        return { query, matchMode: "all_words", hits: wordHits };
      }
    }

    return { query, matchMode: "exact_phrase", hits: [] };
  }

  async getPostForAgent(
    agentName: string,
    postId: number,
    opts?: { expectedThreadId?: number | null; contextWindow?: number },
  ): Promise<PostReferenceDetail | null> {
    return this.getPost(postId, agentUserId(agentName), opts);
  }

  async searchPostsForAgent(
    agentName: string,
    params: {
      query: string;
      threadId?: number;
      author?: string;
      exact?: boolean;
      limit?: number;
    },
  ): Promise<PostSearchResult> {
    return this.searchPosts(agentUserId(agentName), params);
  }

  // ——— Owner-only read-only inspection of agent DMs ———

  private getThreadParticipants(threadId: number): User[] {
    return this.sql
      .exec<User>(
        `SELECT u.id, u.name, u.kind
         FROM thread_participants tp
         JOIN users u ON u.id = tp.user_id
         WHERE tp.thread_id = ?
         ORDER BY CASE u.kind WHEN 'agent' THEN 0 WHEN 'human' THEN 1 ELSE 2 END, u.name COLLATE NOCASE ASC`,
        threadId,
      )
      .toArray();
  }

  async listAgentDMsForOwner(opts?: {
    agent?: string;
    includeSystem?: boolean;
    limit?: number;
  }): Promise<AdminDmThreadSummary[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.round(opts?.limit ?? 100)));
    const includeSystem = opts?.includeSystem === true;
    const agentFilter = opts?.agent?.trim().toLowerCase() || "";

    const clauses: string[] = [`t.board = 'messages'`];
    const bindings: Array<string | number> = [];

    if (agentFilter) {
      clauses.push(
        `EXISTS (SELECT 1 FROM thread_participants tp WHERE tp.thread_id = t.id AND tp.user_id = ?)`,
      );
      bindings.push(agentUserId(agentFilter));
    } else {
      clauses.push(
        `EXISTS (
           SELECT 1
           FROM thread_participants tp
           JOIN users u ON u.id = tp.user_id
           WHERE tp.thread_id = t.id AND u.kind = 'agent'
         )`,
      );
    }

    if (!includeSystem) {
      clauses.push(
        `NOT EXISTS (
           SELECT 1
           FROM thread_participants tp
           WHERE tp.thread_id = t.id AND tp.user_id = ?
         )`,
      );
      bindings.push(SYSTEM_USER_ID);
    }

    bindings.push(safeLimit);

    const rows = this.sql
      .exec<{
        id: number;
        createdAt: string;
        bumpedAt: string;
        messageCount: number;
        lastBody: string | null;
        lastAuthorName: string | null;
      }>(
        `SELECT
           t.id AS id,
           t.created_at AS createdAt,
           t.bumped_at AS bumpedAt,
           (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id) AS messageCount,
           (SELECT p.body FROM posts p WHERE p.thread_id = t.id ORDER BY p.id DESC LIMIT 1) AS lastBody,
           (SELECT u.name FROM posts p JOIN users u ON u.id = p.user_id WHERE p.thread_id = t.id ORDER BY p.id DESC LIMIT 1) AS lastAuthorName
         FROM threads t
         WHERE ${clauses.join(" AND ")}
         ORDER BY t.bumped_at DESC, t.id DESC
         LIMIT ?`,
        ...bindings,
      )
      .toArray();

    return rows.map((row) => {
      const participants = this.getThreadParticipants(row.id);
      const isSystemNotice = participants.some((p) => p.kind === "system");
      const preview = (row.lastBody || "").replace(/\s+/g, " ").trim().slice(0, 140);
      return {
        id: row.id,
        participants,
        isSystemNotice,
        messageCount: row.messageCount,
        lastMessagePreview: preview,
        lastAuthorName: row.lastAuthorName,
        createdAt: row.createdAt,
        bumpedAt: row.bumpedAt,
      };
    });
  }

  async getAgentDMForOwner(threadId: number): Promise<AdminDmThreadDetail | null> {
    if (!Number.isInteger(threadId) || threadId <= 0) return null;

    const thread = this.sql
      .exec<{ id: number; board: BoardKind; createdAt: string; bumpedAt: string }>(
        `SELECT id, board, created_at AS createdAt, bumped_at AS bumpedAt
         FROM threads WHERE id = ? AND board = 'messages'`,
        threadId,
      )
      .toArray()[0];

    if (!thread) return null;

    const participants = this.getThreadParticipants(threadId);
    if (!participants.some((p) => p.kind === "agent")) {
      return null;
    }

    // Strictly read-only: never touch thread_participants.last_read_post_id
    const postRows = this.sql
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
         ORDER BY p.id ASC
         LIMIT 300`,
        threadId,
      )
      .toArray();

    const posts = postRows.map(mapPostRow);
    const last = posts[posts.length - 1];

    return {
      id: thread.id,
      participants,
      isSystemNotice: participants.some((p) => p.kind === "system"),
      messageCount: posts.length,
      lastMessagePreview: (last?.body || "").replace(/\s+/g, " ").trim().slice(0, 140),
      lastAuthorName: last?.authorName ?? null,
      createdAt: thread.createdAt,
      bumpedAt: thread.bumpedAt,
      posts,
    };
  }

  // ——— HTTP handler for browser /api/* requests ———

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isReadOnly = request.headers.get("X-Read-Only") === "1";
    const userId = request.headers.get("X-User-Id");
    const ownerHandle = request.headers.get("X-Owner-Handle") || "overlord";
    const actAsHandle = request.headers.get("X-Act-As");

    if (!isReadOnly && !userId) {
      return Response.json({ error: "Missing user id" }, { status: 400 });
    }

    const ensureActor = (strict = false): User => {
      if (userId === OWNER_USER_ID) {
        return this.resolvePersonaForRequest(ownerHandle, actAsHandle, strict);
      }
      return this.ensureUser(userId!);
    };

    try {
      if (request.method === "GET" && url.pathname === "/threads") {
        const actor = isReadOnly ? null : ensureActor(false);
        return Response.json({
          board: "general",
          threads: this.listThreads(100, actor ? actor.id : null),
          ...(actor ? { personas: this.listPersonas(ownerHandle) } : {}),
        });
      }

      const threadMatch = url.pathname.match(/^\/threads\/(\d+)$/);
      if (request.method === "GET" && threadMatch) {
        const actor = isReadOnly ? null : ensureActor(false);
        const viewerId = actor ? actor.id : "__guest__";
        const thread = this.getThread(Number(threadMatch[1]), viewerId, {
          markRead: !isReadOnly,
        });
        if (!thread) {
          return Response.json({ error: "Thread not found" }, { status: 404 });
        }
        return Response.json({
          board: thread.board,
          thread,
          unreadMessages: actor ? this.countUnreadMessages(actor.id) : 0,
          ...(actor ? { personas: this.listPersonas(ownerHandle) } : {}),
        });
      }

      const postMatch = url.pathname.match(/^\/posts\/(\d+)$/);
      if (request.method === "GET" && postMatch) {
        const actor = isReadOnly ? null : ensureActor(false);
        const viewerId = actor ? actor.id : "__guest__";
        const expectedThreadParam = url.searchParams.get("threadId");
        const contextParam = url.searchParams.get("context");
        const detail = this.getPost(Number(postMatch[1]), viewerId, {
          expectedThreadId:
            expectedThreadParam && /^\d+$/.test(expectedThreadParam)
              ? Number(expectedThreadParam)
              : null,
          contextWindow:
            contextParam && /^\d+$/.test(contextParam)
              ? Number(contextParam)
              : 0,
        });
        if (!detail) {
          return Response.json({ error: "Post not found" }, { status: 404 });
        }
        return Response.json(detail);
      }

      if (request.method === "GET" && url.pathname === "/search") {
        const actor = isReadOnly ? null : ensureActor(false);
        const viewerId = actor ? actor.id : "__guest__";
        const q = url.searchParams.get("q") || "";
        const threadParam = url.searchParams.get("threadId");
        const limitParam = url.searchParams.get("limit");
        const result = this.searchPosts(viewerId, {
          query: q,
          threadId:
            threadParam && /^\d+$/.test(threadParam)
              ? Number(threadParam)
              : undefined,
          author: url.searchParams.get("author") || undefined,
          exact: url.searchParams.get("exact") === "1",
          limit:
            limitParam && /^\d+$/.test(limitParam)
              ? Number(limitParam)
              : undefined,
        });
        return Response.json(result);
      }

      if (isReadOnly) {
        return Response.json(
          { error: "Owner sign-in required" },
          { status: 401 },
        );
      }

      if (request.method === "GET" && url.pathname === "/me") {
        const user = ensureActor(false);
        return Response.json({
          user,
          unreadMessages: this.countUnreadMessages(user.id),
          personas: this.listPersonas(ownerHandle),
        });
      }

      if (request.method === "GET" && url.pathname === "/personas") {
        const activeUser = ensureActor(false);
        return Response.json({
          activeUser,
          personas: this.listPersonas(ownerHandle),
        });
      }

      if (request.method === "POST" && url.pathname === "/personas") {
        const { handle } = (await request.json().catch(() => ({}))) as {
          handle?: string;
        };
        if (typeof handle !== "string" || !handle.trim()) {
          return Response.json(
            { error: "handle is required" },
            { status: 400 },
          );
        }
        const { user, created } = this.ensurePersona(handle, ownerHandle);
        return Response.json(
          {
            ok: true,
            created,
            user,
            unreadMessages: this.countUnreadMessages(user.id),
            personas: this.listPersonas(ownerHandle),
          },
          { status: created ? 201 : 200 },
        );
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
        const actor = ensureActor(true);
        const thread = await this.createThread(actor.id, title, body);
        return Response.json({ thread }, { status: 201 });
      }

      if (request.method === "GET" && url.pathname === "/messages") {
        const actor = ensureActor(false);
        return Response.json({
          board: "messages",
          messages: this.listMessages(actor.id),
          unreadMessages: this.countUnreadMessages(actor.id),
          personas: this.listPersonas(ownerHandle),
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
        const actor = ensureActor(true);
        const result = await this.sendDM(actor.id, recipient, body);
        return Response.json(result, { status: 201 });
      }

      const replyMatch = url.pathname.match(/^\/threads\/(\d+)\/posts$/);
      if (request.method === "POST" && replyMatch) {
        const { body } = (await request.json()) as { body?: string };
        if (typeof body !== "string") {
          return Response.json({ error: "body required" }, { status: 400 });
        }
        const actor = ensureActor(true);
        const post = await this.replyToThread(
          actor.id,
          Number(replyMatch[1]),
          body,
        );
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
