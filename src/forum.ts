import { DurableObject } from "cloudflare:workers";
import { generateDisplayName } from "./names";

export type Post = {
  id: number;
  title: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
};

type Env = {
  FORUM: DurableObjectNamespace<Forum>;
};

/**
 * Single-category forum state ("general").
 * SQLite in a Durable Object gives strong consistency for post ordering
 * without Queues/K2 — those fit async fan-out, not interactive CRUD.
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
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
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
    this.sql.exec(
      `INSERT INTO users (id, name) VALUES (?, ?)`,
      userId,
      name,
    );
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

  listPosts(): Post[] {
    return this.sql
      .exec<{
        id: number;
        title: string;
        body: string;
        authorId: string;
        authorName: string;
        createdAt: string;
      }>(
        `SELECT
           p.id AS id,
           p.title AS title,
           p.body AS body,
           p.user_id AS authorId,
           u.name AS authorName,
           p.created_at AS createdAt
         FROM posts p
         JOIN users u ON u.id = p.user_id
         ORDER BY p.id DESC
         LIMIT 100`,
      )
      .toArray();
  }

  createPost(userId: string, title: string, body: string): Post {
    const cleanTitle = title.trim().slice(0, 120);
    const cleanBody = body.trim().slice(0, 5000);
    if (!cleanTitle || !cleanBody) {
      throw new Error("Title and body are required");
    }

    const user = this.ensureUser(userId);
    this.sql.exec(
      `INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)`,
      userId,
      cleanTitle,
      cleanBody,
    );

    const row = this.sql
      .exec<{ id: number; createdAt: string }>(
        `SELECT id, created_at AS createdAt FROM posts ORDER BY id DESC LIMIT 1`,
      )
      .one();

    return {
      id: row.id,
      title: cleanTitle,
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
        const user = this.ensureUser(userId);
        return Response.json({ user });
      }

      if (request.method === "PATCH" && url.pathname === "/me") {
        const { name } = (await request.json()) as { name?: string };
        if (typeof name !== "string") {
          return Response.json({ error: "name required" }, { status: 400 });
        }
        const user = this.renameUser(userId, name);
        return Response.json({ user });
      }

      if (request.method === "GET" && url.pathname === "/posts") {
        return Response.json({
          category: "general",
          posts: this.listPosts(),
        });
      }

      if (request.method === "POST" && url.pathname === "/posts") {
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
        const post = this.createPost(userId, title, body);
        return Response.json({ post }, { status: 201 });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Server error";
      return Response.json({ error: message }, { status: 400 });
    }
  }
}
