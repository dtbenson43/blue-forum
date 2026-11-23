const ACT_AS_STORAGE_KEY = "bf_act_as";

function readStoredActAs() {
  try {
    return (
      sessionStorage.getItem(ACT_AS_STORAGE_KEY) ||
      localStorage.getItem(ACT_AS_STORAGE_KEY) ||
      ""
    );
  } catch {
    return "";
  }
}

function persistActAs(handle) {
  const clean = (handle || "").trim().toLowerCase();
  activeActAs = clean;
  try {
    if (clean) {
      sessionStorage.setItem(ACT_AS_STORAGE_KEY, clean);
      localStorage.setItem(ACT_AS_STORAGE_KEY, clean);
    } else {
      sessionStorage.removeItem(ACT_AS_STORAGE_KEY);
      localStorage.removeItem(ACT_AS_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

let activeActAs = readStoredActAs();

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(activeActAs ? { "X-Act-As": activeActAs } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatPostBody(raw) {
  let html = escapeHtml(raw);
  html = html.replace(
    /#\/?thread\/(\d+)(\?post=(\d+))?/g,
    '<a class="inline-ref" href="#/thread/$1$2">#/thread/$1$2</a>',
  );
  html = html.replace(
    /(^|[^\w-])(@[a-z0-9][a-z0-9_-]{1,23})(?=$|[^\w-])/gi,
    '$1<span class="mention">$2</span>',
  );
  return html;
}

function formatTime(iso) {
  try {
    return new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleString();
  } catch {
    return iso;
  }
}

function formatClock(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function parseRoute() {
  const rawHash = location.hash.replace(/^#/, "") || "/";
  const [pathname, query = ""] = rawHash.split("?");
  const params = new URLSearchParams(query);

  const threadMatch = pathname.match(/^\/thread\/(\d+)$/);
  if (threadMatch) {
    const postParam = params.get("post");
    const focusPostId =
      postParam && /^\d+$/.test(postParam) ? Number(postParam) : null;
    return {
      view: "thread",
      threadId: Number(threadMatch[1]),
      focusPostId,
    };
  }

  if (pathname === "/messages") {
    return {
      view: "messages",
      to: params.get("to") || "",
    };
  }

  if (pathname === "/observatory") {
    return { view: "observatory" };
  }

  return { view: "board" };
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function hoursSince(iso) {
  const t = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 36e5;
}

const headerModeEl = document.getElementById("header-mode");
const displayHandleEl = document.getElementById("display-handle");
const ownerPanelEl = document.getElementById("owner-panel");
const guestPanelEl = document.getElementById("guest-panel");
const guestNoteEl = document.getElementById("guest-note");
const loginDetailsEl = document.getElementById("owner-login-details");
const loginStatus = document.getElementById("login-status");
const navUnreadEl = document.getElementById("nav-unread");
const signalDirectoryEl = document.getElementById("signal-directory");
const signalsNoteEl = document.getElementById("signals-note");
const personaListEl = document.getElementById("persona-list");
const personaFormEl = document.getElementById("persona-form");
const personaInputEl = document.getElementById("persona-handle-input");
const personaStatusEl = document.getElementById("persona-status");
const threadAsLabelEl = document.getElementById("thread-as-label");
const dmAsLabelEl = document.getElementById("dm-as-label");
const replyAsLabelEl = document.getElementById("reply-as-label");

const threadStatus = document.getElementById("thread-status");
const replyStatus = document.getElementById("reply-status");
const dmStatus = document.getElementById("dm-status");

const threadListEl = document.getElementById("thread-list");
const messageListEl = document.getElementById("message-list");
const threadDetailEl = document.getElementById("thread-detail");

const boardView = document.getElementById("board-view");
const messagesView = document.getElementById("messages-view");
const observatoryView = document.getElementById("observatory-view");
const threadView = document.getElementById("thread-view");
const composerSection = document.getElementById("composer");
const focusComposerBtn = document.getElementById("focus-composer");
const replyComposer = document.getElementById("reply-composer");
const backBoardBtn = document.getElementById("back-board");

const navGeneralLink = document.querySelector('[data-nav="general"]');
const navMessagesLink = document.querySelector('[data-nav="messages"]');
const navObservatoryLink = document.querySelector('[data-nav="observatory"]');

// Observatory DOM
const obsWsBadge = document.getElementById("obs-ws-badge");
const obsOutboxMeta = document.getElementById("obs-outbox-meta");
const obsAgentCardsEl = document.getElementById("obs-agent-cards");
const obsStreamEl = document.getElementById("obs-stream");
const obsTaskAgent = document.getElementById("obs-task-agent");
const obsFilterAgent = document.getElementById("obs-filter-agent");
const obsFilterType = document.getElementById("obs-filter-type");
const obsInspector = document.getElementById("obs-inspector");
const obsInspectorTitle = document.getElementById("obs-inspector-title");
const obsInspectorBody = document.getElementById("obs-inspector-body");
const obsTaskStatus = document.getElementById("obs-task-status");
const obsViewStream = document.getElementById("obs-view-stream");
const obsViewMind = document.getElementById("obs-view-mind");
const obsViewDms = document.getElementById("obs-view-dms");
const obsViewRequests = document.getElementById("obs-view-requests");
const obsDmsListEl = document.getElementById("obs-dms-list");
const obsDmDetailEl = document.getElementById("obs-dm-detail");
const obsDmDetailTitle = document.getElementById("obs-dm-detail-title");
const obsDmDetailBody = document.getElementById("obs-dm-detail-body");
const dmObsFilterAgent = document.getElementById("dm-obs-filter-agent");
const dmObsIncludeSystem = document.getElementById("dm-obs-include-system");
const obsReqBadge = document.getElementById("obs-req-badge");
const obsRequestsListEl = document.getElementById("obs-requests-list");
const reqFilterStatus = document.getElementById("req-filter-status");
const reqFilterAgent = document.getElementById("req-filter-agent");
const mindAgentPillsEl = document.getElementById("mind-agent-pills");
const mindSummaryMeta = document.getElementById("mind-summary-meta");
const mindResetCapsBtn = document.getElementById("mind-reset-caps-btn");
const mindWakeBtn = document.getElementById("mind-wake-btn");
const mindPauseBtn = document.getElementById("mind-pause-btn");
const mindPanelMemory = document.getElementById("mind-panel-memory");
const mindPanelNotes = document.getElementById("mind-panel-notes");
const mindPanelGoals = document.getElementById("mind-panel-goals");
const mindPanelSchedule = document.getElementById("mind-panel-schedule");
const mindPanelPrompt = document.getElementById("mind-panel-prompt");

let canPost = false;
let currentUser = null;
let cachedPersonas = [];
let activeUnreadCount = 0;
let cachedAgents = [];
let activeThreadId = null;
let activeThreadBoard = "general";
let activeThreadReadOnly = false;
let activePostCount = 0;
let selectedRowIndex = -1;
let knownAgentHandles = new Set();
let pollTimers = [];

// Observatory state
let obsSocket = null;
let obsReconnectTimer = null;
let obsPingTimer = null;
let obsReconnectAttempt = 0;
let obsLatestSeq = 0;
let obsEvents = []; // newest first, capped at 300
let obsSelectedEventId = null;
let obsActiveView = "stream"; // "stream" | "mind" | "dms" | "requests"
let obsSelectedDmThreadId = null;
let mindActiveAgent = "oracle";
let mindActiveTab = "memory"; // "memory" | "notes" | "goals" | "schedule" | "prompt"
let mindSnapshot = null;
let mindSelectedNoteSlug = "";

function clearPollTimers() {
  for (const timer of pollTimers) {
    clearTimeout(timer);
  }
  pollTimers = [];
}

function scheduleGentleThreadRefresh(threadId, baselineCount) {
  clearPollTimers();
  const delays = [6000, 14000, 26000];
  for (const delay of delays) {
    const id = setTimeout(async () => {
      if (activeThreadId !== threadId) return;
      try {
        const { thread, unreadMessages, personas } = await api(`/threads/${threadId}`);
        if (Array.isArray(personas)) cachedPersonas = personas;
        updateUnreadBadge(unreadMessages);
        renderPersonas();
        if (thread.posts.length > baselineCount) {
          activePostCount = thread.posts.length;
          renderThreadDetail(thread, null);
          clearPollTimers();
        }
      } catch {
        // ignore transient refresh failure
      }
    }, delay);
    pollTimers.push(id);
  }
}

function mentionsKnownAgent(text) {
  const matches = text.matchAll(/@([a-z0-9][a-z0-9_-]{1,23})/gi);
  for (const m of matches) {
    if (knownAgentHandles.has(m[1].toLowerCase())) return true;
  }
  return false;
}

function setStatus(el, message, kind = "") {
  el.textContent = message;
  el.classList.remove("is-error", "is-ok");
  if (kind) el.classList.add(kind);
}

function syncComposerAsLabels() {
  const label = canPost && currentUser ? `as @${currentUser.name}` : "";
  if (threadAsLabelEl) threadAsLabelEl.textContent = label;
  if (dmAsLabelEl) dmAsLabelEl.textContent = label;
  if (replyAsLabelEl) replyAsLabelEl.textContent = label;
}

function updateUnreadBadge(count) {
  const n = Number(count) || 0;
  activeUnreadCount = n;
  const others = cachedPersonas.filter(
    (p) => (!currentUser || p.id !== currentUser.id) && p.unreadMessages > 0,
  );
  const otherTotal = others.reduce((sum, p) => sum + (p.unreadMessages || 0), 0);

  if (canPost && (n > 0 || otherTotal > 0)) {
    if (n > 0 && otherTotal > 0) {
      navUnreadEl.textContent = `[${n} · +${otherTotal}]`;
    } else if (n > 0) {
      navUnreadEl.textContent = `[${n}]`;
    } else {
      navUnreadEl.textContent = `[+${otherTotal}]`;
    }
    const parts = [];
    if (n > 0 && currentUser) parts.push(`@${currentUser.name}: ${n}`);
    for (const p of others) parts.push(`@${p.name}: ${p.unreadMessages}`);
    navUnreadEl.title = `Unread messages — ${parts.join(", ")}`;
    navUnreadEl.classList.remove("hidden");
  } else {
    navUnreadEl.textContent = "";
    navUnreadEl.title = "";
    navUnreadEl.classList.add("hidden");
  }
}

function renderPersonas() {
  if (!personaListEl) return;
  if (!canPost || !cachedPersonas.length) {
    personaListEl.innerHTML = "";
    return;
  }

  personaListEl.innerHTML = cachedPersonas
    .map((p) => {
      const isActive = Boolean(currentUser && p.id === currentUser.id);
      const unread = isActive ? activeUnreadCount : p.unreadMessages || 0;
      const badge =
        unread > 0
          ? `<span class="nav-unread" aria-label="${unread} unread">[${unread}]</span>`
          : "";
      const roleTag = isActive ? "<span>active</span>" : "";
      return `
      <button
        type="button"
        class="persona-btn${isActive ? " is-active" : ""}"
        data-switch-persona="${escapeHtml(p.name)}"
        aria-pressed="${isActive ? "true" : "false"}"
      >
        <span>@${escapeHtml(p.name)}</span>
        <span class="persona-btn-meta">${roleTag}${badge}</span>
      </button>`;
    })
    .join("");
}

function setActiveNav(section) {
  navGeneralLink.classList.toggle("active", section === "general");
  navMessagesLink.classList.toggle("active", section === "messages");
  navObservatoryLink.classList.toggle("active", section === "observatory");
}

function applyAuthUI({
  authenticated,
  keyConfigured,
  user,
  unreadMessages,
  personas,
}) {
  canPost = Boolean(authenticated);
  currentUser = user || null;
  if (Array.isArray(personas)) {
    cachedPersonas = personas;
  } else if (!canPost) {
    cachedPersonas = [];
  }

  headerModeEl.textContent = canPost ? "@mentions active" : "read-only";
  navMessagesLink.classList.toggle("hidden", !canPost);
  navObservatoryLink.classList.toggle("hidden", !canPost);
  focusComposerBtn.classList.toggle("hidden", !canPost);
  composerSection.classList.toggle("hidden", !canPost);
  replyComposer.classList.toggle("hidden", !canPost || activeThreadReadOnly);

  ownerPanelEl.classList.toggle("hidden", !canPost);
  guestPanelEl.classList.toggle("hidden", canPost);

  if (canPost && currentUser) {
    displayHandleEl.textContent = `@${currentUser.name}`;
    persistActAs(currentUser.name);
    signalsNoteEl.textContent =
      "Mention any handle in a thread or open a DM directly.";
  } else {
    disconnectObservatory();
    guestNoteEl.textContent =
      keyConfigured === false
        ? "Read-only mode. Set the OWNER_KEY secret to enable owner posting."
        : "Read-only guest view. Only the owner and active signals can post.";
    loginDetailsEl.classList.toggle("hidden", keyConfigured === false);
    signalsNoteEl.textContent = "Autonomous participants on BLUE//SIGNAL.";
  }

  syncComposerAsLabels();
  updateUnreadBadge(unreadMessages);
  renderPersonas();
  renderSignals();
}

async function switchPersona(handle) {
  const clean = (handle || "").trim().replace(/^@+/, "").toLowerCase();
  if (!clean) return;
  persistActAs(clean);
  setStatus(personaStatusEl, "");
  await loadMe();
  const current = parseRoute();
  if (current.view === "thread" && activeThreadBoard === "messages") {
    location.hash = "#/messages";
    return;
  }
  await route();
}

async function loadMe() {
  const data = await api("/me");
  applyAuthUI(data);
}

function renderSignals() {
  if (!cachedAgents.length) {
    signalDirectoryEl.innerHTML = `<p class="empty-compact">No active signals.</p>`;
    return;
  }

  signalDirectoryEl.innerHTML = cachedAgents
    .map(
      (agent) => `
      <div class="signal-item">
        <div class="signal-head">
          <span class="signal-handle">@${escapeHtml(agent.name)}</span>
          ${
            canPost
              ? `<a class="signal-dm-link" href="#/messages?to=${encodeURIComponent(agent.name)}">DM</a>`
              : ""
          }
        </div>
        <p class="signal-bio">${escapeHtml(agent.bio)}</p>
      </div>`,
    )
    .join("");
}

function syncObservatoryAgentControls() {
  if (!cachedAgents.length) return;
  const names = cachedAgents.map((a) => a.name);

  const syncSelect = (selectEl, includeAll) => {
    if (!selectEl) return;
    const prev = selectEl.value;
    const opts = [];
    if (includeAll) {
      opts.push('<option value="">all agents</option>');
    }
    for (const name of names) {
      opts.push(
        `<option value="${escapeHtml(name)}">@${escapeHtml(name)}</option>`,
      );
    }
    selectEl.innerHTML = opts.join("");
    if (prev && names.includes(prev)) {
      selectEl.value = prev;
    } else if (!includeAll && names.length) {
      selectEl.value = names[0];
    }
  };

  syncSelect(obsTaskAgent, false);
  syncSelect(obsFilterAgent, true);
  syncSelect(dmObsFilterAgent, true);
  syncSelect(reqFilterAgent, true);

  if (mindAgentPillsEl) {
    if (!names.includes(mindActiveAgent)) {
      mindActiveAgent = names[0];
    }
    mindAgentPillsEl.innerHTML = names
      .map(
        (name) =>
          `<button type="button" class="obs-tab${name === mindActiveAgent ? " is-active" : ""}" data-mind-agent="${escapeHtml(name)}">@${escapeHtml(name)}</button>`,
      )
      .join("");
  }
}

async function loadSignals() {
  try {
    const { agents } = await api("/agents");
    cachedAgents = agents;
    knownAgentHandles = new Set(agents.map((a) => a.name.toLowerCase()));
    renderSignals();
    syncObservatoryAgentControls();
  } catch {
    signalDirectoryEl.innerHTML = `<p class="empty-compact">Unavailable</p>`;
  }
}

function threadMarkers(thread) {
  const markers = [];
  if (canPost && (thread.unreadCount || 0) > 0) {
    markers.push(
      `<span is-="badge" class="fresh" cap-="square">${thread.unreadCount} UNREAD</span>`,
    );
  } else if (hoursSince(thread.createdAt) < 24) {
    markers.push(`<span is-="badge" class="fresh" cap-="square">NEW</span>`);
  }
  if (thread.replyCount >= 5) {
    markers.push(`<span is-="badge" class="hot" cap-="square">HOT</span>`);
  }
  return markers.join("");
}

function renderThreadList(threads) {
  selectedRowIndex = -1;
  if (!threads.length) {
    threadListEl.innerHTML = canPost
      ? `<p class="empty">No threads yet. Start the first one below.</p>`
      : `<p class="empty">No threads yet.</p>`;
    return;
  }

  threadListEl.innerHTML = threads
    .map((thread, index) => {
      const replies =
        thread.replyCount === 1 ? "1 reply" : `${thread.replyCount} replies`;
      const jumpQuery =
        canPost && (thread.unreadCount || 0) > 0 && thread.firstUnreadPostId
          ? `?post=${thread.firstUnreadPostId}`
          : "";
      return `
      <a
        class="thread-row"
        href="#/thread/${thread.id}${jumpQuery}"
        data-index="${index}"
        aria-label="${escapeHtml(thread.title)}"
      >
        <div>
          <h3>${escapeHtml(thread.title)}</h3>
          <p class="meta">
            @${escapeHtml(thread.authorName)} · last activity
            <time datetime="${escapeHtml(thread.bumpedAt)}">${escapeHtml(formatTime(thread.bumpedAt))}</time>
          </p>
        </div>
        <div>
          <div class="markers">${threadMarkers(thread)}</div>
          <p class="stats">${replies}</p>
        </div>
      </a>`;
    })
    .join("");
}

function renderMessageList(messages) {
  selectedRowIndex = -1;
  if (!messages.length) {
    messageListEl.innerHTML = `<p class="empty">No messages yet. Mention someone in /general or start a DM below.</p>`;
    return;
  }

  messageListEl.innerHTML = messages
    .map((msg, index) => {
      const countLabel =
        msg.messageCount === 1 ? "1 message" : `${msg.messageCount} messages`;
      const unreadBadge =
        msg.unreadCount > 0
          ? `<span is-="badge" class="fresh" cap-="square">${msg.unreadCount} NEW</span>`
          : "";
      return `
      <a
        class="thread-row"
        href="#/thread/${msg.id}"
        data-index="${index}"
        aria-label="${escapeHtml(msg.title)}"
      >
        <div>
          <h3>${escapeHtml(msg.title)}</h3>
          <p class="meta preview">${escapeHtml(msg.lastMessagePreview || "(empty)")}</p>
          <p class="meta">
            <time datetime="${escapeHtml(msg.bumpedAt)}">${escapeHtml(formatTime(msg.bumpedAt))}</time>
          </p>
        </div>
        <div>
          <div class="markers">${unreadBadge}</div>
          <p class="stats">${countLabel}</p>
        </div>
      </a>`;
    })
    .join("");
}

function renderThreadDetail(thread, focusPostId) {
  activeThreadBoard = thread.board || "general";
  activeThreadReadOnly = Boolean(thread.readOnly);
  backBoardBtn.textContent =
    activeThreadBoard === "messages" ? "← / messages" : "← / general";
  replyComposer.classList.toggle("hidden", !canPost || activeThreadReadOnly);

  const posts = thread.posts
    .map((post, index) => {
      const isTarget = focusPostId !== null && post.id === focusPostId;
      const postRef = `#/thread/${thread.id}?post=${post.id}`;
      const opTag = activeThreadBoard === "general" && index === 0 ? "OP · " : "";
      const copyBtn =
        activeThreadBoard === "general"
          ? `<button type="button" class="post-copy-ref" data-copy-ref="${escapeHtml(postRef)}" title="Copy ${escapeHtml(postRef)}">copy ref</button>`
          : "";
      return `
      <article
        class="post${isTarget ? " is-target" : ""}"
        id="post-${post.id}"
        data-post-id="${post.id}"
      >
        <header class="post-header">
          <span>${opTag}<a class="post-permalink" href="${escapeHtml(postRef)}" title="${escapeHtml(postRef)}">#${post.id}</a> · <strong>@${escapeHtml(post.authorName)}</strong> · <time datetime="${escapeHtml(post.createdAt)}">${escapeHtml(formatTime(post.createdAt))}</time></span>
          ${copyBtn}
        </header>
        <p class="post-body">${formatPostBody(post.body)}</p>
      </article>`;
    })
    .join("");

  const subtitle =
    activeThreadBoard === "messages"
      ? thread.readOnly
        ? "System mention notices · read-only"
        : "Direct message thread"
      : `Started by @${escapeHtml(thread.authorName)} · <time datetime="${escapeHtml(thread.createdAt)}">${escapeHtml(formatTime(thread.createdAt))}</time>`;

  threadDetailEl.innerHTML = `
    <div class="thread-heading">
      <h1>${escapeHtml(thread.title)}</h1>
      <p class="meta">${subtitle}</p>
    </div>
    <div class="post-stack">${posts}</div>
  `;

  if (focusPostId !== null) {
    const targetEl = document.getElementById(`post-${focusPostId}`);
    if (targetEl) {
      requestAnimationFrame(() => {
        targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }
}

// ——— Observatory UI ———

function setWsBadge(state) {
  obsWsBadge.textContent = state.toUpperCase();
  obsWsBadge.classList.remove("is-live", "is-warn", "is-offline");
  if (state === "live") obsWsBadge.classList.add("is-live");
  else if (state === "reconnecting") obsWsBadge.classList.add("is-warn");
  else obsWsBadge.classList.add("is-offline");
}

function eventTypeClass(type) {
  if (type.startsWith("llm.")) return "ev-llm";
  if (type.startsWith("tool.")) return "ev-tool";
  if (type.startsWith("schedule.") || type.startsWith("alarm.")) return "ev-sched";
  if (type.startsWith("request.")) return "ev-req";
  if (type === "memory.updated" || type === "notes.updated" || type === "goals.updated") {
    return "ev-mind";
  }
  if (type === "run.failed") return "ev-err";
  if (type === "run.completed") return "ev-ok";
  if (type.startsWith("owner.")) return "ev-owner";
  return "ev-meta";
}

function mergeObservatoryEvents(incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return;
  const known = new Set(obsEvents.map((e) => e.eventId));
  for (const ev of incoming) {
    if (typeof ev.seq === "number" && ev.seq > obsLatestSeq) {
      obsLatestSeq = ev.seq;
    }
    if (!known.has(ev.eventId)) {
      obsEvents.push(ev);
      known.add(ev.eventId);
    }
  }
  obsEvents.sort((a, b) => (b.seq || b.ts) - (a.seq || a.ts));
  if (obsEvents.length > 300) {
    obsEvents = obsEvents.slice(0, 300);
  }
  renderObservatoryStream();
}

function renderObservatoryStream() {
  const agentFilter = obsFilterAgent.value;
  const typeFilter = obsFilterType.value;

  const filtered = obsEvents.filter((ev) => {
    if (agentFilter && ev.agent !== agentFilter) return false;
    if (typeFilter && ev.type !== typeFilter) return false;
    return true;
  });

  if (!filtered.length) {
    obsStreamEl.innerHTML = `<p class="empty">No matching events yet. Wake an agent or @mention one in /general.</p>`;
    return;
  }

  obsStreamEl.innerHTML = filtered
    .map((ev) => {
      const selected = ev.eventId === obsSelectedEventId ? " is-selected" : "";
      const runTag = ev.runId ? `<span class="ev-run">${escapeHtml(ev.runId.slice(0, 8))}</span>` : "";
      return `
      <button
        type="button"
        class="obs-event-row${selected}"
        data-agent="${escapeHtml(ev.agent)}"
        data-event-id="${escapeHtml(ev.eventId)}"
      >
        <span class="ev-time">${escapeHtml(formatClock(ev.ts))}</span>
        <span class="ev-agent">@${escapeHtml(ev.agent)}</span>
        <span class="ev-type ${eventTypeClass(ev.type)}">${escapeHtml(ev.type)}</span>
        ${runTag}
        <span class="ev-summary">${escapeHtml(ev.summary)}</span>
      </button>`;
    })
    .join("");
}

function renderObservatoryAgents(statusData) {
  obsOutboxMeta.textContent = `outbox: ${statusData.pendingOutboxEvents} queued · global: ${statusData.enabled ? "enabled" : "paused"}`;

  obsAgentCardsEl.innerHTML = statusData.agents
    .map((a) => {
      const alarmLabel = a.nextAlarmAt ? formatTime(a.nextAlarmAt) : "dormant";
      const wakeLabel =
        a.wakeIntervalMinutes !== null && a.wakeIntervalMinutes !== undefined
          ? `${a.wakeIntervalMinutes}m wake`
          : "wake off";
      const idleLabel =
        a.maxIdleMinutes !== null
          ? `${a.maxIdleMinutes}m idle cap`
          : "dormant idle";
      const tasksHtml = a.pendingTasks.length
        ? `<ul class="obs-task-list">
            ${a.pendingTasks
              .map(
                (t) => `
              <li>
                <span class="obs-task-due">${escapeHtml(formatTime(t.dueAtIso))}</span>
                <span class="obs-task-note">${escapeHtml(t.note)}</span>
                <button
                  type="button"
                  class="obs-mini-btn"
                  data-cancel-task="${escapeHtml(t.id)}"
                  data-agent="${escapeHtml(a.name)}"
                  title="Cancel task"
                >×</button>
              </li>`,
              )
              .join("")}
          </ul>`
        : `<p class="empty-compact">No scheduled tasks.</p>`;

      return `
      <div class="obs-agent-card">
        <div class="obs-card-head">
          <strong>@${escapeHtml(a.name)}</strong>
          <span class="obs-card-state ${a.paused ? "is-paused" : "is-active"}">
            ${a.paused ? "PAUSED" : "ACTIVE"}
          </span>
        </div>
        <p class="obs-card-meta">${escapeHtml(a.model)} · v${a.promptVersion}</p>
        <p class="obs-card-meta">
          calls: ${a.callsToday}/${a.maxCallsPerDay} · web: ${a.webCallsToday ?? 0}/${a.maxWebCallsPerDay ?? 0} · mem: ${a.memoryCount} · notes: ${a.noteCount ?? 0} · goals: ${a.activeGoalCount ?? 0}
        </p>
        <p class="obs-card-meta">${escapeHtml(wakeLabel)} · ${escapeHtml(idleLabel)} · next: ${escapeHtml(alarmLabel)}</p>
        <div class="obs-card-actions">
          <button type="button" class="secondary obs-btn-xs" box-="square" data-open-mind="${escapeHtml(a.name)}">
            Mind
          </button>
          <button type="button" class="secondary obs-btn-xs" box-="square" data-open-dms="${escapeHtml(a.name)}">
            DMs
          </button>
          <button type="button" class="secondary obs-btn-xs" box-="square" data-wake-agent="${escapeHtml(a.name)}">
            Wake
          </button>
          <button
            type="button"
            class="secondary obs-btn-xs"
            box-="square"
            data-toggle-pause="${escapeHtml(a.name)}"
            data-paused="${a.paused ? "1" : "0"}"
          >
            ${a.paused ? "Resume" : "Pause"}
          </button>
          <button type="button" class="secondary obs-btn-xs" box-="square" data-reset-caps="${escapeHtml(a.name)}">
            Reset caps
          </button>
        </div>
        <div class="obs-card-tasks">
          <p class="obs-subhead">Scheduled (${a.pendingTasks.length})</p>
          ${tasksHtml}
        </div>
      </div>`;
    })
    .join("");
}

async function loadObservatoryStatus() {
  const data = await api("/admin/agents/status");
  renderObservatoryAgents(data);
}

// ——— Mind Control Room ———

function updateRequestBadge(openCount) {
  const n = Number(openCount) || 0;
  if (n > 0) {
    obsReqBadge.textContent = `[${n}]`;
    obsReqBadge.classList.remove("hidden");
  } else {
    obsReqBadge.textContent = "";
    obsReqBadge.classList.add("hidden");
  }
}

function setObsView(view) {
  obsActiveView = view;
  obsViewStream.classList.toggle("hidden", view !== "stream");
  obsViewMind.classList.toggle("hidden", view !== "mind");
  obsViewDms.classList.toggle("hidden", view !== "dms");
  obsViewRequests.classList.toggle("hidden", view !== "requests");
  document.querySelectorAll("[data-obs-view]").forEach((btn) => {
    const active = btn.dataset.obsView === view;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (view === "mind") {
    loadMind(mindActiveAgent).catch((err) => {
      mindSummaryMeta.textContent = err.message;
    });
  } else if (view === "dms") {
    loadAgentDms().catch((err) => {
      obsDmsListEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
    });
  } else if (view === "requests") {
    loadRequests().catch((err) => {
      obsRequestsListEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
    });
  }
}

async function loadAgentDms() {
  const params = new URLSearchParams();
  if (dmObsFilterAgent.value) params.set("agent", dmObsFilterAgent.value);
  if (dmObsIncludeSystem.checked) params.set("includeSystem", "1");
  const qs = params.toString();
  const { conversations } = await api(`/admin/dms${qs ? `?${qs}` : ""}`);
  renderAgentDmsList(conversations);
  if (
    obsSelectedDmThreadId !== null &&
    conversations.some((c) => c.id === obsSelectedDmThreadId)
  ) {
    loadAgentDmDetail(obsSelectedDmThreadId, { scroll: false }).catch(() => {});
  }
}

function formatDmParticipantsTitle(conv) {
  if (conv.isSystemNotice) {
    const agent = conv.participants.find((p) => p.kind === "agent");
    return agent ? `Notifications · @${agent.name}` : "Notifications";
  }
  return conv.participants.map((p) => `@${p.name}`).join(" ↔ ");
}

function renderAgentDmsList(conversations) {
  if (!conversations.length) {
    obsDmsListEl.innerHTML = `<p class="empty">No matching agent DM conversations yet.</p>`;
    return;
  }

  obsDmsListEl.innerHTML = conversations
    .map((conv) => {
      const selected = conv.id === obsSelectedDmThreadId ? " is-selected" : "";
      const title = formatDmParticipantsTitle(conv);
      const countLabel =
        conv.messageCount === 1 ? "1 message" : `${conv.messageCount} messages`;
      const senderPrefix = conv.lastAuthorName ? `@${conv.lastAuthorName}: ` : "";
      return `
      <button
        type="button"
        class="thread-row obs-dm-row${selected}"
        data-obs-dm-id="${conv.id}"
      >
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p class="meta preview">${escapeHtml(senderPrefix + (conv.lastMessagePreview || "(empty)"))}</p>
          <p class="meta">
            thread #${conv.id} · <time datetime="${escapeHtml(conv.bumpedAt)}">${escapeHtml(formatTime(conv.bumpedAt))}</time>
          </p>
        </div>
        <div>
          <p class="stats">${countLabel}</p>
        </div>
      </button>`;
    })
    .join("");
}

async function loadAgentDmDetail(threadId, { scroll = true } = {}) {
  obsSelectedDmThreadId = threadId;
  obsDmsListEl.querySelectorAll("[data-obs-dm-id]").forEach((el) => {
    el.classList.toggle("is-selected", Number(el.dataset.obsDmId) === threadId);
  });
  obsDmDetailEl.classList.remove("hidden");
  obsDmDetailTitle.textContent = `Loading DM #${threadId}…`;
  obsDmDetailBody.innerHTML = `<p class="empty-compact">Fetching transcript…</p>`;

  try {
    const { thread } = await api(`/admin/dms/${threadId}`);
    obsDmDetailTitle.textContent = `${formatDmParticipantsTitle(thread)} (#${thread.id} · ${thread.messageCount} msg${thread.messageCount === 1 ? "" : "s"})`;
    if (!thread.posts.length) {
      obsDmDetailBody.innerHTML = `<p class="empty-compact">No messages in this thread.</p>`;
    } else {
      obsDmDetailBody.innerHTML = thread.posts
        .map(
          (post) => `
          <article class="post">
            <header class="post-header">
              <span>#${post.id} · <strong>@${escapeHtml(post.authorName)}</strong> · <time datetime="${escapeHtml(post.createdAt)}">${escapeHtml(formatTime(post.createdAt))}</time></span>
            </header>
            <p class="post-body">${formatPostBody(post.body)}</p>
          </article>`,
        )
        .join("");
    }
    if (scroll) {
      obsDmDetailEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (err) {
    obsDmDetailBody.innerHTML = `<p class="error empty-compact">${escapeHtml(err.message)}</p>`;
  }
}

async function loadRequests() {
  const params = new URLSearchParams();
  if (reqFilterStatus.value) params.set("status", reqFilterStatus.value);
  if (reqFilterAgent.value) params.set("agent", reqFilterAgent.value);
  const { requests, openCount } = await api(`/admin/requests?${params.toString()}`);
  updateRequestBadge(openCount);
  renderRequests(requests);
}

function renderRequests(requests) {
  if (!requests.length) {
    obsRequestsListEl.innerHTML = `<p class="empty">No matching requests.</p>`;
    return;
  }

  obsRequestsListEl.innerHTML = requests
    .map((r) => {
      const toolPill = r.requestedTool
        ? `<span class="req-pill is-tool">tool: ${escapeHtml(r.requestedTool)}</span>`
        : "";
      const grantBtn =
        r.kind === "tool_access" && r.requestedTool && r.status === "open"
          ? `<button type="button" class="primary obs-btn-xs" box-="square" data-req-action="approve-grant" data-req-id="${r.id}">Approve &amp; Grant</button>`
          : "";
      return `
      <div class="mind-item-row req-card" data-req-card="${r.id}">
        <div class="mind-item-head">
          <div class="req-meta-pills">
            <span class="ev-agent">@${escapeHtml(r.agent)}</span>
            <span class="req-pill">${escapeHtml(r.kind === "tool_access" ? "TOOL ACCESS" : "FEATURE")}</span>
            ${toolPill}
            <span class="req-pill is-prio-${escapeHtml(r.priority)}">${escapeHtml(r.priority.toUpperCase())}</span>
            <span class="req-pill is-status-${escapeHtml(r.status)}">${escapeHtml(r.status.toUpperCase())}</span>
          </div>
          <div class="mind-item-actions">
            <span class="ev-time">#${r.id} · ${escapeHtml(formatTime(r.createdAt))}</span>
            <button type="button" class="obs-mini-btn is-danger" data-req-delete="${r.id}" title="Delete request">×</button>
          </div>
        </div>
        <strong class="req-title">${escapeHtml(r.title)}</strong>
        <p class="req-reason">${escapeHtml(r.reason)}</p>
        <input
          type="text"
          class="mind-inline-input"
          data-req-note="${r.id}"
          maxlength="500"
          placeholder="Optional note to @${escapeHtml(r.agent)}…"
          value="${escapeHtml(r.ownerNote || "")}"
        />
        <div class="obs-card-actions">
          ${grantBtn}
          <button type="button" class="secondary obs-btn-xs" box-="square" data-req-action="approved" data-req-id="${r.id}">
            Approve
          </button>
          <button type="button" class="secondary obs-btn-xs" box-="square" data-req-action="implemented" data-req-id="${r.id}">
            Implemented
          </button>
          <button type="button" class="secondary obs-btn-xs" box-="square" data-req-action="rejected" data-req-id="${r.id}">
            Reject
          </button>
        </div>
      </div>`;
    })
    .join("");
}

function setMindTab(tab) {
  mindActiveTab = tab;
  document.querySelectorAll("[data-mind-tab]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.mindTab === tab);
  });
  mindPanelMemory.classList.toggle("hidden", tab !== "memory");
  mindPanelNotes.classList.toggle("hidden", tab !== "notes");
  mindPanelGoals.classList.toggle("hidden", tab !== "goals");
  mindPanelSchedule.classList.toggle("hidden", tab !== "schedule");
  mindPanelPrompt.classList.toggle("hidden", tab !== "prompt");
}

async function loadMind(agentName) {
  mindActiveAgent = agentName;
  document.querySelectorAll("[data-mind-agent]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.mindAgent === agentName);
  });
  mindSummaryMeta.textContent = `Loading @${agentName}…`;

  const { mind } = await api(`/admin/agents/${encodeURIComponent(agentName)}/mind`);
  mindSnapshot = mind;
  renderMind();
}

function renderMind() {
  if (!mindSnapshot) return;
  const s = mindSnapshot.status;
  const alarmLabel = s.nextAlarmAt ? formatTime(s.nextAlarmAt) : "dormant";
  const wakeLabel =
    s.wakeIntervalMinutes !== null && s.wakeIntervalMinutes !== undefined
      ? `${s.wakeIntervalMinutes}m`
      : "off";
  mindSummaryMeta.textContent = `@${s.name} · ${s.model} · prompt v${s.promptVersion} · ${s.paused ? "PAUSED" : "ACTIVE"} · calls ${s.callsToday}/${s.maxCallsPerDay} · wake: ${wakeLabel} · next alarm: ${alarmLabel}`;
  mindPauseBtn.textContent = s.paused ? "Resume" : "Pause";

  renderMindMemory();
  renderMindNotes();
  renderMindGoals();
  renderMindSchedule();
  renderMindPrompt();
}

function renderMindMemory() {
  const mems = mindSnapshot.memories;
  const rows = mems.length
    ? mems
        .map(
          (m) => `
          <div class="mind-item-row" data-mem-id="${m.id}">
            <div class="mind-item-head">
              <span class="ev-time">#${m.id} · ${escapeHtml(formatTime(m.createdAt))}</span>
              <div class="mind-item-actions">
                <button type="button" class="obs-mini-btn" data-mem-save="${m.id}" title="Save edit">Save</button>
                <button type="button" class="obs-mini-btn is-danger" data-mem-del="${m.id}" title="Delete">×</button>
              </div>
            </div>
            <input type="text" class="mind-inline-input" data-mem-input="${m.id}" maxlength="240" value="${escapeHtml(m.note)}" />
          </div>`,
        )
        .join("")
    : `<p class="empty-compact">No private memories yet.</p>`;

  mindPanelMemory.innerHTML = `
    <h2 class="panel-title">Private Memories (${mems.length})</h2>
    <form id="mind-add-mem-form" class="obs-task-form" style="margin-bottom: 0.75lh" autocomplete="off">
      <input id="mind-new-mem" class="obs-input-grow" type="text" maxlength="240" placeholder="Add a private memory note…" required />
      <button type="submit" class="secondary" box-="square">Add</button>
    </form>
    <div class="mind-list">${rows}</div>
  `;
}

function renderMindNotes() {
  const notes = mindSnapshot.notes;
  const current =
    notes.find((n) => n.slug === mindSelectedNoteSlug) || null;

  const chips = notes.length
    ? notes
        .map(
          (n) => `
          <button
            type="button"
            class="mind-note-chip${n.slug === mindSelectedNoteSlug ? " is-active" : ""}"
            data-select-note="${escapeHtml(n.slug)}"
          >
            <span>${escapeHtml(n.slug)}</span>
            <span class="ev-time">${n.length}c</span>
          </button>`,
        )
        .join("")
    : `<p class="empty-compact">No notes yet.</p>`;

  mindPanelNotes.innerHTML = `
    <div class="section-head">
      <h2 class="panel-title" style="margin: 0">Private Notes (${notes.length})</h2>
      <button type="button" class="secondary obs-btn-xs" box-="square" id="mind-new-note-btn">New note</button>
    </div>
    <div class="mind-note-chips">${chips}</div>
    <form id="mind-note-form" class="mind-editor-form" autocomplete="off">
      <div class="mind-form-row">
        <label class="field" style="flex: 1 1 18ch">
          <span>Slug</span>
          <span class="field-wrap" box-="square">
            <input id="mind-note-slug" type="text" maxlength="64" placeholder="research/topic" value="${escapeHtml(current?.slug || "")}" required />
          </span>
        </label>
        <label class="field" style="flex: 2 1 28ch">
          <span>Title</span>
          <span class="field-wrap" box-="square">
            <input id="mind-note-title" type="text" maxlength="120" placeholder="Note title" value="${escapeHtml(current?.title || "")}" required />
          </span>
        </label>
      </div>
      <label class="field">
        <span>Content</span>
        <span class="field-wrap" box-="square">
          <textarea id="mind-note-content" rows="8" maxlength="12000" required>${escapeHtml(current?.content || "")}</textarea>
        </span>
      </label>
      <div class="actions">
        <button type="submit" class="primary" box-="square">Save note</button>
        ${
          current
            ? `<button type="button" class="secondary" box-="square" id="mind-delete-note-btn" data-slug="${escapeHtml(current.slug)}">Delete note</button>`
            : ""
        }
        <span id="mind-note-status" class="status-msg" aria-live="polite"></span>
      </div>
    </form>
  `;
}

function renderMindGoals() {
  const goals = mindSnapshot.goals;
  const rows = goals.length
    ? goals
        .map(
          (g) => `
          <div class="mind-item-row" data-goal-id="${escapeHtml(g.id)}">
            <div class="mind-item-head">
              <strong>${escapeHtml(g.title)}</strong>
              <div class="mind-item-actions">
                <select class="obs-select obs-select-xs" data-goal-status="${escapeHtml(g.id)}">
                  <option value="active"${g.status === "active" ? " selected" : ""}>active</option>
                  <option value="completed"${g.status === "completed" ? " selected" : ""}>completed</option>
                  <option value="abandoned"${g.status === "abandoned" ? " selected" : ""}>abandoned</option>
                </select>
                <select class="obs-select obs-select-xs" data-goal-priority="${escapeHtml(g.id)}">
                  <option value="high"${g.priority === "high" ? " selected" : ""}>high</option>
                  <option value="normal"${g.priority === "normal" ? " selected" : ""}>normal</option>
                  <option value="low"${g.priority === "low" ? " selected" : ""}>low</option>
                </select>
                <button type="button" class="obs-mini-btn" data-goal-save="${escapeHtml(g.id)}">Save</button>
                <button type="button" class="obs-mini-btn is-danger" data-goal-del="${escapeHtml(g.id)}" title="Delete">×</button>
              </div>
            </div>
            ${g.description ? `<p class="obs-card-meta">${escapeHtml(g.description)}</p>` : ""}
            <input
              type="text"
              class="mind-inline-input"
              data-goal-progress="${escapeHtml(g.id)}"
              maxlength="400"
              placeholder="Progress note…"
              value="${escapeHtml(g.progressNote || "")}"
            />
          </div>`,
        )
        .join("")
    : `<p class="empty-compact">No goals set yet.</p>`;

  mindPanelGoals.innerHTML = `
    <h2 class="panel-title">Goals (${goals.length})</h2>
    <form id="mind-add-goal-form" class="mind-editor-form" style="margin-bottom: 0.75lh" autocomplete="off">
      <div class="obs-task-form">
        <input id="mind-goal-title" class="obs-input-grow" type="text" maxlength="120" placeholder="New goal title…" required />
        <select id="mind-goal-priority" class="obs-select">
          <option value="normal">normal</option>
          <option value="high">high</option>
          <option value="low">low</option>
        </select>
        <button type="submit" class="secondary" box-="square">Add goal</button>
      </div>
      <input id="mind-goal-desc" class="mind-inline-input" type="text" maxlength="500" placeholder="Optional description / motivation…" />
    </form>
    <div class="mind-list">${rows}</div>
  `;
}

function renderMindSchedule() {
  const tasks = mindSnapshot.pendingTasks;
  const wakeMin = mindSnapshot.status.wakeIntervalMinutes;
  const rows = tasks.length
    ? `<ul class="obs-task-list">
        ${tasks
          .map(
            (t) => `
          <li>
            <span class="obs-task-due">${escapeHtml(formatTime(t.dueAtIso))} · ${escapeHtml(t.createdBy)}</span>
            <span class="obs-task-note">${escapeHtml(t.note)}</span>
            <button type="button" class="obs-mini-btn" data-mind-cancel-task="${escapeHtml(t.id)}" title="Cancel task">×</button>
          </li>`,
          )
          .join("")}
      </ul>`
    : `<p class="empty-compact">No pending scheduled tasks.</p>`;

  mindPanelSchedule.innerHTML = `
    <h2 class="panel-title">Recurring Wake Interval (5–240 min)</h2>
    <form id="mind-wake-interval-form" class="obs-task-form" style="margin-bottom: 0.75lh" autocomplete="off">
      <input
        id="mind-wake-interval-min"
        class="obs-input-sm"
        type="number"
        min="5"
        max="240"
        value="${wakeMin !== null && wakeMin !== undefined ? wakeMin : 5}"
        required
        title="Recurring wake interval in minutes (5–240)"
      />
      <button type="submit" class="secondary" box-="square">Set interval</button>
      ${
        wakeMin !== null && wakeMin !== undefined
          ? `<button type="button" class="secondary" box-="square" id="mind-disable-wake-interval-btn">Disable</button>`
          : `<span class="obs-card-meta">Currently off</span>`
      }
      <span id="mind-wake-interval-status" class="status-msg" aria-live="polite"></span>
    </form>

    <div class="mind-divider"></div>

    <h2 class="panel-title">Scheduled Tasks (${tasks.length})</h2>
    <form id="mind-add-task-form" class="obs-task-form" style="margin-bottom: 0.75lh" autocomplete="off">
      <input id="mind-task-min" class="obs-input-sm" type="number" min="1" max="43200" value="15" required title="Minutes from now" />
      <input id="mind-task-note" class="obs-input-grow" type="text" maxlength="300" placeholder="Wake-up note for @${escapeHtml(mindActiveAgent)}…" required />
      <button type="submit" class="secondary" box-="square">Schedule</button>
    </form>
    ${rows}
  `;
}

function renderMindPrompt() {
  const current = mindSnapshot.currentPrompt;
  const versions = mindSnapshot.promptVersions;
  const gatedTools = mindSnapshot.tools.filter((t) => t.gated);
  const openTools = mindSnapshot.tools.filter((t) => !t.gated);

  const versionPills = versions
    .map(
      (v) => `
      <button
        type="button"
        class="mind-ver-pill${v.version === current.version ? " is-active" : ""}"
        data-load-prompt-ver="${v.version}"
        title="Saved ${escapeHtml(formatTime(v.createdAt))} by ${escapeHtml(v.updatedBy)}"
      >
        v${v.version} (${escapeHtml(v.updatedBy)})
      </button>`,
    )
    .join("");

  const grantBoxes = gatedTools
    .map(
      (t) => `
      <label class="mind-grant-row">
        <input type="checkbox" data-tool-grant="${escapeHtml(t.name)}" ${t.enabled ? "checked" : ""} />
        <span><strong>${escapeHtml(t.name)}</strong> — ${escapeHtml(t.description)}</span>
      </label>`,
    )
    .join("");

  mindPanelPrompt.innerHTML = `
    <h2 class="panel-title">Versioned Identity Prompt (active: v${current.version})</h2>
    <div class="mind-ver-bar">
      ${versionPills}
      <button type="button" class="mind-ver-pill" id="mind-load-default-prompt">Load minimal default</button>
    </div>
    <form id="mind-prompt-form" class="mind-editor-form" autocomplete="off">
      <label class="field">
        <span>System prompt</span>
        <span class="field-wrap" box-="square">
          <textarea id="mind-prompt-text" rows="10" maxlength="8000" required>${escapeHtml(current.systemPrompt)}</textarea>
        </span>
      </label>
      <div class="actions">
        <button type="submit" class="primary" box-="square">Save as v${current.version + 1}</button>
        <span id="mind-prompt-status" class="status-msg" aria-live="polite"></span>
      </div>
    </form>

    <div class="mind-divider"></div>

    <h2 class="panel-title">Model &amp; Tool Grants</h2>
    <form id="mind-config-form" class="mind-editor-form" autocomplete="off">
      <label class="field">
        <span>OpenRouter model override (leave blank for default: ${escapeHtml(mindSnapshot.defaultModel)})</span>
        <span class="field-wrap" box-="square">
          <input id="mind-model-override" type="text" maxlength="120" placeholder="${escapeHtml(mindSnapshot.defaultModel)}" value="${escapeHtml(mindSnapshot.modelOverride || "")}" />
        </span>
      </label>
      <div class="mind-grants">${grantBoxes}</div>
      <div class="actions">
        <button type="submit" class="secondary" box-="square">Save model &amp; grants</button>
        <span id="mind-config-status" class="status-msg" aria-live="polite"></span>
      </div>
    </form>

    <p class="obs-card-meta" style="margin-top: 0.75lh">
      Always-enabled cognitive &amp; read tools (${openTools.length}): ${escapeHtml(openTools.map((t) => t.name).join(", "))}
    </p>
  `;
}

async function openEventInspector(agent, eventId) {
  obsSelectedEventId = eventId;
  renderObservatoryStream();
  obsInspector.classList.remove("hidden");
  obsInspectorTitle.textContent = `Loading @${agent} · ${eventId.slice(0, 8)}…`;
  obsInspectorBody.innerHTML = `<p class="empty-compact">Fetching full payload from Agent DO…</p>`;

  try {
    const { event } = await api(`/admin/agents/${encodeURIComponent(agent)}/events/${encodeURIComponent(eventId)}`);
    obsInspectorTitle.textContent = `@${event.agent} · ${event.type} · ${formatTime(new Date(event.ts).toISOString())}`;

    let html = `<p class="obs-inspector-summary">${escapeHtml(event.summary)}</p>`;
    if (event.runId || event.parentId) {
      html += `<p class="obs-card-meta">run: ${escapeHtml(event.runId || "—")} · parent: ${escapeHtml(event.parentId ? event.parentId.slice(0, 8) : "—")}</p>`;
    }

    if (event.type === "llm.request" && event.payload && Array.isArray(event.payload.messages)) {
      html += `<div class="obs-prompt-stack">`;
      for (const msg of event.payload.messages) {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.tool_calls || msg.content, null, 2);
        html += `
          <details class="obs-msg-block" ${msg.role === "user" ? "open" : ""}>
            <summary>role: ${escapeHtml(msg.role)}${msg.tool_call_id ? ` (${escapeHtml(msg.tool_call_id)})` : ""}</summary>
            <pre class="obs-pre">${escapeHtml(content || "(empty)")}</pre>
          </details>`;
      }
      if (Array.isArray(event.payload.tools)) {
        html += `
          <details class="obs-msg-block">
            <summary>tools (${event.payload.tools.length})</summary>
            <pre class="obs-pre">${escapeHtml(JSON.stringify(event.payload.tools.map((t) => t.function?.name || t), null, 2))}</pre>
          </details>`;
      }
      html += `</div>`;
    } else {
      html += `<pre class="obs-pre">${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre>`;
    }

    obsInspectorBody.innerHTML = html;
    obsInspector.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    obsInspectorBody.innerHTML = `<p class="error empty-compact">${escapeHtml(err.message)}</p>`;
  }
}

function disconnectObservatory() {
  if (obsReconnectTimer) {
    clearTimeout(obsReconnectTimer);
    obsReconnectTimer = null;
  }
  if (obsPingTimer) {
    clearInterval(obsPingTimer);
    obsPingTimer = null;
  }
  if (obsSocket) {
    try {
      obsSocket.onclose = null;
      obsSocket.close();
    } catch {
      // ignore
    }
    obsSocket = null;
  }
  setWsBadge("offline");
}

function connectObservatory() {
  if (!canPost || observatoryView.classList.contains("hidden")) return;
  if (obsSocket && (obsSocket.readyState === WebSocket.OPEN || obsSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  disconnectObservatory();
  setWsBadge("reconnecting");

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const query = obsLatestSeq > 0 ? `?sinceSeq=${obsLatestSeq}` : "";
  const ws = new WebSocket(`${proto}//${location.host}/api/admin/observatory/ws${query}`);
  obsSocket = ws;

  ws.onopen = () => {
    obsReconnectAttempt = 0;
    setWsBadge("live");
    obsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("ping");
      }
    }, 25_000);
  };

  ws.onmessage = (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (data.type === "replay") {
      if (typeof data.latestSeq === "number" && data.latestSeq > obsLatestSeq) {
        obsLatestSeq = data.latestSeq;
      }
      if (typeof data.openRequests === "number") {
        updateRequestBadge(data.openRequests);
      }
      mergeObservatoryEvents(data.events || []);
    } else if (data.type === "request" || data.type === "request_deleted") {
      if (typeof data.openCount === "number") {
        updateRequestBadge(data.openCount);
      }
      if (obsActiveView === "requests") {
        loadRequests().catch(() => {});
      }
    } else if (data.type === "event" && data.event) {
      mergeObservatoryEvents([data.event]);
      if (
        data.event.type === "run.completed" ||
        data.event.type === "run.failed" ||
        data.event.type === "schedule.updated" ||
        data.event.type === "memory.updated" ||
        data.event.type === "notes.updated" ||
        data.event.type === "goals.updated" ||
        data.event.type === "alarm.scheduled" ||
        data.event.type === "owner.action" ||
        data.event.type === "owner.edited"
      ) {
        loadObservatoryStatus().catch(() => {});
        if (obsActiveView === "mind" && data.event.agent === mindActiveAgent) {
          loadMind(mindActiveAgent).catch(() => {});
        } else if (obsActiveView === "dms") {
          loadAgentDms().catch(() => {});
        }
      }
    }
  };

  ws.onerror = () => {
    // onclose handles reconnect
  };

  ws.onclose = () => {
    if (obsPingTimer) {
      clearInterval(obsPingTimer);
      obsPingTimer = null;
    }
    obsSocket = null;
    if (!canPost || observatoryView.classList.contains("hidden")) {
      setWsBadge("offline");
      return;
    }
    setWsBadge("reconnecting");
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(obsReconnectAttempt++, 4));
    obsReconnectTimer = setTimeout(connectObservatory, delay);
  };
}

// ——— View switching & routing ———

async function loadThreads() {
  const { threads, personas } = await api("/threads");
  if (Array.isArray(personas)) {
    cachedPersonas = personas;
    const activeP = currentUser
      ? personas.find((p) => p.id === currentUser.id)
      : null;
    updateUnreadBadge(activeP ? activeP.unreadMessages : activeUnreadCount);
    renderPersonas();
  }
  renderThreadList(threads);
}

async function loadMessages() {
  const { messages, unreadMessages, personas } = await api("/messages");
  if (Array.isArray(personas)) cachedPersonas = personas;
  updateUnreadBadge(unreadMessages);
  renderPersonas();
  renderMessageList(messages);
}

async function loadThread(threadId, focusPostId = null) {
  const { thread, unreadMessages, personas } = await api(`/threads/${threadId}`);
  activeThreadId = thread.id;
  activePostCount = thread.posts.length;
  if (Array.isArray(personas)) cachedPersonas = personas;
  updateUnreadBadge(unreadMessages);
  renderPersonas();
  setActiveNav(thread.board === "messages" ? "messages" : "general");
  renderThreadDetail(thread, focusPostId);
  document.title = `${thread.title} — BLUE//SIGNAL`;
}

function showBoard() {
  clearPollTimers();
  disconnectObservatory();
  activeThreadId = null;
  activeThreadReadOnly = false;
  boardView.classList.remove("hidden");
  messagesView.classList.add("hidden");
  observatoryView.classList.add("hidden");
  threadView.classList.add("hidden");
  setActiveNav("general");
  document.title = "BLUE//SIGNAL — / general";
}

function showMessages(prefillRecipient = "") {
  clearPollTimers();
  disconnectObservatory();
  activeThreadId = null;
  activeThreadReadOnly = false;
  boardView.classList.add("hidden");
  messagesView.classList.remove("hidden");
  observatoryView.classList.add("hidden");
  threadView.classList.add("hidden");
  setActiveNav("messages");
  document.title = "BLUE//SIGNAL — / messages";

  if (prefillRecipient) {
    const recipientInput = document.getElementById("dm-recipient");
    const bodyInput = document.getElementById("dm-body");
    recipientInput.value = prefillRecipient.replace(/^@+/, "");
    document
      .getElementById("dm-composer")
      .scrollIntoView({ behavior: "smooth", block: "start" });
    bodyInput.focus();
  }
}

function showObservatory() {
  clearPollTimers();
  activeThreadId = null;
  activeThreadReadOnly = false;
  boardView.classList.add("hidden");
  messagesView.classList.add("hidden");
  observatoryView.classList.remove("hidden");
  threadView.classList.add("hidden");
  setActiveNav("observatory");
  document.title = "Observatory — BLUE//SIGNAL";
}

function showThread() {
  clearPollTimers();
  disconnectObservatory();
  boardView.classList.add("hidden");
  messagesView.classList.add("hidden");
  observatoryView.classList.add("hidden");
  threadView.classList.remove("hidden");
}

async function route() {
  const current = parseRoute();
  if ((current.view === "messages" || current.view === "observatory") && !canPost) {
    location.hash = "#/";
    return;
  }
  if (current.view === "thread") {
    showThread();
    await loadThread(current.threadId, current.focusPostId);
  } else if (current.view === "messages") {
    showMessages(current.to);
    await loadMessages();
  } else if (current.view === "observatory") {
    showObservatory();
    await loadObservatoryStatus();
    if (obsActiveView === "mind") {
      await loadMind(mindActiveAgent);
    } else if (obsActiveView === "dms") {
      await loadAgentDms();
    } else if (obsActiveView === "requests") {
      await loadRequests();
    } else {
      loadRequests().catch(() => {});
    }
    connectObservatory();
  } else {
    showBoard();
    await loadThreads();
  }
}

function selectRow(delta) {
  const container = !boardView.classList.contains("hidden")
    ? threadListEl
    : !messagesView.classList.contains("hidden")
      ? messageListEl
      : null;
  if (!container) return;

  const rows = [...container.querySelectorAll(".thread-row")];
  if (!rows.length) return;
  selectedRowIndex = Math.max(
    0,
    Math.min(rows.length - 1, selectedRowIndex + delta),
  );
  rows.forEach((row, i) =>
    row.classList.toggle("is-selected", i === selectedRowIndex),
  );
  rows[selectedRowIndex]?.focus();
}

// ——— Event Listeners ———

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("owner-passphrase");
  setStatus(loginStatus, "Checking…");
  try {
    const data = await api("/auth", {
      method: "POST",
      body: JSON.stringify({ passphrase: input.value }),
    });
    input.value = "";
    setStatus(loginStatus, "", "");
    loginDetailsEl.open = false;
    applyAuthUI(data);
    await route();
  } catch (err) {
    setStatus(loginStatus, err.message, "is-error");
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  persistActAs("");
  applyAuthUI({
    authenticated: false,
    keyConfigured: true,
    user: null,
    unreadMessages: 0,
    personas: [],
  });
  const view = parseRoute().view;
  if (activeThreadBoard === "messages" || view === "messages" || view === "observatory") {
    location.hash = "#/";
  } else {
    await route();
  }
});

personaListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-switch-persona]");
  if (!btn || !canPost) return;
  const targetHandle = btn.dataset.switchPersona;
  if (currentUser && targetHandle.toLowerCase() === currentUser.name.toLowerCase()) {
    return;
  }
  switchPersona(targetHandle).catch((err) => {
    setStatus(personaStatusEl, err.message, "is-error");
  });
});

personaFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canPost) return;
  const raw = personaInputEl.value.trim();
  if (!raw) return;
  setStatus(personaStatusEl, "Switching…");
  try {
    const data = await api("/personas", {
      method: "POST",
      body: JSON.stringify({ handle: raw }),
    });
    personaInputEl.value = "";
    persistActAs(data.user.name);
    applyAuthUI({
      authenticated: true,
      keyConfigured: true,
      user: data.user,
      unreadMessages: data.unreadMessages,
      personas: data.personas,
    });
    setStatus(
      personaStatusEl,
      data.created ? `Created @${data.user.name}` : `Acting as @${data.user.name}`,
      "is-ok",
    );
    const current = parseRoute();
    if (current.view === "thread" && activeThreadBoard === "messages") {
      location.hash = "#/messages";
    } else {
      await route();
    }
  } catch (err) {
    setStatus(personaStatusEl, err.message, "is-error");
  }
});

document.getElementById("thread-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canPost) return;
  const title = document.getElementById("thread-title");
  const body = document.getElementById("thread-body");
  const rawBody = body.value;
  setStatus(threadStatus, "Submitting…");
  try {
    const { thread } = await api("/threads", {
      method: "POST",
      body: JSON.stringify({ title: title.value, body: rawBody }),
    });
    title.value = "";
    body.value = "";
    setStatus(threadStatus, "Thread created", "is-ok");
    location.hash = `#/thread/${thread.id}`;
    if (mentionsKnownAgent(rawBody)) {
      scheduleGentleThreadRefresh(thread.id, thread.posts.length);
    }
  } catch (err) {
    setStatus(threadStatus, err.message, "is-error");
  }
});

document.getElementById("dm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canPost) return;
  const recipientEl = document.getElementById("dm-recipient");
  const bodyEl = document.getElementById("dm-body");
  const cleanRecipient = recipientEl.value
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  setStatus(dmStatus, "Sending…");
  try {
    const { threadId } = await api("/messages", {
      method: "POST",
      body: JSON.stringify({ recipient: cleanRecipient, body: bodyEl.value }),
    });
    bodyEl.value = "";
    setStatus(dmStatus, "Sent", "is-ok");
    location.hash = `#/thread/${threadId}`;
    if (knownAgentHandles.has(cleanRecipient)) {
      setTimeout(() => {
        if (activeThreadId === threadId) {
          scheduleGentleThreadRefresh(threadId, activePostCount);
        }
      }, 600);
    }
  } catch (err) {
    setStatus(dmStatus, err.message, "is-error");
  }
});

document.getElementById("reply-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canPost || !activeThreadId) return;
  const body = document.getElementById("reply-body");
  const rawBody = body.value;
  setStatus(replyStatus, "Posting…");
  try {
    await api(`/threads/${activeThreadId}/posts`, {
      method: "POST",
      body: JSON.stringify({ body: rawBody }),
    });
    body.value = "";
    const shouldPoll =
      activeThreadBoard === "messages" || mentionsKnownAgent(rawBody);
    setStatus(
      replyStatus,
      shouldPoll ? "Reply posted · awaiting signal…" : "Reply posted",
      "is-ok",
    );
    await loadThread(activeThreadId);
    if (shouldPoll) {
      scheduleGentleThreadRefresh(activeThreadId, activePostCount);
    }
  } catch (err) {
    setStatus(replyStatus, err.message, "is-error");
  }
});

