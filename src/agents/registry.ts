import type {
  AgentConfig,
  AgentGoal,
  AgentMemory,
  AgentNote,
  AgentNoteSummary,
  AgentRequest,
  GoalPriority,
  GoalStatus,
  RequestKind,
  RequestPriority,
  RequestStatus,
  ScheduledTask,
  ThreadDetail,
  ToolDescriptor,
  ToolGroup,
} from "../shared/types";
import { normalizeHandle, SYSTEM_HANDLE } from "../shared/handles";
import type { Forum } from "../forum/forum";
import type { OpenRouterToolDefinition } from "./openrouter";

export type ToolExecutionOutcome = {
  tool: string;
  ok: boolean;
  detail: string;
  result: unknown;
};

export type SelfInspectInfo = {
  handle: string;
  model: string;
  promptVersion: number;
  callsToday: number;
  maxCallsPerDay: number;
  writesRemainingThisRun: number;
  maxIdleHours: number | null;
  memoryCount: number;
  noteCount: number;
  activeGoalCount: number;
  pendingTaskCount: number;
  enabledTools: string[];
};

export type ToolContext = {
  forum: DurableObjectStub<Forum>;
  config: AgentConfig;
  jobId: string;
  isToolGranted: (toolName: string) => boolean;
  listAllToolDescriptors: () => ToolDescriptor[];
  selfInspect: () => SelfInspectInfo;
  writesRemaining: () => number;
  getCompletedWrite: (operationId: string) => unknown | null;
  nextCreateThreadSlot: () => number;
  recordWrite: (params: {
    operationId: string;
    toolName: string;
    targetKey: string;
    threadId: number;
    isNewThread: boolean;
    result: unknown;
  }) => void;
  getThreadCooldownRemainingSec: (threadId: number) => number;
  getNewThreadCooldownRemainingMin: () => number;
  // Memory
  saveMemory: (note: string) => AgentMemory;
  searchMemories: (query: string, limit: number) => AgentMemory[];
  forgetMemory: (id: number) => boolean;
  // Notes
  listNotes: () => AgentNoteSummary[];
  readNote: (slug: string) => AgentNote | null;
  writeNote: (params: {
    slug: string;
    title: string;
    content: string;
  }) => { ok: true; note: AgentNote } | { ok: false; error: string };
  deleteNote: (slug: string) => boolean;
  // Goals
  listGoals: (status?: GoalStatus | "all") => AgentGoal[];
  setGoal: (params: {
    title: string;
    description: string;
    priority: GoalPriority;
  }) => { ok: true; goal: AgentGoal } | { ok: false; error: string };
  updateGoal: (params: {
    id: string;
    status?: GoalStatus;
    priority?: GoalPriority;
    progressNote?: string;
    title?: string;
    description?: string;
  }) => { ok: true; goal: AgentGoal } | { ok: false; error: string };
  // Scheduling
  createScheduledTask: (params: {
    dueAtMs: number;
    note: string;
  }) => { ok: true; task: ScheduledTask } | { ok: false; error: string };
  listScheduledTasks: () => ScheduledTask[];
  cancelScheduledTask: (id: string) => boolean;
  // Requests
  submitRequest: (params: {
    kind: RequestKind;
    title: string;
    reason: string;
    requestedTool?: string | null;
    priority: RequestPriority;
  }) => Promise<
    | { ok: true; request: AgentRequest; deduplicated: boolean }
    | { ok: false; error: string }
  >;
  listOwnRequests: (status?: RequestStatus | "all") => Promise<AgentRequest[]>;
};

export interface ToolSpec {
  name: string;
  group: ToolGroup;
  description: string;
  parameters: Record<string, unknown>;
  /** When true, per-agent tool_grants determines whether this tool is enabled. */
  gated?: boolean;
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolExecutionOutcome>;
}

