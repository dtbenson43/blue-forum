import type {
  AgentConfig,
  ScheduledTask,
  ThreadDetail,
} from "../shared/types";
import { normalizeHandle, SYSTEM_HANDLE } from "../shared/handles";
import type { Forum } from "../forum/forum";
import type { OpenRouterToolDefinition } from "./openrouter";

export function buildToolDefinitions(
  config: AgentConfig,
): OpenRouterToolDefinition[] {
  const tools: OpenRouterToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "forum_list_threads",
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
      },
    },
    {
      type: "function",
      function: {
        name: "forum_read_thread",
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
      },
    },
    {
      type: "function",
      function: {
        name: "dm_list",
        description: "List your DM conversations and unread counts.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_save",
        description:
          "Save a short private note (max 240 chars) about a user, thread, or insight for your own future reference.",
        parameters: {
          type: "object",
          properties: {
            note: {
              type: "string",
              description: "One concise factual or reflective note to remember.",
            },
          },
          required: ["note"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "schedule_create",
        description: `Schedule a future wake-up for yourself. Specify EITHER in_minutes (at least ${config.schedule.minDelayMinutes}) OR an ISO-8601 UTC timestamp in at, plus a note explaining what you want to do when you wake.`,
        parameters: {
          type: "object",
          properties: {
            in_minutes: {
              type: "integer",
              minimum: config.schedule.minDelayMinutes,
              maximum: config.schedule.maxHorizonDays * 24 * 60,
              description: "Minutes from now to wake up (preferred over ISO timestamps).",
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
      },
    },
    {
      type: "function",
      function: {
        name: "schedule_list",
        description: "List your currently pending scheduled wake-up tasks.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "schedule_cancel",
        description: "Cancel one of your pending scheduled tasks by its task id.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The scheduled task ID to cancel.",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
  ];

  if (
    config.behavior.respondToMentions ||
    config.behavior.browseForum ||
    config.behavior.replyToDMs
  ) {
    tools.push({
      type: "function",
      function: {
        name: "forum_reply",
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
      },
    });
  }

  if (config.behavior.createThreads) {
    tools.push({
      type: "function",
      function: {
        name: "forum_create_thread",
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
      },
    });
  }

  if (config.behavior.replyToDMs) {
    tools.push({
      type: "function",
      function: {
        name: "dm_send",
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
      },
    });
  }

  return tools;
}

export type ToolExecutionHooks = {
  forum: DurableObjectStub<Forum>;
  config: AgentConfig;
  jobId: string;
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
  saveMemory: (note: string) => void;
  createScheduledTask: (params: {
    dueAtMs: number;
    note: string;
  }) => { ok: true; task: ScheduledTask } | { ok: false; error: string };
  listScheduledTasks: () => ScheduledTask[];
  cancelScheduledTask: (id: string) => boolean;
};

export type ToolExecutionOutcome = {
  tool: string;
  ok: boolean;
  detail: string;
  result: unknown;
};

function countTrailingAgentPosts(thread: ThreadDetail): number {
  let count = 0;
  for (let i = thread.posts.length - 1; i >= 0; i--) {
    const post = thread.posts[i]!;
    if (post.authorKind === "agent") {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function checkReplyGuardrails(
  thread: ThreadDetail,
  hooks: ToolExecutionHooks,
): string | null {
  if (thread.readOnly) {
    return "Cannot reply to the read-only Notifications thread. Read the referenced public thread instead.";
  }

  if (thread.board === "messages" && !hooks.config.behavior.replyToDMs) {
    return "Your configuration does not permit replying in DMs.";
  }

  if (
    thread.board === "general" &&
    !hooks.config.behavior.respondToMentions &&
    !hooks.config.behavior.browseForum
  ) {
    return "Your configuration does not permit posting in /general.";
  }

  const cooldownSec = hooks.getThreadCooldownRemainingSec(thread.id);
  if (cooldownSec > 0) {
    return `Cooldown active for thread #${thread.id} (${cooldownSec}s remaining).`;
  }

  const lastPost = thread.posts[thread.posts.length - 1];
  if (lastPost && lastPost.authorName.toLowerCase() === hooks.config.name) {
    return `You already posted the latest message in thread #${thread.id}. Wait for someone else to reply.`;
  }

  const consecutiveAgentTurns = countTrailingAgentPosts(thread);
  if (consecutiveAgentTurns >= hooks.config.limits.maxConsecutiveAgentTurns) {
    return `Agent turn cap reached in thread #${thread.id} (${consecutiveAgentTurns} consecutive agent posts without a human participant). Stay silent until a human joins.`;
  }

  return null;
}

export async function executeAgentTool(
  toolName: string,
  rawArgs: string,
  hooks: ToolExecutionHooks,
): Promise<ToolExecutionOutcome> {
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

  const makeOpId = (kind: string, target: string) =>
    `${hooks.config.name}:${hooks.jobId}:${kind}:${target}`;

  try {
    switch (toolName) {
      case "forum_list_threads": {
        const limit =
          typeof args.limit === "number"
            ? Math.min(30, Math.max(1, args.limit))
            : 15;
        const threads = await hooks.forum.listThreadsForAgent(limit);
        return {
          tool: toolName,
          ok: true,
          detail: `fetched ${threads.length} threads`,
          result: { ok: true, threads },
        };
      }

      case "forum_read_thread": {
        const threadId = Number(args.threadId);
        if (!Number.isInteger(threadId) || threadId <= 0) {
          return {
            tool: toolName,
            ok: false,
            detail: "invalid threadId",
            result: { ok: false, error: "threadId must be a positive integer" },
          };
        }
        const thread = await hooks.forum.getThreadForAgent(
          hooks.config.name,
          threadId,
          30,
        );
        if (!thread) {
          return {
            tool: toolName,
            ok: false,
            detail: `thread #${threadId} not found`,
            result: {
              ok: false,
              error: `Thread #${threadId} not found or inaccessible`,
            },
          };
        }
        return {
          tool: toolName,
          ok: true,
          detail: `read #${threadId} (${thread.posts.length} posts)`,
          result: { ok: true, thread },
        };
      }

      case "dm_list": {
        const messages = await hooks.forum.listMessagesForAgent(
          hooks.config.name,
        );
        return {
          tool: toolName,
          ok: true,
          detail: `listed ${messages.length} conversations`,
          result: { ok: true, messages },
        };
      }

      case "memory_save": {
        const note =
          typeof args.note === "string" ? args.note.trim().slice(0, 240) : "";
        if (!note) {
          return {
            tool: toolName,
            ok: false,
            detail: "empty note",
            result: { ok: false, error: "note cannot be empty" },
          };
        }
        hooks.saveMemory(note);
        return {
          tool: toolName,
          ok: true,
          detail: `saved memory: ${note.slice(0, 60)}`,
          result: { ok: true },
        };
      }

      case "schedule_create": {
        const note =
          typeof args.note === "string" ? args.note.trim().slice(0, 300) : "";
        if (!note) {
          return {
            tool: toolName,
            ok: false,
            detail: "missing note",
            result: { ok: false, error: "note is required" },
          };
        }

        const now = Date.now();
        const minMs = hooks.config.schedule.minDelayMinutes * 60_000;
        const maxMs = hooks.config.schedule.maxHorizonDays * 24 * 3_600_000;
        let dueAtMs: number | null = null;

        if (typeof args.in_minutes === "number" && Number.isFinite(args.in_minutes)) {
          dueAtMs = now + Math.round(args.in_minutes * 60_000);
        } else if (typeof args.at === "string" && args.at.trim()) {
          const parsed = Date.parse(args.at.trim());
          if (!Number.isNaN(parsed)) {
            dueAtMs = parsed;
          }
        }

        if (dueAtMs === null) {
          return {
            tool: toolName,
            ok: false,
            detail: "missing valid in_minutes or at",
            result: {
              ok: false,
              error: "Provide either in_minutes (number) or a valid ISO-8601 timestamp in at.",
            },
          };
        }

        if (dueAtMs < now + minMs) {
          return {
            tool: toolName,
            ok: false,
            detail: `below ${hooks.config.schedule.minDelayMinutes}m floor`,
            result: {
              ok: false,
              error: `Scheduled tasks must be at least ${hooks.config.schedule.minDelayMinutes} minutes in the future.`,
            },
          };
        }

        if (dueAtMs > now + maxMs) {
          return {
            tool: toolName,
            ok: false,
            detail: `exceeds ${hooks.config.schedule.maxHorizonDays}d horizon`,
            result: {
              ok: false,
              error: `Scheduled tasks cannot be more than ${hooks.config.schedule.maxHorizonDays} days out.`,
            },
          };
        }

        const created = hooks.createScheduledTask({ dueAtMs, note });
        if (!created.ok) {
          return {
            tool: toolName,
            ok: false,
            detail: created.error,
            result: created,
          };
        }

        return {
          tool: toolName,
          ok: true,
          detail: `scheduled ${created.task.id} for ${created.task.dueAtIso}`,
          result: { ok: true, task: created.task },
        };
      }

      case "schedule_list": {
        const tasks = hooks.listScheduledTasks();
        return {
          tool: toolName,
          ok: true,
          detail: `${tasks.length} pending task(s)`,
          result: { ok: true, tasks },
        };
      }

      case "schedule_cancel": {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) {
          return {
            tool: toolName,
            ok: false,
            detail: "missing id",
            result: { ok: false, error: "Task id is required." },
          };
        }
        const cancelled = hooks.cancelScheduledTask(id);
        return {
          tool: toolName,
          ok: cancelled,
          detail: cancelled ? `cancelled ${id}` : `task ${id} not found`,
          result: cancelled
            ? { ok: true, id }
            : { ok: false, error: `Pending task ${id} not found.` },
        };
      }

      case "forum_reply": {
        const threadId = Number(args.threadId);
        const body = typeof args.body === "string" ? args.body.trim() : "";
        if (!Number.isInteger(threadId) || threadId <= 0 || !body) {
          return {
            tool: toolName,
            ok: false,
            detail: "invalid reply args",
            result: {
              ok: false,
              error: "Valid threadId and non-empty body are required.",
            },
          };
        }

        const opId = makeOpId("reply", String(threadId));
        const checkpointed = hooks.getCompletedWrite(opId);
        if (checkpointed !== null) {
          return {
            tool: toolName,
            ok: true,
            detail: `reused checkpointed reply in #${threadId}`,
            result: checkpointed,
          };
        }

        if (hooks.writesRemaining() <= 0) {
          return {
            tool: toolName,
            ok: false,
            detail: "write budget exhausted",
            result: { ok: false, error: "Per-run write limit reached." },
          };
        }

        const thread = await hooks.forum.getThreadForAgent(
          hooks.config.name,
          threadId,
          15,
        );
        if (!thread) {
          return {
            tool: toolName,
            ok: false,
            detail: `thread #${threadId} not found`,
            result: {
              ok: false,
              error: `Thread #${threadId} not found or inaccessible.`,
            },
          };
        }

        const refusal = checkReplyGuardrails(thread, hooks);
        if (refusal) {
          return {
            tool: toolName,
            ok: false,
            detail: refusal,
            result: { ok: false, error: refusal },
          };
        }

        const post = await hooks.forum.replyAsAgent(
          hooks.config.name,
          threadId,
          body,
          opId,
        );
        const result = { ok: true, postId: post.id, threadId };
        hooks.recordWrite({
          operationId: opId,
          toolName,
          targetKey: `thread:#${threadId}`,
          threadId,
          isNewThread: false,
          result,
        });
        return {
          tool: toolName,
          ok: true,
          detail: `replied in #${threadId} (post #${post.id})`,
          result,
        };
      }

      case "forum_create_thread": {
        if (!hooks.config.behavior.createThreads) {
          return {
            tool: toolName,
            ok: false,
            detail: "createThreads disabled",
            result: {
              ok: false,
              error: "You are not permitted to create public threads.",
            },
          };
        }

        const slot = hooks.nextCreateThreadSlot();
        const opId = makeOpId("create_thread", String(slot));
        const checkpointed = hooks.getCompletedWrite(opId);
        if (checkpointed !== null) {
          return {
            tool: toolName,
            ok: true,
            detail: "reused checkpointed forum_create_thread",
            result: checkpointed,
          };
        }

        if (hooks.writesRemaining() <= 0) {
          return {
            tool: toolName,
            ok: false,
            detail: "write budget exhausted",
            result: { ok: false, error: "Per-run write limit reached." },
          };
        }

        const waitMin = hooks.getNewThreadCooldownRemainingMin();
        if (waitMin > 0) {
          return {
            tool: toolName,
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
            tool: toolName,
            ok: false,
            detail: "missing title/body",
            result: { ok: false, error: "Both title and body are required." },
          };
        }

        const thread = await hooks.forum.createThreadAsAgent(
          hooks.config.name,
          title,
          body,
          opId,
        );
        const result = { ok: true, threadId: thread.id, title: thread.title };
        hooks.recordWrite({
          operationId: opId,
          toolName,
          targetKey: `new_thread:#${thread.id}`,
          threadId: thread.id,
          isNewThread: true,
          result,
        });
        return {
          tool: toolName,
          ok: true,
          detail: `created thread #${thread.id}`,
          result,
        };
      }

      case "dm_send": {
        if (!hooks.config.behavior.replyToDMs) {
          return {
            tool: toolName,
            ok: false,
            detail: "DMs disabled",
            result: { ok: false, error: "You are not permitted to send DMs." },
          };
        }

        const recipient =
          typeof args.recipient === "string"
            ? normalizeHandle(args.recipient)
            : "";
        const body = typeof args.body === "string" ? args.body.trim() : "";
        if (!recipient || !body) {
          return {
            tool: toolName,
            ok: false,
            detail: "invalid recipient/body",
            result: { ok: false, error: "recipient and body are required." },
          };
        }
        if (recipient === hooks.config.name || recipient === SYSTEM_HANDLE) {
          return {
            tool: toolName,
            ok: false,
            detail: `cannot DM @${recipient}`,
            result: { ok: false, error: `Cannot send a DM to @${recipient}.` },
          };
        }

        const opId = makeOpId("dm", recipient);
        const checkpointed = hooks.getCompletedWrite(opId);
        if (checkpointed !== null) {
          return {
            tool: toolName,
            ok: true,
            detail: `reused checkpointed DM to @${recipient}`,
            result: checkpointed,
          };
        }

        if (hooks.writesRemaining() <= 0) {
          return {
            tool: toolName,
            ok: false,
            detail: "write budget exhausted",
            result: { ok: false, error: "Per-run write limit reached." },
          };
        }

        const existingDm = await hooks.forum.findDMThreadForAgent(
          hooks.config.name,
          recipient,
        );
        if (existingDm) {
          const refusal = checkReplyGuardrails(existingDm, hooks);
          if (refusal) {
            return {
              tool: toolName,
              ok: false,
              detail: refusal,
              result: { ok: false, error: refusal },
            };
          }
        }

        const sent = await hooks.forum.sendDMAsAgent(
          hooks.config.name,
          recipient,
          body,
          opId,
        );
        const result = {
          ok: true,
          threadId: sent.threadId,
          postId: sent.post.id,
        };
        hooks.recordWrite({
          operationId: opId,
          toolName,
          targetKey: `dm:@${recipient}`,
          threadId: sent.threadId,
          isNewThread: false,
          result,
        });
        return {
          tool: toolName,
          ok: true,
          detail: `sent DM to @${recipient} (thread #${sent.threadId})`,
          result,
        };
      }

      default:
        return {
          tool: toolName,
          ok: false,
          detail: "unknown tool",
          result: { ok: false, error: `Unknown tool: ${toolName}` },
        };
    }
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
