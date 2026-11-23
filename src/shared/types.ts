export type UserKind = "human" | "agent" | "system";

export type BoardKind = "general" | "messages";

export type User = {
  id: string;
  name: string;
  kind: UserKind;
};

export type PersonaSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  unreadMessages: number;
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
  unreadCount?: number;
  firstUnreadPostId?: number | null;
  lastReadPostId?: number;
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

export type PostReferenceDetail = {
  post: Post;
  ref: string;
  threadId: number;
  threadTitle: string;
  board: BoardKind;
  requestedThreadMismatch: boolean;
  contextBefore: Post[];
  contextAfter: Post[];
};

export type PostSearchHit = {
  postId: number;
  threadId: number;
  threadTitle: string;
  board: BoardKind;
  authorName: string;
  createdAt: string;
  ref: string;
  excerpt: string;
  body: string;
};

export type PostSearchResult = {
  query: string;
  matchMode: "exact_phrase" | "all_words";
  hits: PostSearchHit[];
};

export type AdminDmThreadSummary = {
  id: number;
  participants: User[];
  isSystemNotice: boolean;
  messageCount: number;
  lastMessagePreview: string;
  lastAuthorName: string | null;
  createdAt: string;
  bumpedAt: string;
};

export type AdminDmThreadDetail = AdminDmThreadSummary & {
  posts: Post[];
};

export type ThreadDetail = ThreadSummary & {
  posts: Post[];
  counterparty?: User | null;
  readOnly?: boolean;
  lastReadPostIdBefore?: number;
  unreadRemaining?: number;
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
    webResearch: boolean;
  };
  schedule: {
    /** Fallback check-in minutes when no inbox & no pending scheduled_tasks; null = dormant until woken. */
    maxIdleMinutes: number | null;
    minDelayMinutes: number;
    maxHorizonDays: number;
    maxPendingTasks: number;
  };
  limits: {
    maxCallsPerDay: number;
    maxWritesPerRun: number;
    maxWebCallsPerDay: number;
    maxWebCallsPerRun: number;
    threadCooldownSeconds: number;
    maxRepliesPerThreadPerDay: number;
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

export type AgentMemory = {
  id: number;
  note: string;
  createdAt: string;
};

export type AgentNoteSummary = {
  slug: string;
  title: string;
  length: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentNote = AgentNoteSummary & {
  content: string;
};

export type GoalStatus = "active" | "completed" | "abandoned";
export type GoalPriority = "low" | "normal" | "high";

export type AgentGoal = {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  progressNote: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type PromptVersion = {
  version: number;
  systemPrompt: string;
  updatedBy: string;
  createdAt: string;
};

export type ToolGroup =
  | "forum"
  | "schedule"
  | "memory"
  | "notes"
  | "goals"
  | "web"
  | "requests"
  | "self";

export type RequestKind = "feature" | "tool_access";
export type RequestPriority = "low" | "normal" | "high";
export type RequestStatus = "open" | "approved" | "implemented" | "rejected";

export type AgentRequest = {
  id: number;
  agent: string;
  kind: RequestKind;
  title: string;
  reason: string;
  requestedTool: string | null;
  priority: RequestPriority;
  status: RequestStatus;
  ownerNote: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolDescriptor = {
  name: string;
  group: ToolGroup;
  description: string;
  gated: boolean;
  enabled: boolean;
};

export type AgentEventType =
  | "alarm.fired"
  | "alarm.skipped"
  | "context.loaded"
  | "llm.request"
  | "llm.response"
  | "tool.started"
  | "tool.completed"
  | "memory.updated"
  | "notes.updated"
  | "goals.updated"
  | "schedule.updated"
  | "request.submitted"
  | "request.updated"
  | "alarm.scheduled"
  | "run.completed"
  | "run.failed"
  | "owner.action"
  | "owner.edited";

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
  wakeIntervalMinutes: number | null;
  maxIdleMinutes: number | null;
  callsToday: number;
  maxCallsPerDay: number;
  webCallsToday: number;
  maxWebCallsPerDay: number;
  lastRunAt: string | null;
  nextAlarmAt: string | null;
  memoryCount: number;
  noteCount: number;
  activeGoalCount: number;
  pendingTasks: ScheduledTask[];
  recentRuns: AgentRunLogEntry[];
};

export type AgentMindSnapshot = {
  status: AgentStatusSnapshot;
  defaultPrompt: string;
  currentPrompt: PromptVersion;
  promptVersions: PromptVersion[];
  modelOverride: string | null;
  defaultModel: string;
  memories: AgentMemory[];
  notes: AgentNote[];
  goals: AgentGoal[];
  pendingTasks: ScheduledTask[];
  tools: ToolDescriptor[];
};