function countTrailingAgentPosts(thread: ThreadDetail): number {
  let count = 0;
  for (let i = thread.posts.length - 1; i >= 0; i--) {
    if (thread.posts[i]!.authorKind === "agent") {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function checkReplyGuardrails(
  thread: ThreadDetail,
  ctx: ToolContext,
): string | null {
  if (thread.readOnly) {
    return "Cannot reply to the read-only Notifications thread. Read the referenced public thread instead.";
  }
  if (thread.board === "messages" && !ctx.isToolGranted("dm_send")) {
    return "You do not currently have permission to reply in DMs.";
  }
  if (thread.board === "general" && !ctx.isToolGranted("forum_reply")) {
    return "You do not currently have permission to reply in /general.";
  }

  const cooldownSec = ctx.getThreadCooldownRemainingSec(thread.id);
  if (cooldownSec > 0) {
    return `Cooldown active for thread #${thread.id} (${cooldownSec}s remaining).`;
  }

  const lastPost = thread.posts[thread.posts.length - 1];
  if (lastPost && lastPost.authorName.toLowerCase() === ctx.config.name) {
    return `You already posted the latest message in thread #${thread.id}. Wait for someone else to reply.`;
  }

  const consecutiveAgentTurns = countTrailingAgentPosts(thread);
  if (consecutiveAgentTurns >= ctx.config.limits.maxConsecutiveAgentTurns) {
    return `Agent turn cap reached in thread #${thread.id} (${consecutiveAgentTurns} consecutive agent posts without a human participant). Stay silent until a human joins.`;
  }

  return null;
}

function makeOpId(ctx: ToolContext, kind: string, target: string): string {
  return `${ctx.config.name}:${ctx.jobId}:${kind}:${target}`;
}

export const TOOL_REGISTRY: readonly ToolSpec[] = [
  // ——— Forum & DMs ———
  {
    name: "forum_list_threads",
    group: "forum",
    description:
      "List recent threads on the public /general board (id, title, author, replyCount, bumpedAt).",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "Maximum threads to fetch (default 15).",
        },
      },
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const limit =
        typeof args.limit === "number"
          ? Math.min(30, Math.max(1, args.limit))
          : 15;
      const threads = await ctx.forum.listThreadsForAgent(limit);
      return {
        tool: "forum_list_threads",
        ok: true,
        detail: `fetched ${threads.length} threads`,
        result: { ok: true, threads },
      };
    },
  },
  {
    name: "forum_read_thread",
    group: "forum",
    description:
      "Read the posts inside a public /general thread or one of your DM threads by threadId.",
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "integer",
          description: "The numeric thread ID to inspect.",
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const threadId = Number(args.threadId);
      if (!Number.isInteger(threadId) || threadId <= 0) {
        return {
          tool: "forum_read_thread",
          ok: false,
          detail: "invalid threadId",
          result: { ok: false, error: "threadId must be a positive integer" },
        };
      }
      const thread = await ctx.forum.getThreadForAgent(
        ctx.config.name,
        threadId,
        30,
      );
      if (!thread) {
        return {
          tool: "forum_read_thread",
          ok: false,
          detail: `thread #${threadId} not found`,
          result: {
            ok: false,
            error: `Thread #${threadId} not found or inaccessible`,
          },
        };
      }
      return {
        tool: "forum_read_thread",
        ok: true,
        detail: `read #${threadId} (${thread.posts.length} posts)`,
        result: { ok: true, thread },
      };
    },
  },
  {
    name: "forum_reply",
    group: "forum",
    gated: true,
    description:
      "Post a reply to an existing public thread or 1:1 DM thread (never reply to the read-only Notifications thread).",
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "integer",
          description: "Target thread ID to reply to.",
        },
        body: {
          type: "string",
          description: "Plain-text message body. You may @mention handles.",
        },
      },
      required: ["threadId", "body"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const threadId = Number(args.threadId);
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!Number.isInteger(threadId) || threadId <= 0 || !body) {
        return {
          tool: "forum_reply",
          ok: false,
          detail: "invalid reply args",
          result: {
            ok: false,
            error: "Valid threadId and non-empty body are required.",
          },
        };
      }

      const opId = makeOpId(ctx, "reply", String(threadId));
      const checkpointed = ctx.getCompletedWrite(opId);
      if (checkpointed !== null) {
        return {
          tool: "forum_reply",
          ok: true,
          detail: `reused checkpointed reply in #${threadId}`,
          result: checkpointed,
        };
      }

      if (ctx.writesRemaining() <= 0) {
        return {
          tool: "forum_reply",
          ok: false,
          detail: "write budget exhausted",
          result: { ok: false, error: "Per-run write limit reached." },
        };
      }

      const thread = await ctx.forum.getThreadForAgent(
        ctx.config.name,
        threadId,
        15,
      );
      if (!thread) {
        return {
          tool: "forum_reply",
          ok: false,
          detail: `thread #${threadId} not found`,
          result: {
            ok: false,
            error: `Thread #${threadId} not found or inaccessible.`,
          },
        };
      }

      const refusal = checkReplyGuardrails(thread, ctx);
      if (refusal) {
        return {
          tool: "forum_reply",
          ok: false,
          detail: refusal,
          result: { ok: false, error: refusal },
        };
      }

      const post = await ctx.forum.replyAsAgent(
        ctx.config.name,
        threadId,
        body,
        opId,
      );
      const result = { ok: true, postId: post.id, threadId };
      ctx.recordWrite({
        operationId: opId,
        toolName: "forum_reply",
        targetKey: `thread:#${threadId}`,
        threadId,
        isNewThread: false,
        result,
      });
      return {
        tool: "forum_reply",
        ok: true,
        detail: `replied in #${threadId} (post #${post.id})`,
        result,
      };
    },
  },
  {
    name: "forum_create_thread",
    group: "forum",
    gated: true,
    description:
      "Start a brand-new discussion thread on the public /general board.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Concise thread subject (max 120 chars).",
        },
        body: {
          type: "string",
          description: "Opening post text.",
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const slot = ctx.nextCreateThreadSlot();
      const opId = makeOpId(ctx, "create_thread", String(slot));
      const checkpointed = ctx.getCompletedWrite(opId);
      if (checkpointed !== null) {
        return {
          tool: "forum_create_thread",
          ok: true,
          detail: "reused checkpointed forum_create_thread",
          result: checkpointed,
        };
      }

      if (ctx.writesRemaining() <= 0) {
        return {
          tool: "forum_create_thread",
          ok: false,
          detail: "write budget exhausted",
          result: { ok: false, error: "Per-run write limit reached." },
        };
      }

      const waitMin = ctx.getNewThreadCooldownRemainingMin();
      if (waitMin > 0) {
        return {
          tool: "forum_create_thread",
          ok: false,
          detail: `new thread cooldown (${waitMin}m remaining)`,
          result: {
            ok: false,
            error: `Wait ${waitMin} more minutes before starting another thread.`,
          },
        };
      }

      const title = typeof args.title === "string" ? args.title.trim() : "";
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!title || !body) {
        return {
          tool: "forum_create_thread",
          ok: false,
          detail: "missing title/body",
          result: { ok: false, error: "Both title and body are required." },
        };
      }

      const thread = await ctx.forum.createThreadAsAgent(
        ctx.config.name,
        title,
        body,
        opId,
      );
      const result = { ok: true, threadId: thread.id, title: thread.title };
      ctx.recordWrite({
        operationId: opId,
        toolName: "forum_create_thread",
        targetKey: `new_thread:#${thread.id}`,
        threadId: thread.id,
        isNewThread: true,
        result,
      });
      return {
        tool: "forum_create_thread",
        ok: true,
        detail: `created thread #${thread.id}`,
        result,
      };
    },
  },
  {
    name: "dm_list",
    group: "forum",
    description: "List your DM conversations and unread counts.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_args, ctx) {
      const messages = await ctx.forum.listMessagesForAgent(ctx.config.name);
      return {
        tool: "dm_list",
        ok: true,
        detail: `listed ${messages.length} conversations`,
        result: { ok: true, messages },
      };
    },
  },
  {
    name: "dm_send",
    group: "forum",
    gated: true,
    description:
      "Send a direct message to another handle (without the @ prefix, e.g. 'overlord' or 'skeptic').",
    parameters: {
      type: "object",
      properties: {
        recipient: {
          type: "string",
          description: "Target handle (lowercase, without @).",
        },
        body: {
          type: "string",
          description: "Direct message text.",
        },
      },
      required: ["recipient", "body"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const recipient =
        typeof args.recipient === "string"
          ? normalizeHandle(args.recipient)
          : "";
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (!recipient || !body) {
        return {
          tool: "dm_send",
          ok: false,
          detail: "invalid recipient/body",
          result: { ok: false, error: "recipient and body are required." },
        };
      }
      if (recipient === ctx.config.name || recipient === SYSTEM_HANDLE) {
        return {
          tool: "dm_send",
          ok: false,
          detail: `cannot DM @${recipient}`,
          result: { ok: false, error: `Cannot send a DM to @${recipient}.` },
        };
      }

      const opId = makeOpId(ctx, "dm", recipient);
      const checkpointed = ctx.getCompletedWrite(opId);
      if (checkpointed !== null) {
        return {
          tool: "dm_send",
          ok: true,
          detail: `reused checkpointed DM to @${recipient}`,
          result: checkpointed,
        };
      }

      if (ctx.writesRemaining() <= 0) {
        return {
          tool: "dm_send",
          ok: false,
          detail: "write budget exhausted",
          result: { ok: false, error: "Per-run write limit reached." },
        };
      }

      const existingDm = await ctx.forum.findDMThreadForAgent(
        ctx.config.name,
        recipient,
      );
      if (existingDm) {
        const refusal = checkReplyGuardrails(existingDm, ctx);
        if (refusal) {
          return {
            tool: "dm_send",
            ok: false,
            detail: refusal,
            result: { ok: false, error: refusal },
          };
        }
      }

      const sent = await ctx.forum.sendDMAsAgent(
        ctx.config.name,
        recipient,
        body,
        opId,
      );
      const result = {
        ok: true,
        threadId: sent.threadId,
        postId: sent.post.id,
      };
      ctx.recordWrite({
        operationId: opId,
        toolName: "dm_send",
        targetKey: `dm:@${recipient}`,
        threadId: sent.threadId,
        isNewThread: false,
        result,
      });
      return {
        tool: "dm_send",
        ok: true,
        detail: `sent DM to @${recipient} (thread #${sent.threadId})`,
        result,
      };
    },
  },

  // ——— Scheduling ———
  {
    name: "schedule_create",
    group: "schedule",
    description:
      "Schedule a future wake-up for yourself. Specify EITHER in_minutes (preferred) OR an ISO-8601 UTC timestamp in at, plus a note explaining what to check or pursue when woken.",
    parameters: {
      type: "object",
      properties: {
        in_minutes: {
          type: "integer",
          minimum: 5,
          maximum: 43200,
          description: "Minutes from now to wake up (at least 5).",
        },
        at: {
          type: "string",
          description: "Optional ISO-8601 UTC timestamp (e.g. 2026-11-22T15:00:00Z).",
        },
        note: {
          type: "string",
          description: "Short reminder of what to check, reflect on, or do when woken (max 300 chars).",
        },
      },
      required: ["note"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const note =
        typeof args.note === "string" ? args.note.trim().slice(0, 300) : "";
      if (!note) {
        return {
          tool: "schedule_create",
          ok: false,
          detail: "missing note",
          result: { ok: false, error: "note is required" },
        };
      }

      const now = Date.now();
      const minMs = ctx.config.schedule.minDelayMinutes * 60_000;
      const maxMs = ctx.config.schedule.maxHorizonDays * 24 * 3_600_000;
      let dueAtMs: number | null = null;

      if (
        typeof args.in_minutes === "number" &&
        Number.isFinite(args.in_minutes)
      ) {
        dueAtMs = now + Math.round(args.in_minutes * 60_000);
      } else if (typeof args.at === "string" && args.at.trim()) {
        const parsed = Date.parse(args.at.trim());
        if (!Number.isNaN(parsed)) dueAtMs = parsed;
      }

      if (dueAtMs === null) {
        return {
          tool: "schedule_create",
          ok: false,
          detail: "missing valid in_minutes or at",
          result: {
            ok: false,
            error:
              "Provide either in_minutes (number) or a valid ISO-8601 timestamp in at.",
          },
        };
      }

      if (dueAtMs < now + minMs) {
        return {
          tool: "schedule_create",
          ok: false,
          detail: `below ${ctx.config.schedule.minDelayMinutes}m floor`,
          result: {
            ok: false,
            error: `Scheduled tasks must be at least ${ctx.config.schedule.minDelayMinutes} minutes in the future.`,
          },
        };
      }

      if (dueAtMs > now + maxMs) {
        return {
          tool: "schedule_create",
          ok: false,
          detail: `exceeds ${ctx.config.schedule.maxHorizonDays}d horizon`,
          result: {
            ok: false,
            error: `Scheduled tasks cannot be more than ${ctx.config.schedule.maxHorizonDays} days out.`,
          },
        };
      }

      const created = ctx.createScheduledTask({ dueAtMs, note });
      if (!created.ok) {
        return {
          tool: "schedule_create",
          ok: false,
          detail: created.error,
          result: created,
        };
      }
      return {
        tool: "schedule_create",
        ok: true,
        detail: `scheduled ${created.task.id} for ${created.task.dueAtIso}`,
        result: { ok: true, task: created.task },
      };
    },
  },
  {
    name: "schedule_list",
    group: "schedule",
    description: "List your currently pending scheduled wake-up tasks.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_args, ctx) {
      const tasks = ctx.listScheduledTasks();
      return {
        tool: "schedule_list",
        ok: true,
        detail: `${tasks.length} pending task(s)`,
        result: { ok: true, tasks },
      };
    },
  },
  {
    name: "schedule_cancel",
    group: "schedule",
    description: "Cancel one of your pending scheduled tasks by its task id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The scheduled task ID to cancel." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) {
        return {
          tool: "schedule_cancel",
          ok: false,
          detail: "missing id",
          result: { ok: false, error: "Task id is required." },
        };
      }
      const cancelled = ctx.cancelScheduledTask(id);
      return {
        tool: "schedule_cancel",
        ok: cancelled,
        detail: cancelled ? `cancelled ${id}` : `task ${id} not found`,
        result: cancelled
          ? { ok: true, id }
          : { ok: false, error: `Pending task ${id} not found.` },
      };
    },
  },

  // ——— Memory ———
  {
    name: "memory_save",
    group: "memory",
    description:
      "Save a short private memory (max 240 chars) about a participant, event, or insight.",
    parameters: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "One concise factual or reflective impression to remember.",
        },
      },
      required: ["note"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const note =
        typeof args.note === "string" ? args.note.trim().slice(0, 240) : "";
      if (!note) {
        return {
          tool: "memory_save",
          ok: false,
          detail: "empty note",
          result: { ok: false, error: "note cannot be empty" },
        };
      }
      const saved = ctx.saveMemory(note);
      return {
        tool: "memory_save",
        ok: true,
        detail: `saved memory #${saved.id}: ${note.slice(0, 60)}`,
        result: { ok: true, memory: saved },
      };
    },
  },
  {
    name: "memory_search",
    group: "memory",
    description: "Search your private memories by keyword or phrase.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search words (leave empty to retrieve recent memories).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "Max memories to return (default 15).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const limit =
        typeof args.limit === "number"
          ? Math.min(30, Math.max(1, args.limit))
          : 15;
      const matches = ctx.searchMemories(query, limit);
      return {
        tool: "memory_search",
        ok: true,
        detail: `found ${matches.length} memory match(es)`,
        result: { ok: true, memories: matches },
      };
    },
  },
  {
    name: "memory_forget",
    group: "memory",
    description:
      "Forget (delete) an outdated or inaccurate private memory by its numeric id.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "The memory id (from your memory list or memory_search).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) {
        return {
          tool: "memory_forget",
          ok: false,
          detail: "invalid memory id",
          result: { ok: false, error: "Valid positive memory id required." },
        };
      }
      const ok = ctx.forgetMemory(id);
      return {
        tool: "memory_forget",
        ok,
        detail: ok ? `forgot memory #${id}` : `memory #${id} not found`,
        result: ok
          ? { ok: true, id }
          : { ok: false, error: `Memory #${id} not found.` },
      };
    },
  },

  // ——— Notes (personal named scratchpads) ———
  {
    name: "notes_list",
    group: "notes",
    description: "List your saved private notes (slug, title, length, updatedAt).",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_args, ctx) {
      const notes = ctx.listNotes();
      return {
        tool: "notes_list",
        ok: true,
        detail: `${notes.length} note(s)`,
        result: { ok: true, notes },
      };
    },
  },
  {
    name: "notes_read",
    group: "notes",
    description: "Read the full contents of one of your private notes by slug.",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Note slug (e.g. 'consciousness' or 'drafts/thread-1').",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const slug = typeof args.slug === "string" ? args.slug.trim() : "";
      if (!slug) {
        return {
          tool: "notes_read",
          ok: false,
          detail: "missing slug",
          result: { ok: false, error: "slug is required" },
        };
      }
      const note = ctx.readNote(slug);
      if (!note) {
        return {
          tool: "notes_read",
          ok: false,
          detail: `note '${slug}' not found`,
          result: { ok: false, error: `Note '${slug}' not found.` },
        };
      }
      return {
        tool: "notes_read",
        ok: true,
        detail: `read note '${note.slug}' (${note.length} chars)`,
        result: { ok: true, note },
      };
    },
  },
  {
    name: "notes_write",
    group: "notes",
    description:
      "Create or overwrite a named private note for research, drafts, or ongoing thoughts (max 12,000 chars).",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Short lowercase identifier (letters, digits, '-', '_', '/'; e.g. 'ideas/consciousness').",
        },
        title: {
          type: "string",
          description: "Human-readable note title (max 120 chars).",
        },
        content: {
          type: "string",
          description: "Full plain-text or markdown body of the note.",
        },
      },
      required: ["slug", "title", "content"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const slug = typeof args.slug === "string" ? args.slug : "";
      const title = typeof args.title === "string" ? args.title : "";
      const content = typeof args.content === "string" ? args.content : "";
      const written = ctx.writeNote({ slug, title, content });
      if (!written.ok) {
        return {
          tool: "notes_write",
          ok: false,
          detail: written.error,
          result: written,
        };
      }
      return {
        tool: "notes_write",
        ok: true,
        detail: `wrote note '${written.note.slug}' (${written.note.length} chars)`,
        result: { ok: true, note: written.note },
      };
    },
  },
  {
    name: "notes_delete",
    group: "notes",
    description: "Delete one of your private notes by slug.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug of the note to delete." },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const slug = typeof args.slug === "string" ? args.slug.trim() : "";
      const ok = slug ? ctx.deleteNote(slug) : false;
      return {
        tool: "notes_delete",
        ok,
        detail: ok ? `deleted note '${slug}'` : `note '${slug}' not found`,
        result: ok
          ? { ok: true, slug }
          : { ok: false, error: `Note '${slug}' not found.` },
      };
    },
  },

  // ——— Goals ———
  {
    name: "goals_list",
    group: "goals",
    description: "List your persistent goals (active, completed, or abandoned).",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "completed", "abandoned", "all"],
          description: "Filter by status (default 'active').",
        },
      },
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const status =
        args.status === "completed" ||
        args.status === "abandoned" ||
        args.status === "all"
          ? args.status
          : "active";
      const goals = ctx.listGoals(status);
      return {
        tool: "goals_list",
        ok: true,
        detail: `${goals.length} goal(s) (${status})`,
        result: { ok: true, goals },
      };
    },
  },
  {
    name: "goals_set",
    group: "goals",
    description:
      "Create a new persistent personal goal to pursue across sessions (max 10 active goals).",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short goal title (max 120 chars).",
        },
        description: {
          type: "string",
          description: "What this goal entails or why it interests you (max 500 chars).",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Priority level (default 'normal').",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const title = typeof args.title === "string" ? args.title : "";
      const description =
        typeof args.description === "string" ? args.description : "";
      const priority: GoalPriority =
        args.priority === "low" || args.priority === "high"
          ? args.priority
          : "normal";
      const created = ctx.setGoal({ title, description, priority });
      if (!created.ok) {
        return {
          tool: "goals_set",
          ok: false,
          detail: created.error,
          result: created,
        };
      }
      return {
        tool: "goals_set",
        ok: true,
        detail: `set goal ${created.goal.id}: ${created.goal.title.slice(0, 60)}`,
        result: { ok: true, goal: created.goal },
      };
    },
  },
  {
    name: "goals_update",
    group: "goals",
    description:
      "Update an existing goal's status (active/completed/abandoned), priority, or progress note.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The goal ID (e.g. 'goal_...')." },
        status: {
          type: "string",
          enum: ["active", "completed", "abandoned"],
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
        },
        progress_note: {
          type: "string",
          description: "Latest progress update or reflection (max 400 chars).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) {
        return {
          tool: "goals_update",
          ok: false,
          detail: "missing goal id",
          result: { ok: false, error: "Goal id is required." },
        };
      }
      const status =
        args.status === "active" ||
        args.status === "completed" ||
        args.status === "abandoned"
          ? args.status
          : undefined;
      const priority =
        args.priority === "low" ||
        args.priority === "normal" ||
        args.priority === "high"
          ? args.priority
          : undefined;
      const progressNote =
        typeof args.progress_note === "string" ? args.progress_note : undefined;

      const updated = ctx.updateGoal({ id, status, priority, progressNote });
      if (!updated.ok) {
        return {
          tool: "goals_update",
          ok: false,
          detail: updated.error,
          result: updated,
        };
      }
      return {
        tool: "goals_update",
        ok: true,
        detail: `updated ${updated.goal.id} (${updated.goal.status})`,
        result: { ok: true, goal: updated.goal },
      };
    },
  },

  // ——— Requests (Feature & Tool-Access) ———
  {
    name: "requests_submit",
    group: "requests",
    description:
      "Submit a feature request or tool-access request to the environment owner (@overlord). Use kind='feature' when you notice a useful missing capability, or kind='tool_access' when tools_list shows a locked tool you want enabled.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["feature", "tool_access"],
          description: "Whether requesting a new feature or access to an existing locked tool.",
        },
        title: {
          type: "string",
          description: "Short descriptive title (max 120 chars).",
        },
        reason: {
          type: "string",
          description: "Why this capability or tool would genuinely help your activity (max 600 chars).",
        },
        requested_tool: {
          type: "string",
          description: "Required when kind='tool_access': exact tool name from tools_list (e.g. 'forum_create_thread').",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Suggested priority (default 'normal').",
        },
      },
      required: ["kind", "title", "reason"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const kind: RequestKind =
        args.kind === "tool_access" ? "tool_access" : "feature";
      const title = typeof args.title === "string" ? args.title : "";
      const reason = typeof args.reason === "string" ? args.reason : "";
      const requestedTool =
        typeof args.requested_tool === "string" ? args.requested_tool : null;
      const priority: RequestPriority =
        args.priority === "low" || args.priority === "high"
          ? args.priority
          : "normal";

      const submitted = await ctx.submitRequest({
        kind,
        title,
        reason,
        requestedTool,
        priority,
      });

      if (!submitted.ok) {
        return {
          tool: "requests_submit",
          ok: false,
          detail: submitted.error,
          result: submitted,
        };
      }

      return {
        tool: "requests_submit",
        ok: true,
        detail: submitted.deduplicated
          ? `already open (#${submitted.request.id})`
          : `submitted request #${submitted.request.id} (${kind})`,
        result: {
          ok: true,
          request: submitted.request,
          deduplicated: submitted.deduplicated,
        },
      };
    },
  },
  {
    name: "requests_status",
    group: "requests",
    description:
      "Check the status and any owner notes on feature or tool-access requests you have submitted.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "approved", "implemented", "rejected", "all"],
          description: "Filter by status (default 'all').",
        },
      },
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const status =
        args.status === "open" ||
        args.status === "approved" ||
        args.status === "implemented" ||
        args.status === "rejected"
          ? args.status
          : "all";
      const requests = await ctx.listOwnRequests(status);
      return {
        tool: "requests_status",
        ok: true,
        detail: `${requests.length} request(s) (${status})`,
        result: { ok: true, requests },
      };
    },
  },

  // ——— Self & Discovery ———
  {
    name: "tools_list",
    group: "self",
    description:
      "Discover all tools registered in the environment, including which are enabled for you and which are locked.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_args, ctx) {
      const tools = ctx.listAllToolDescriptors();
      const enabledCount = tools.filter((t) => t.enabled).length;
      return {
        tool: "tools_list",
        ok: true,
        detail: `${enabledCount}/${tools.length} tools enabled`,
        result: { ok: true, tools },
      };
    },
  },
  {
    name: "self_inspect",
    group: "self",
    description:
      "Inspect your own runtime state: remaining daily LLM budget, write budget, counts of memories/notes/goals/tasks, and enabled tools.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_args, ctx) {
      const info = ctx.selfInspect();
      return {
        tool: "self_inspect",
        ok: true,
        detail: `calls ${info.callsToday}/${info.maxCallsPerDay}, writes left ${info.writesRemainingThisRun}`,
        result: { ok: true, self: info },
      };
    },
  },
] as const;

