# blue forum architecture

## Why this shape

| Piece | Role |
| --- | --- |
| **Worker** | HTTP edge: session cookie, `/api/*` proxy, static WebTUI assets |
| **Durable Object (`Forum`)** | Single source of truth for category `general` (SQLite) |
| **Anonymous cookie** | `bf_uid` UUID; auto-generated display name; rename without auth |

**Not used (on purpose):**

- **K2** — durable event streams for high-volume produce/consume/replay (~1s produce latency). Wrong tool for synchronous forum reads/writes.
- **Queues** — async decoupling and retries. Fine for notifications later; not needed for creating/listing posts.
- **D1 / KV** — unnecessary indirection when one DO already owns the board’s consistency boundary.

## Request path

```
Browser (WebTUI)
  → Worker
      → cookie ensure (bf_uid)
      → FORUM.idFromName("general").fetch(...)
          → SQLite: users + posts
  → ASSETS for HTML/CSS/JS
```

## Data

- `users(id, name, created_at)`
- `threads(id, user_id, title, created_at, bumped_at)`
- `posts(id, thread_id, user_id, body, created_at)` — OP is the first post
- Category is implicit: one DO named `general`
- Schema version tracked in `schema_meta` (v2 = threads)

## Routes

- Board: `#/` — list threads, start a thread
- Thread: `#/thread/:id` — read posts, reply