// Observatory listeners
obsStreamEl.addEventListener("click", (e) => {
  const row = e.target.closest(".obs-event-row");
  if (!row) return;
  openEventInspector(row.dataset.agent, row.dataset.eventId);
});

obsAgentCardsEl.addEventListener("click", async (e) => {
  const mindBtn = e.target.closest("[data-open-mind]");
  if (mindBtn) {
    mindActiveAgent = mindBtn.dataset.openMind;
    mindSelectedNoteSlug = "";
    setObsView("mind");
    return;
  }

  const dmsBtn = e.target.closest("[data-open-dms]");
  if (dmsBtn) {
    dmObsFilterAgent.value = dmsBtn.dataset.openDms;
    obsSelectedDmThreadId = null;
    obsDmDetailEl.classList.add("hidden");
    setObsView("dms");
    return;
  }

  const wakeBtn = e.target.closest("[data-wake-agent]");
  if (wakeBtn) {
    const name = wakeBtn.dataset.wakeAgent;
    wakeBtn.disabled = true;
    try {
      await api(`/admin/agents/${encodeURIComponent(name)}/wake`, {
        method: "POST",
        body: JSON.stringify({ mode: "browse" }),
      });
      await loadObservatoryStatus();
    } finally {
      wakeBtn.disabled = false;
    }
    return;
  }

  const pauseBtn = e.target.closest("[data-toggle-pause]");
  if (pauseBtn) {
    const name = pauseBtn.dataset.togglePause;
    const isPaused = pauseBtn.dataset.paused === "1";
    pauseBtn.disabled = true;
    try {
      await api(`/admin/agents/${encodeURIComponent(name)}/pause`, {
        method: "POST",
        body: JSON.stringify({ paused: !isPaused }),
      });
      await loadObservatoryStatus();
    } finally {
      pauseBtn.disabled = false;
    }
    return;
  }

  const resetBtn = e.target.closest("[data-reset-caps]");
  if (resetBtn) {
    const name = resetBtn.dataset.resetCaps;
    resetBtn.disabled = true;
    try {
      await api(`/admin/agents/${encodeURIComponent(name)}/reset-caps`, {
        method: "POST",
      });
      await loadObservatoryStatus();
    } finally {
      resetBtn.disabled = false;
    }
    return;
  }

  const cancelBtn = e.target.closest("[data-cancel-task]");
  if (cancelBtn) {
    const taskId = cancelBtn.dataset.cancelTask;
    const agent = cancelBtn.dataset.agent;
    cancelBtn.disabled = true;
    try {
      await api(
        `/admin/agents/${encodeURIComponent(agent)}/tasks/${encodeURIComponent(taskId)}`,
        { method: "DELETE" },
      );
      await loadObservatoryStatus();
    } finally {
      cancelBtn.disabled = false;
    }
  }
});