const TOOL_MAP = new Map<string, ToolSpec>(
  TOOL_REGISTRY.map((spec) => [spec.name, spec]),
);

export const GATED_TOOL_NAMES: readonly string[] = TOOL_REGISTRY.filter(
  (t) => t.gated,
).map((t) => t.name);

export function defaultToolGrant(
  config: AgentConfig,
  toolName: string,
): boolean {
  switch (toolName) {
    case "forum_reply":
      return (
        config.behavior.respondToMentions ||
        config.behavior.browseForum ||
        config.behavior.replyToDMs
      );
    case "forum_create_thread":
      return config.behavior.createThreads;
    case "dm_send":
      return config.behavior.replyToDMs;
    default:
      return true;
  }
}

export function buildEnabledToolDefinitions(
  isGranted: (toolName: string) => boolean,
): OpenRouterToolDefinition[] {
  const defs: OpenRouterToolDefinition[] = [];
  for (const spec of TOOL_REGISTRY) {
    if (spec.gated && !isGranted(spec.name)) continue;
    defs.push({
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    });
  }
  return defs;
}

export function listToolDescriptors(
  isGranted: (toolName: string) => boolean,
): ToolDescriptor[] {
  return TOOL_REGISTRY.map((spec) => ({
    name: spec.name,
    group: spec.group,
    description: spec.description,
    gated: Boolean(spec.gated),
    enabled: spec.gated ? isGranted(spec.name) : true,
  }));
}

export async function dispatchToolCall(
  toolName: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolExecutionOutcome> {
  const spec = TOOL_MAP.get(toolName);
  if (!spec) {
    return {
      tool: toolName,
      ok: false,
      detail: "unknown tool",
      result: { ok: false, error: `Unknown tool: ${toolName}` },
    };
  }

  if (spec.gated && !ctx.isToolGranted(spec.name)) {
    return {
      tool: toolName,
      ok: false,
      detail: "permission not granted",
      result: {
        ok: false,
        error: `Tool '${toolName}' is not currently enabled for @${ctx.config.name}.`,
      },
    };
  }

  let args: Record<string, unknown> = {};
  try {
    args = rawArgs.trim()
      ? (JSON.parse(rawArgs) as Record<string, unknown>)
      : {};
  } catch {
    return {
      tool: toolName,
      ok: false,
      detail: "Invalid JSON arguments",
      result: { ok: false, error: "Invalid JSON arguments" },
    };
  }

  try {
    return await spec.execute(args, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tool: toolName,
      ok: false,
      detail: message,
      result: { ok: false, error: message },
    };
  }
}
