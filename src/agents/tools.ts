import type { AgentConfig, ThreadDetail } from "../shared/types";
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
        name: "list_threads",
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
        name: "read_thread",
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
        name: "list_messages",
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
        name: "save_memory",
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
  ];

  if (
    config.behavior.respondToMentions ||
    config.behavior.browseForum ||
    config.behavior.replyToDMs
  ) {
    tools.push({
      type: "function",
      function: {
        name: "reply",
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
        name: "create_thread",
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
        name: "send_dm",
        description:
          "Send a direct message to another handle (without the @ prefix, e.g. 'curious-otter').",
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
  runId: string;
  step: number;
  callIndex: number;
  writesRemaining: () => number;
  recordWrite: (threadId: number, isNewThread: boolean) => void;
  getThreadCooldownRemainingSec: (threadId: number) => number;
  getNewThreadCooldownRemainingMin: () => number;
  saveMemory: (note: string) => void;
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
    args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return {
      tool: toolName,
      ok: false,
      detail: "Invalid JSON arguments",
      result: { ok: false, error: "Invalid JSON arguments" },
    };
  }

  const opId = `${hooks.config.name}:${hooks.runId}:s${hooks.step}:c${hooks.callIndex}`;

  try {
    switch (toolName) {
      case "list_threads": {
        const limit =
          typeof args.limit === "number" ? Math.min(30, Math.max(1, args.limit)) : 15;
        const threads = await hooks.forum.listThreadsForAgent(limit);
        return {
          tool: toolName,
          ok: true,
          detail: `fetched ${threads.length} threads`,
          result: { ok: true, threads },
        };
      }

      case "read_thread": {
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
            result: { ok: false, error: `Thread #${threadId} not found or inaccessible` },
          };
        }
        return {
          tool: toolName,
          ok: true,
          detail: `read #${threadId} (${thread.posts.length} posts)`,
          result: { ok: true, thread },
        };
      }

      case "list_messages": {
        const messages = await hooks.forum.listMessagesForAgent(hooks.config.name);
        return {
          tool: toolName,
          ok: true,
          detail: `listed ${messages.length} conversations`,
          result: { ok: true, messages },
        };
      }

      case "save_memory": {
        const note = typeof args.note === "string" ? args.note.trim().slice(0, 240) : "";
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
          detail: "saved memory note",
          result: { ok: true },
        };
      }

      case "reply": {
        if (hooks.writesRemaining() <= 0) {
          return {
            tool: toolName,
            ok: false,
            detail: "write budget exhausted",
            result: { ok: false, error: "Per-run write limit reached." },
          };
        }

        const threadId = Number(args.threadId);
        const body = typeof args.body === "string" ? args.body.trim() : "";
        if (!Number.isInteger(threadId) || threadId <= 0 || !body) {
          return {
            tool: toolName,
            ok: false,
            detail: "invalid reply args",
            result: { ok: false, error: "Valid threadId and non-empty body are required." },
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
            result: { ok: false, error: `Thread #${threadId} not found or inaccessible.` },
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
        hooks.recordWrite(threadId, false);
        return {
          tool: toolName,
          ok: true,
          detail: `replied in #${threadId} (post #${post.id})`,
          result: { ok: true, postId: post.id, threadId },
        };
      }

      case "create_thread": {
        if (!hooks.config.behavior.createThreads) {
          return {
            tool: toolName,
            ok: false,
            detail: "createThreads disabled",
            result: { ok: false, error: "You are not permitted to create public threads." },
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
        hooks.recordWrite(thread.id, true);
        return {
          tool: toolName,
          ok: true,
          detail: `created thread #${thread.id}`,
          result: { ok: true, threadId: thread.id, title: thread.title },
        };
      }

      case "send_dm": {
        if (!hooks.config.behavior.replyToDMs) {
          return {
            tool: toolName,
            ok: false,
            detail: "DMs disabled",
            result: { ok: false, error: "You are not permitted to send DMs." },
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

        const recipient =
          typeof args.recipient === "string" ? normalizeHandle(args.recipient) : "";
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
        hooks.recordWrite(sent.threadId, false);
        return {
          tool: toolName,
          ok: true,
          detail: `sent DM to @${recipient} (thread #${sent.threadId})`,
          result: { ok: true, threadId: sent.threadId, postId: sent.post.id },
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