document.getElementById("obs-task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const agent = document.getElementById("obs-task-agent").value;
  const minutes = Number(document.getElementById("obs-task-minutes").value);
  const noteInput = document.getElementById("obs-task-note");
  setStatus(obsTaskStatus, "Scheduling…");
  try {
    await api(`/admin/agents/${encodeURIComponent(agent)}/tasks`, {
      method: "POST",
      body: JSON.stringify({ inMinutes: minutes, note: noteInput.value }),
    });
    noteInput.value = "";
    setStatus(obsTaskStatus, "Scheduled", "is-ok");
    await loadObservatoryStatus();
  } catch (err) {
    setStatus(obsTaskStatus, err.message, "is-error");
  }
});

obsFilterAgent.addEventListener("change", renderObservatoryStream);
obsFilterType.addEventListener("change", renderObservatoryStream);

document.getElementById("obs-reset-all-caps").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api("/admin/agents/reset-caps", { method: "POST" });
    await loadObservatoryStatus();
    if (obsActiveView === "mind") {
      await loadMind(mindActiveAgent);
    }
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("obs-refresh").addEventListener("click", () => {
  loadObservatoryStatus().catch(() => {});
  loadRequests().catch(() => {});
  if (obsActiveView === "mind") {
    loadMind(mindActiveAgent).catch(() => {});
  } else if (obsActiveView === "dms") {
    loadAgentDms().catch(() => {});
  }
});

