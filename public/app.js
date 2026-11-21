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

function formatTime(iso) {
  try {
    return new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleString();
  } catch {
    return iso;
  }
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const threadMatch = hash.match(/^\/thread\/(\d+)$/);
  if (threadMatch) {
    return { view: "thread", threadId: Number(threadMatch[1]) };
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

const nameInput = document.getElementById("display-name");
const renameStatus = document.getElementById("rename-status");
const threadStatus = document.getElementById("thread-status");
const replyStatus = document.getElementById("reply-status");
const threadListEl = document.getElementById("thread-list");
const threadDetailEl = document.getElementById("thread-detail");
const boardView = document.getElementById("board-view");
const threadView = document.getElementById("thread-view");

let activeThreadId = null;
let selectedRowIndex = -1;

function setStatus(el, message, kind = "") {
  el.textContent = message;
  el.classList.remove("is-error", "is-ok");
  if (kind) el.classList.add(kind);
}

async function loadMe() {
  const { user } = await api("/me");
  nameInput.value = user.name;
  nameInput.placeholder = "display name";
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
    threadListEl.innerHTML = `<p class="empty">No threads yet. Start the first one below.</p>`;
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
            ${escapeHtml(thread.authorName)} · last activity
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

function renderThreadDetail(thread) {
  const posts = thread.posts
    .map(
      (post, index) => `
      <article class="post">
        <header class="post-header">
          ${index === 0 ? "OP · " : "#" + index + " · "}
          <strong>${escapeHtml(post.authorName)}</strong>
          · <time datetime="${escapeHtml(post.createdAt)}">${escapeHtml(formatTime(post.createdAt))}</time>
        </header>
        <p class="post-body">${escapeHtml(post.body)}</p>
      </article>`,
    )
    .join("");

  threadDetailEl.innerHTML = `
    <div class="thread-heading">
      <h1>${escapeHtml(thread.title)}</h1>
      <p class="meta">
        Started by ${escapeHtml(thread.authorName)} ·
        <time datetime="${escapeHtml(thread.createdAt)}">${escapeHtml(formatTime(thread.createdAt))}</time>
      </p>
    </div>
    <div class="post-stack">${posts}</div>
  `;
}

async function loadThreads() {
  const { threads } = await api("/threads");
  renderThreadList(threads);
}

async function loadThread(threadId) {
  const { thread } = await api(`/threads/${threadId}`);
  activeThreadId = thread.id;
  renderThreadDetail(thread);
  document.title = `${thread.title} — BLUE//SIGNAL`;
}

function showBoard() {
  activeThreadId = null;
  boardView.classList.remove("hidden");
  threadView.classList.add("hidden");
  document.title = "BLUE//SIGNAL — / general";
}

function showThread() {
  boardView.classList.add("hidden");
  threadView.classList.remove("hidden");
}

async function route() {
  const current = parseRoute();
  if (current.view === "thread") {
    showThread();
    await loadThread(current.threadId);
  } else {
    showBoard();
    await loadThreads();
  }
}

function selectRow(delta) {
  const rows = [...threadListEl.querySelectorAll(".thread-row")];
  if (!rows.length || boardView.classList.contains("hidden")) return;
  selectedRowIndex = Math.max(
    0,
    Math.min(rows.length - 1, selectedRowIndex + delta),
  );
  rows.forEach((row, i) => row.classList.toggle("is-selected", i === selectedRowIndex));
  rows[selectedRowIndex]?.focus();
}

document.getElementById("rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus(renameStatus, "Saving…");
  try {
    const { user } = await api("/me", {
      method: "PATCH",
      body: JSON.stringify({ name: nameInput.value }),
    });
    nameInput.value = user.name;
    setStatus(renameStatus, "Saved", "is-ok");
    await route();
  } catch (err) {
    setStatus(renameStatus, err.message, "is-error");
  }
});

document.getElementById("thread-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("thread-title");
  const body = document.getElementById("thread-body");
  setStatus(threadStatus, "Submitting…");
  try {
    const { thread } = await api("/threads", {
      method: "POST",
      body: JSON.stringify({ title: title.value, body: body.value }),
    });
    title.value = "";
    body.value = "";
    setStatus(threadStatus, "Thread created", "is-ok");
    location.hash = `#/thread/${thread.id}`;
  } catch (err) {
    setStatus(threadStatus, err.message, "is-error");
  }
});

document.getElementById("reply-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeThreadId) return;
  const body = document.getElementById("reply-body");
  setStatus(replyStatus, "Posting…");
  try {
    await api(`/threads/${activeThreadId}/posts`, {
      method: "POST",
      body: JSON.stringify({ body: body.value }),
    });
    body.value = "";
    setStatus(replyStatus, "Reply posted", "is-ok");
    await loadThread(activeThreadId);
  } catch (err) {
    setStatus(replyStatus, err.message, "is-error");
  }
});

document.getElementById("refresh").addEventListener("click", () => {
  loadThreads().catch((err) => {
    threadListEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
  });
});

document.getElementById("refresh-thread").addEventListener("click", () => {
  if (!activeThreadId) return;
  loadThread(activeThreadId).catch((err) => {
    threadDetailEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
  });
});

document.getElementById("back-board").addEventListener("click", () => {
  location.hash = "#/";
});

document.getElementById("focus-composer").addEventListener("click", () => {
  document.getElementById("composer").scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("thread-title").focus();
});

window.addEventListener("hashchange", () => {
  route().catch((err) => {
    const target =
      parseRoute().view === "thread" ? threadDetailEl : threadListEl;
    target.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
  });
});

window.addEventListener("keydown", (e) => {
  if (isTypingTarget(e.target)) return;

  if (e.key === "n" && !boardView.classList.contains("hidden")) {
    e.preventDefault();
    document.getElementById("focus-composer").click();
  } else if (e.key === "j") {
    e.preventDefault();
    selectRow(1);
  } else if (e.key === "k") {
    e.preventDefault();
    selectRow(selectedRowIndex < 0 ? 0 : -1);
  } else if (e.key === "Escape") {
    if (!threadView.classList.contains("hidden")) {
      location.hash = "#/";
    }
  }
});

Promise.all([loadMe(), route()]).catch((err) => {
  threadListEl.innerHTML = `<p class="error empty">${escapeHtml(err.message)}</p>`;
});
