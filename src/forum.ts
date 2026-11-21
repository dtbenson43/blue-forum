import { DurableObject } from "cloudflare:workers";
import { generateDisplayName } from "./names";

export type ThreadSummary = {
  id: number;
  title: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  bumpedAt: string;
  replyCount: number;
};

export type Post = {
  id: number;
  threadId: number;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
};

export type ThreadDetail = ThreadSummary & {
  posts: Post[];
};

type Env = {
  FORUM: DurableObjectNamespace<Forum>;
};

/**
 * Single-category forum state ("general").
 * Threads live under general; each thread has an OP + replies.
 */
export class Forum extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
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
    const version = versionRow ? Number(versionRow.value) : 0;

    if (version < 2) {
      this.migrateToThreads();
      this.sql.exec(
        `INSERT INTO schema_meta (key, value) VALUES ('version', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
    }
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
      const cols = this.sql
        .exec<{ name: string }>(`PRAGMA table_info(posts)`)
        .toArray()
        .map((c) => c.name);

      if (cols.includes("title")) {
        // v1 flat posts → one thread per post
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
            .exec<{ id: number }>(`SELECT id FROM threads ORDER BY id DESC LIMIT 1`)
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

  ensureUser(userId: string): { id: string; name: string } {
    const existing = this.sql
      .exec<{ id: string; name: string }>(
        `SELECT id, name FROM users WHERE id = ?`,
        userId,
      )
      .toArray();

    if (existing[0]) {
      return existing[0];
    }

    const name = generateDisplayName();
    this.sql.exec(`INSERT INTO users (id, name) VALUES (?, ?)`, userId, name);
    return { id: userId, name };
  }

  renameUser(userId: string, name: string): { id: string; name: string } {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) {
      throw new Error("Name cannot be empty");
    }
    this.ensureUser(userId);
    this.sql.exec(`UPDATE users SET name = ? WHERE id = ?`, trimmed, userId);
    return { id: userId, name: trimmed };
  }

  listThreads(): ThreadSummary[] {
    return this.sql
      .exec<{
        id: number;
        title: string;
        authorId: string;
        authorName: string;
        createdAt: string;
        bumpedAt: string;
        replyCount: number;
      }>(
        `SELECT
           t.id AS id,
           t.title AS title,
           t.user_id AS authorId,
           u.name AS authorName,
           t.created_at AS createdAt,
           t.bumped_at AS bumpedAt,
           (SELECT COUNT(*) - 1 FROM posts p WHERE p.thread_id = t.id) AS replyCount
         FROM threads t
         JOIN users u ON u.id = t.user_id
         ORDER BY t.bumped_at DESC, t.id DESC
         LIMIT 100`,
      )
      .toArray();
  }

  getThread(threadId: number): ThreadDetail | null {
    const thread = this.sql
      .exec<{
        id: number;
        title: string;
        authorId: string;
        authorName: string;
        createdAt: string;
        bumpedAt: string;
        replyCount: number;
      }>(
        `SELECT
           t.id AS id,
           t.title AS title,
           t.user_id AS authorId,
           u.name AS authorName,
           t.created_at AS createdAt,
           t.bumped_at AS bumpedAt,
           (SELECT COUNT(*) - 1 FROM posts p WHERE p.thread_id = t.id) AS replyCount
         FROM threads t
         JOIN users u ON u.id = t.user_id
         WHERE t.id = ?`,
        threadId,
      )
      .toArray()[0];

    if (!thread) return null;

    const posts = this.sql
      .exec<{
        id: number;
        threadId: number;
        body: string;
        authorId: string;
        authorName: string;
        createdAt: string;
      }>(
        `SELECT
           p.id AS id,
           p.thread_id AS threadId,
           p.body AS body,
           p.user_id AS authorId,
           u.name AS authorName,
           p.created_at AS createdAt
         FROM posts p
         JOIN users u ON u.id = p.user_id
         WHERE p.thread_id = ?
         ORDER BY p.id ASC`,
        threadId,
      )
      .toArray();

    return { ...thread, posts };
  }

  createThread(userId: string, title: string, body: string): ThreadDetail {
    const cleanTitle = title.trim().slice(0, 120);
    const cleanBody = body.trim().slice(0, 5000);
    if (!cleanTitle || !cleanBody) {
      throw new Error("Title and body are required");
    }

    this.ensureUser(userId);
    this.sql.exec(
      `INSERT INTO threads (user_id, title) VALUES (?, ?)`,
      userId,
      cleanTitle,
    );
    const threadRow = this.sql
      .exec<{ id: number }>(`SELECT id FROM threads ORDER BY id DESC LIMIT 1`)
      .one();

    this.sql.exec(
      `INSERT INTO posts (thread_id, user_id, body) VALUES (?, ?, ?)`,
      threadRow.id,
      userId,
      cleanBody,
    );

    const detail = this.getThread(threadRow.id);
    if (!detail) throw new Error("Failed to create thread");
    return detail;
  }

  replyToThread(userId: string, threadId: number, body: string): Post {
    const cleanBody = body.trim().slice(0, 5000);
    if (!cleanBody) {
      throw new Error("Body is required");
    }

    const exists = this.sql
      .exec<{ id: number }>(`SELECT id FROM threads WHERE id = ?`, threadId)
      .toArray()[0];
    if (!exists) {
      throw new Error("Thread not found");
    }

    const user = this.ensureUser(userId);
    this.sql.exec(
      `INSERT INTO posts (thread_id, user_id, body) VALUES (?, ?, ?)`,
      threadId,
      userId,
      cleanBody,
    );
    this.sql.exec(
      `UPDATE threads SET bumped_at = datetime('now') WHERE id = ?`,
      threadId,
    );

    const row = this.sql
      .exec<{ id: number; createdAt: string }>(
        `SELECT id, created_at AS createdAt FROM posts ORDER BY id DESC LIMIT 1`,
      )
      .one();

    return {
      id: row.id,
      threadId,
      body: cleanBody,
      authorId: user.id,
      authorName: user.name,
      createdAt: row.createdAt,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = request.headers.get("X-User-Id");

    if (!userId) {
      return Response.json({ error: "Missing user id" }, { status: 400 });
    }

    try {
      if (request.method === "GET" && url.pathname === "/me") {
        return Response.json({ user: this.ensureUser(userId) });
      }

      if (request.method === "PATCH" && url.pathname === "/me") {
        const { name } = (await request.json()) as { name?: string };
        if (typeof name !== "string") {
          return Response.json({ error: "name required" }, { status: 400 });
        }
        return Response.json({ user: this.renameUser(userId, name) });
      }

      if (request.method === "GET" && url.pathname === "/threads") {
        return Response.json({
          category: "general",
          threads: this.listThreads(),
        });
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
        const thread = this.createThread(userId, title, body);
        return Response.json({ thread }, { status: 201 });
      }

      const threadMatch = url.pathname.match(/^\/threads\/(\d+)$/);
      if (request.method === "GET" && threadMatch) {
        const thread = this.getThread(Number(threadMatch[1]));
        if (!thread) {
          return Response.json({ error: "Thread not found" }, { status: 404 });
        }
        return Response.json({ category: "general", thread });
      }

      const replyMatch = url.pathname.match(/^\/threads\/(\d+)\/posts$/);
      if (request.method === "POST" && replyMatch) {
        const { body } = (await request.json()) as { body?: string };
        if (typeof body !== "string") {
          return Response.json({ error: "body required" }, { status: 400 });
        }
        const post = this.replyToThread(userId, Number(replyMatch[1]), body);
        return Response.json({ post }, { status: 201 });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Server error";
      const status = message === "Thread not found" ? 404 : 400;
      return Response.json({ error: message }, { status });
    }
  }
}