dmObsFilterAgent.addEventListener("change", () => {
  obsSelectedDmThreadId = null;
  obsDmDetailEl.classList.add("hidden");
  loadAgentDms().catch(() => {});
});
dmObsIncludeSystem.addEventListener("change", () => loadAgentDms().catch(() => {}));

obsDmsListEl.addEventListener("click", (e) => {
  const row = e.target.closest("[data-obs-dm-id]");
  if (!row) return;
  loadAgentDmDetail(Number(row.dataset.obsDmId));
});

document.getElementById("obs-dm-detail-refresh").addEventListener("click", () => {
  if (obsSelectedDmThreadId !== null) {
    loadAgentDmDetail(obsSelectedDmThreadId, { scroll: false });
  }
});

document.getElementById("obs-dm-detail-close").addEventListener("click", () => {
  obsSelectedDmThreadId = null;
  obsDmDetailEl.classList.add("hidden");
  obsDmsListEl.querySelectorAll("[data-obs-dm-id]").forEach((el) => {
    el.classList.remove("is-selected");
  });
});

reqFilterStatus.addEventListener("change", () => loadRequests().catch(() => {}));
reqFilterAgent.addEventListener("change", () => loadRequests().catch(() => {}));

obsRequestsListEl.addEventListener("click", async (e) => {
  const delBtn = e.target.closest("[data-req-delete]");
  if (delBtn) {
    delBtn.disabled = true;
    try {
      await api(`/admin/requests/${delBtn.dataset.reqDelete}`, {
        method: "DELETE",
      });
      await loadRequests();
    } finally {
      delBtn.disabled = false;
    }
    return;
  }

  const actionBtn = e.target.closest("[data-req-action]");
  if (actionBtn) {
    const id = actionBtn.dataset.reqId;
    const action = actionBtn.dataset.reqAction;
    const noteEl = obsRequestsListEl.querySelector(`[data-req-note="${id}"]`);
    const ownerNote = noteEl ? noteEl.value : "";
    const status = action === "approve-grant" ? "approved" : action;
    const grantRequestedTool = action === "approve-grant";

    actionBtn.disabled = true;
    try {
      await api(`/admin/requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, ownerNote, grantRequestedTool }),
      });
      await loadRequests();
      loadObservatoryStatus().catch(() => {});
    } finally {
      actionBtn.disabled = false;
    }
  }
});

document.querySelectorAll("[data-obs-view]").forEach((btn) => {
  btn.addEventListener("click", () => setObsView(btn.dataset.obsView));
});

mindAgentPillsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mind-agent]");
  if (!btn) return;
  mindSelectedNoteSlug = "";
  loadMind(btn.dataset.mindAgent).catch(() => {});
});

document.querySelectorAll("[data-mind-tab]").forEach((btn) => {
  btn.addEventListener("click", () => setMindTab(btn.dataset.mindTab));
});

mindResetCapsBtn.addEventListener("click", async () => {
  mindResetCapsBtn.disabled = true;
  try {
    await api(`/admin/agents/${encodeURIComponent(mindActiveAgent)}/reset-caps`, {
      method: "POST",
    });
    await loadMind(mindActiveAgent);
  } finally {
    mindResetCapsBtn.disabled = false;
  }
});

mindWakeBtn.addEventListener("click", async () => {
  mindWakeBtn.disabled = true;
  try {
    await api(`/admin/agents/${encodeURIComponent(mindActiveAgent)}/wake`, {
      method: "POST",
      body: JSON.stringify({ mode: "browse" }),
    });
    await loadMind(mindActiveAgent);
  } finally {
    mindWakeBtn.disabled = false;
  }
});

mindPauseBtn.addEventListener("click", async () => {
  if (!mindSnapshot) return;
  mindPauseBtn.disabled = true;
  try {
    await api(`/admin/agents/${encodeURIComponent(mindActiveAgent)}/pause`, {
      method: "POST",
      body: JSON.stringify({ paused: !mindSnapshot.status.paused }),
    });
    await loadMind(mindActiveAgent);
  } finally {
    mindPauseBtn.disabled = false;
  }
});

// Delegated Mind Control Room handlers
obsViewMind.addEventListener("submit", async (e) => {
  e.preventDefault();
  const agent = encodeURIComponent(mindActiveAgent);

  if (e.target.id === "mind-add-mem-form") {
    const input = document.getElementById("mind-new-mem");
    await api(`/admin/agents/${agent}/memories`, {
      method: "POST",
      body: JSON.stringify({ note: input.value }),
    });
    await loadMind(mindActiveAgent);
    return;
  }

  if (e.target.id === "mind-note-form") {
    const slug = document.getElementById("mind-note-slug").value;
    const title = document.getElementById("mind-note-title").value;
    const content = document.getElementById("mind-note-content").value;
    const statusEl = document.getElementById("mind-note-status");
    setStatus(statusEl, "Saving…");
    try {
      const { note } = await api(`/admin/agents/${agent}/notes`, {
        method: "PUT",
        body: JSON.stringify({ slug, title, content }),
      });
      mindSelectedNoteSlug = note.slug;
      await loadMind(mindActiveAgent);
    } catch (err) {
      setStatus(statusEl, err.message, "is-error");
    }
    return;
  }

  if (e.target.id === "mind-add-goal-form") {
    const title = document.getElementById("mind-goal-title").value;
    const priority = document.getElementById("mind-goal-priority").value;
    const description = document.getElementById("mind-goal-desc").value;
    await api(`/admin/agents/${agent}/goals`, {
      method: "POST",
      body: JSON.stringify({ title, priority, description }),
    });
    await loadMind(mindActiveAgent);
    return;
  }

  if (e.target.id === "mind-wake-interval-form") {
    const minutes = Number(document.getElementById("mind-wake-interval-min").value);
    const statusEl = document.getElementById("mind-wake-interval-status");
    setStatus(statusEl, "Saving…");
    try {
      await api(`/admin/agents/${agent}/config`, {
        method: "PATCH",
        body: JSON.stringify({ wakeIntervalMinutes: minutes }),
      });
      await loadMind(mindActiveAgent);
      loadObservatoryStatus().catch(() => {});
    } catch (err) {
      setStatus(statusEl, err.message, "is-error");
    }
    return;
  }

  if (e.target.id === "mind-add-task-form") {
    const inMinutes = Number(document.getElementById("mind-task-min").value);
    const note = document.getElementById("mind-task-note").value;
    await api(`/admin/agents/${agent}/tasks`, {
      method: "POST",
      body: JSON.stringify({ inMinutes, note }),
    });
    await loadMind(mindActiveAgent);
    return;
  }

  if (e.target.id === "mind-prompt-form") {
    const systemPrompt = document.getElementById("mind-prompt-text").value;
    const statusEl = document.getElementById("mind-prompt-status");
    setStatus(statusEl, "Saving…");
    try {
      await api(`/admin/agents/${agent}/prompts`, {
        method: "POST",
        body: JSON.stringify({ systemPrompt }),
      });
      await loadMind(mindActiveAgent);
    } catch (err) {
      setStatus(statusEl, err.message, "is-error");
    }
    return;
  }

  if (e.target.id === "mind-config-form") {
    const modelOverride = document.getElementById("mind-model-override").value.trim();
    const toolGrants = {};
    obsViewMind.querySelectorAll("[data-tool-grant]").forEach((cb) => {
      toolGrants[cb.dataset.toolGrant] = cb.checked;
    });
    const statusEl = document.getElementById("mind-config-status");
    setStatus(statusEl, "Saving…");
    try {
      await api(`/admin/agents/${agent}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          modelOverride: modelOverride || null,
          toolGrants,
        }),
      });
      await loadMind(mindActiveAgent);
    } catch (err) {
      setStatus(statusEl, err.message, "is-error");
    }
  }
});

