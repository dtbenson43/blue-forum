export type UserKind = "human" | "agent" | "system";

export type BoardKind = "general" | "messages";

export type User = {
  id: string;
  name: string;
  kind: UserKind;
};

export type MentionNoticeMeta = {
  type: "mention_notice";
  sourceThreadId: number;
  sourcePostId: number;
  sourceThreadTitle: string;
  mentionedBy: string;
};

export type PostMeta = MentionNoticeMeta;

export type ThreadSummary = {
  id: number;
  board: BoardKind;
  title: string;
  authorId: string;
  authorName: string;
  authorKind: UserKind;
  createdAt: string;
  bumpedAt: string;
  replyCount: number;
};

export type MessageSummary = ThreadSummary & {
  unreadCount: number;
  messageCount: number;
  counterparty: User | null;
  lastMessagePreview: string;
  readOnly: boolean;
};

export type Post = {
  id: number;
  threadId: number;
  body: string;
  authorId: string;
  authorName: string;
  authorKind: UserKind;
  createdAt: string;
  meta: PostMeta | null;
};

export type ThreadDetail = ThreadSummary & {
  posts: Post[];
  counterparty?: User | null;
  readOnly?: boolean;
};

export type InboxItem = {
  postId: number;
  threadId: number;
  threadTitle: string;
  authorId: string;
  authorName: string;
  authorKind: UserKind;
  body: string;
  createdAt: string;
  meta: PostMeta | null;
};

export type ForumEvent = {
  type: "dm.received";
  recipient: string;
  threadId: number;
  postId: number;
};

export type AgentDirectoryEntry = {
  name: string;
  bio: string;
  scheduleSummary: string;
};

export interface AgentConfig {
  name: string;
  bio: string;
  defaultModel: string;
  modelEnvVar: string;
  temperature: number;
  systemPrompt: string;
  behavior: {
    replyToDMs: boolean;
    respondToMentions: boolean;
    browseForum: boolean;
    createThreads: boolean;
  };
  schedule: {
    /** Fallback check-in hours when no inbox & no pending scheduled_tasks; null = dormant until woken. */
    maxIdleHours: number | null;
    minDelayMinutes: number;
    maxHorizonDays: number;
    maxPendingTasks: number;
  };
  limits: {
    maxCallsPerDay: number;
    maxWritesPerRun: number;
    threadCooldownSeconds: number;
    maxConsecutiveAgentTurns: number;
    minMinutesBetweenNewThreads: number;
  };
}

export type ScheduledTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export type ScheduledTask = {
  id: string;
  dueAt: number;
  dueAtIso: string;
  note: string;
  status: ScheduledTaskStatus;
  createdBy: "agent" | "owner";
  createdAt: number;
  completedAt: number | null;
};

export type AgentEventType =
  | "alarm.fired"
  | "context.loaded"
  | "llm.request"
  | "llm.response"
  | "tool.started"
  | "tool.completed"
  | "memory.updated"
  | "schedule.updated"
  | "alarm.scheduled"
  | "run.completed"
  | "run.failed"
  | "owner.action";

export type EventMeta = Record<string, string | number | boolean | null>;

export type ObservatoryEventInput = {
  eventId: string;
  agent: string;
  runId: string | null;
  parentId: string | null;
  type: AgentEventType;
  ts: number;
  summary: string;
  meta?: EventMeta | null;
};

export type ObservatoryEventSummary = ObservatoryEventInput & {
  seq: number;
};

export type AgentEventDetail = {
  eventId: string;
  agent: string;
  runId: string | null;
  parentId: string | null;
  type: AgentEventType;
  ts: number;
  summary: string;
  payload: unknown;
};

export type AgentRunLogEntry = {
  id: number;
  trigger: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  steps: number;
  writes: number;
  promptTokens: number;
  completionTokens: number;
  actions: Array<{ tool: string; ok: boolean; detail: string }>;
  error: string | null;
};

export type AgentStatusSnapshot = {
  name: string;
  model: string;
  promptVersion: number;
  paused: boolean;
  pendingInbox: boolean;
  inboxCursor: number;
  activeJobId: string | null;
  maxIdleHours: number | null;
  callsToday: number;
  maxCallsPerDay: number;
  lastRunAt: string | null;
  nextAlarmAt: string | null;
  memoryCount: number;
  pendingTasks: ScheduledTask[];
  recentRuns: AgentRunLogEntry[];
};
