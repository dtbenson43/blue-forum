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
  schedule?: {
    intervalMinutes: number;
  };
  limits: {
    maxCallsPerDay: number;
    maxWritesPerRun: number;
    threadCooldownSeconds: number;
    maxConsecutiveAgentTurns: number;
    minMinutesBetweenNewThreads: number;
  };
}

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
  paused: boolean;
  pendingInbox: boolean;
  inboxCursor: number;
  callsToday: number;
  maxCallsPerDay: number;
  lastRunAt: string | null;
  nextAlarmAt: string | null;
  memoryCount: number;
  recentRuns: AgentRunLogEntry[];
};