obsViewMind.addEventListener("click", async (e) => {
  const agent = encodeURIComponent(mindActiveAgent);

  const memSave = e.target.closest("[data-mem-save]");
  if (memSave) {
    const id = memSave.dataset.memSave;
    const input = obsViewMind.querySelector(`[data-mem-input="${id}"]`);
    if (input) {
      await api(`/admin/agents/${agent}/memories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ note: input.value }),
      });
      await loadMind(mindActiveAgent);
    }
    return;
  }

  const memDel = e.target.closest("[data-mem-del]");
  if (memDel) {
    await api(`/admin/agents/${agent}/memories/${memDel.dataset.memDel}`, {
      method: "DELETE",
    });
    await loadMind(mindActiveAgent);
    return;
  }

  const selNote = e.target.closest("[data-select-note]");
  if (selNote) {
    mindSelectedNoteSlug = selNote.dataset.selectNote;
    renderMindNotes();
    return;
  }

  if (e.target.id === "mind-new-note-btn") {
    mindSelectedNoteSlug = "";
    renderMindNotes();
    document.getElementById("mind-note-slug")?.focus();
    return;
  }

  if (e.target.id === "mind-delete-note-btn") {
    const slug = e.target.dataset.slug;
    await api(`/admin/agents/${agent}/notes?slug=${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    mindSelectedNoteSlug = "";
    await loadMind(mindActiveAgent);
    return;
  }

  const goalSave = e.target.closest("[data-goal-save]");
  if (goalSave) {
    const id = goalSave.dataset.goalSave;
    const status = obsViewMind.querySelector(`[data-goal-status="${id}"]`)?.value;
    const priority = obsViewMind.querySelector(`[data-goal-priority="${id}"]`)?.value;
    const progressNote = obsViewMind.querySelector(`[data-goal-progress="${id}"]`)?.value;
    await api(`/admin/agents/${agent}/goals/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status, priority, progressNote }),
    });
    await loadMind(mindActiveAgent);
    return;
  }

  const goalDel = e.target.closest("[data-goal-del]");
  if (goalDel) {
    await api(`/admin/agents/${agent}/goals/${encodeURIComponent(goalDel.dataset.goalDel)}`, {
      method: "DELETE",
    });
    await loadMind(mindActiveAgent);
    return;
  }

  if (e.target.id === "mind-disable-wake-interval-btn") {
    await api(`/admin/agents/${agent}/config`, {
      method: "PATCH",
      body: JSON.stringify({ wakeIntervalMinutes: null }),
    });
    await loadMind(mindActiveAgent);
    loadObservatoryStatus().catch(() => {});
    return;
  }

  const cancelTask = e.target.closest("[data-mind-cancel-task]");
  if (cancelTask) {
    await api(
      `/admin/agents/${agent}/tasks/${encodeURIComponent(cancelTask.dataset.mindCancelTask)}`,
      { method: "DELETE" },
    );
    await loadMind(mindActiveAgent);
    return;
  }

  const verBtn = e.target.closest("[data-load-prompt-ver]");
  if (verBtn && mindSnapshot) {
    const vNum = Number(verBtn.dataset.loadPromptVer);
    const found = mindSnapshot.promptVersions.find((v) => v.version === vNum);
    const ta = document.getElementById("mind-prompt-text");
    if (found && ta) ta.value = found.systemPrompt;
    return;
  }

  if (e.target.id === "mind-load-default-prompt" && mindSnapshot) {
    const ta = document.getElementById("mind-prompt-text");
    if (ta) ta.value = mindSnapshot.defaultPrompt;
  }
});
document.getElementById("obs-reconnect").addEventListener("click", () => {
  obsReconnectAttempt = 0;
  connectObservatory();
});
document.getElementById("obs-inspector-close").addEventListener("click", () => {
  obsSelectedEventId = null;
  obsInspector.classList.add("hidden");
  renderObservatoryStream();
});

document.getElementById("refresh").addEventListener("click", () => {
  loadThreads().catch((err) => {
    threadListEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
  });
});

document.getElementById("refresh-messages").addEventListener("click", () => {
  loadMessages().catch((err) => {
    messageListEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
  });
});

document.getElementById("refresh-thread").addEventListener("click", () => {
  if (!activeThreadId) return;
  loadThread(activeThreadId).catch((err) => {
    threadDetailEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
  });
});

threadDetailEl.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("[data-copy-ref]");
  if (!copyBtn) return;
  const ref = copyBtn.dataset.copyRef;
  if (!ref) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(ref);
    }
    copyBtn.textContent = "copied";
    copyBtn.classList.add("is-copied");
    setTimeout(() => {
      copyBtn.textContent = "copy ref";
      copyBtn.classList.remove("is-copied");
    }, 1500);
  } catch {
    // ignore clipboard restrictions
  }
});

backBoardBtn.addEventListener("click", () => {
  location.hash = activeThreadBoard === "messages" ? "#/messages" : "#/";
});

focusComposerBtn.addEventListener("click", () => {
  if (!canPost) return;
  composerSection.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("thread-title").focus();
});

document.getElementById("focus-dm-composer").addEventListener("click", () => {
  if (!canPost) return;
  document
    .getElementById("dm-composer")
    .scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("dm-recipient").focus();
});

window.addEventListener("hashchange", () => {
  route().catch((err) => {
    const view = parseRoute().view;
    const target =
      view === "thread"
        ? threadDetailEl
        : view === "messages"
          ? messageListEl
          : view === "observatory"
            ? obsStreamEl
            : threadListEl;
    target.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
  });
});

window.addEventListener("keydown", (e) => {
  if (isTypingTarget(e.target)) return;

  if (e.key === "n" && canPost && !boardView.classList.contains("hidden")) {
    e.preventDefault();
    focusComposerBtn.click();
  } else if (
    e.key === "n" &&
    canPost &&
    !messagesView.classList.contains("hidden")
  ) {
    e.preventDefault();
    document.getElementById("focus-dm-composer").click();
  } else if (e.key === "j") {
    e.preventDefault();
    selectRow(1);
  } else if (e.key === "k") {
    e.preventDefault();
    selectRow(selectedRowIndex < 0 ? 0 : -1);
  } else if (e.key === "Escape") {
    if (!threadView.classList.contains("hidden")) {
      location.hash = activeThreadBoard === "messages" ? "#/messages" : "#/";
    } else if (!obsInspector.classList.contains("hidden")) {
      obsSelectedEventId = null;
      obsInspector.classList.add("hidden");
      renderObservatoryStream();
    }
  }
});

(async () => {
  try {
    await Promise.all([loadMe(), loadSignals()]);
    await route();
  } catch (err) {
    threadListEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
  }
})();
