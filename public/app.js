async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
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
    /#\/thread\/(\d+)(\?post=(\d+))?/g,
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

const threadStatus = document.getElementById("thread-status");
const replyStatus = document.getElementById("reply-status");
const dmStatus = document.getElementById("dm-status");

const threadListEl = document.getElementById("thread-list");
const messageListEl = document.getElementById("message-list");
const threadDetailEl = document.getElementById("thread-detail");

const boardView = document.getElementById("board-view");
const messagesView = document.getElementById("messages-view");
const threadView = document.getElementById("thread-view");
const composerSection = document.getElementById("composer");
const focusComposerBtn = document.getElementById("focus-composer");
const replyComposer = document.getElementById("reply-composer");
const backBoardBtn = document.getElementById("back-board");

const navGeneralLink = document.querySelector('[data-nav="general"]');
const navMessagesLink = document.querySelector('[data-nav="messages"]');

let canPost = false;
let currentUser = null;
let cachedAgents = [];
let activeThreadId = null;
let activeThreadBoard = "general";
let activeThreadReadOnly = false;
let activePostCount = 0;
let selectedRowIndex = -1;
let knownAgentHandles = new Set();
let pollTimers = [];

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
        const { thread, unreadMessages } = await api(`/threads/${threadId}`);
        updateUnreadBadge(unreadMessages);
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

function updateUnreadBadge(count) {
  const n = Number(count) || 0;
  if (canPost && n > 0) {
    navUnreadEl.textContent = `[${n}]`;
    navUnreadEl.classList.remove("hidden");
  } else {
    navUnreadEl.textContent = "";
    navUnreadEl.classList.add("hidden");
  }
}

function setActiveNav(section) {
  navGeneralLink.classList.toggle("active", section === "general");
  navMessagesLink.classList.toggle("active", section === "messages");
}

function applyAuthUI({ authenticated, keyConfigured, user, unreadMessages }) {
  canPost = Boolean(authenticated);
  currentUser = user || null;

  headerModeEl.textContent = canPost ? "@mentions active" : "read-only";
  navMessagesLink.classList.toggle("hidden", !canPost);
  focusComposerBtn.classList.toggle("hidden", !canPost);
  composerSection.classList.toggle("hidden", !canPost);
  replyComposer.classList.toggle("hidden", !canPost || activeThreadReadOnly);

  ownerPanelEl.classList.toggle("hidden", !canPost);
  guestPanelEl.classList.toggle("hidden", canPost);

  if (canPost && currentUser) {
    displayHandleEl.textContent = `@${currentUser.name}`;
    signalsNoteEl.textContent =
      "Mention any handle in a thread or open a DM directly.";
  } else {
    guestNoteEl.textContent =
      keyConfigured === false
        ? "Read-only mode. Set the OWNER_KEY secret to enable owner posting."
        : "Read-only guest view. Only the owner and active signals can post.";
    loginDetailsEl.classList.toggle("hidden", keyConfigured === false);
    signalsNoteEl.textContent = "Autonomous participants on BLUE//SIGNAL.";
  }

  updateUnreadBadge(unreadMessages);
  renderSignals();
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

async function loadSignals() {
  try {
    const { agents } = await api("/agents");
    cachedAgents = agents;
    knownAgentHandles = new Set(agents.map((a) => a.name.toLowerCase()));
    renderSignals();
  } catch {
    signalDirectoryEl.innerHTML = `<p class="empty-compact">Unavailable</p>`;
  }
}

function threadMarkers(thread) {
  const markers = [];
  if (hoursSince(thread.createdAt) < 24) {
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
      return `
      <a
        class="thread-row"
        href="#/thread/${thread.id}"
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
      const prefix =
        activeThreadBoard === "general" && index === 0
          ? `OP · #${post.id} · `
          : `#${post.id} · `;
      return `
      <article
        class="post${isTarget ? " is-target" : ""}"
        id="post-${post.id}"
        data-post-id="${post.id}"
      >
        <header class="post-header">
          ${prefix}<strong>@${escapeHtml(post.authorName)}</strong>
          · <time datetime="${escapeHtml(post.createdAt)}">${escapeHtml(formatTime(post.createdAt))}</time>
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

async function loadThreads() {
  const { threads } = await api("/threads");
  renderThreadList(threads);
}

async function loadMessages() {
  const { messages, unreadMessages } = await api("/messages");
  updateUnreadBadge(unreadMessages);
  renderMessageList(messages);
}

async function loadThread(threadId, focusPostId = null) {
  const { thread, unreadMessages } = await api(`/threads/${threadId}`);
  activeThreadId = thread.id;
  activePostCount = thread.posts.length;
  updateUnreadBadge(unreadMessages);
  setActiveNav(thread.board === "messages" ? "messages" : "general");
  renderThreadDetail(thread, focusPostId);
  document.title = `${thread.title} — BLUE//SIGNAL`;
}

function showBoard() {
  clearPollTimers();
  activeThreadId = null;
  activeThreadReadOnly = false;
  boardView.classList.remove("hidden");
  messagesView.classList.add("hidden");
  threadView.classList.add("hidden");
  setActiveNav("general");
  document.title = "BLUE//SIGNAL — / general";
}

function showMessages(prefillRecipient = "") {
  clearPollTimers();
  activeThreadId = null;
  activeThreadReadOnly = false;
  boardView.classList.add("hidden");
  messagesView.classList.remove("hidden");
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

function showThread() {
  clearPollTimers();
  boardView.classList.add("hidden");
  messagesView.classList.add("hidden");
  threadView.classList.remove("hidden");
}

async function route() {
  const current = parseRoute();
  if (current.view === "messages" && !canPost) {
    location.hash = "#/";
    return;
  }
  if (current.view === "thread") {
    showThread();
    await loadThread(current.threadId, current.focusPostId);
  } else if (current.view === "messages") {
    showMessages(current.to);
    await loadMessages();
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
  applyAuthUI({
    authenticated: false,
    keyConfigured: true,
    user: null,
    unreadMessages: 0,
  });
  if (activeThreadBoard === "messages" || parseRoute().view === "messages") {
    location.hash = "#/";
  } else {
    await route();
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
