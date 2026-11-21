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

const nameInput = document.getElementById("display-name");
const renameStatus = document.getElementById("rename-status");
const threadStatus = document.getElementById("thread-status");
const replyStatus = document.getElementById("reply-status");
const threadListEl = document.getElementById("thread-list");
const threadDetailEl = document.getElementById("thread-detail");
const boardView = document.getElementById("board-view");
const threadView = document.getElementById("thread-view");

let activeThreadId = null;

async function loadMe() {
  const { user } = await api("/me");
  nameInput.value = user.name;
  nameInput.placeholder = "your display name";
}

function renderThreadList(threads) {
  if (!threads.length) {
    threadListEl.innerHTML = `<p class="muted">no threads yet — start the first.</p>`;
    return;
  }

  threadListEl.innerHTML = threads
    .map((thread) => {
      const replies =
        thread.replyCount === 1
          ? "1 reply"
          : `${thread.replyCount} replies`;
      return `
      <article class="post thread-item">
        <h3>
          <a href="#/thread/${thread.id}">${escapeHtml(thread.title)}</a>
        </h3>
        <p class="meta">
          ${escapeHtml(thread.authorName)} · ${escapeHtml(formatTime(thread.createdAt))}
          · ${replies} · bumped ${escapeHtml(formatTime(thread.bumpedAt))}
        </p>
      </article>`;
    })
    .join("");
}

function renderThreadDetail(thread) {
  const posts = thread.posts
    .map(
      (post, index) => `
      <article class="post ${index === 0 ? "op" : "reply"}">
        <p class="meta">
          ${index === 0 ? "OP · " : `#${index} · "}
          ${escapeHtml(post.authorName)} · ${escapeHtml(formatTime(post.createdAt))}
        </p>
        <p class="body">${escapeHtml(post.body)}</p>
      </article>`,
    )
    .join("");

  threadDetailEl.innerHTML = `
    <h2 class="thread-title">${escapeHtml(thread.title)}</h2>
    <p class="meta thread-meta">
      started by ${escapeHtml(thread.authorName)} · ${escapeHtml(formatTime(thread.createdAt))}
    </p>
    <div class="posts">${posts}</div>
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
  document.title = `${thread.title.toUpperCase()} — BLUE FORUM`;
}

function showBoard() {
  activeThreadId = null;
  boardView.classList.remove("hidden");
  threadView.classList.add("hidden");
  document.title = "BLUE FORUM — GENERAL";
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

document.getElementById("rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  renameStatus.textContent = "saving…";
  renameStatus.classList.remove("error");
  try {
    const { user } = await api("/me", {
      method: "PATCH",
      body: JSON.stringify({ name: nameInput.value }),
    });
    nameInput.value = user.name;
    renameStatus.textContent = "saved";
    await route();
  } catch (err) {
    renameStatus.textContent = err.message;
    renameStatus.classList.add("error");
  }
});

document.getElementById("thread-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("thread-title");
  const body = document.getElementById("thread-body");
  threadStatus.textContent = "starting…";
  threadStatus.classList.remove("error");
  try {
    const { thread } = await api("/threads", {
      method: "POST",
      body: JSON.stringify({ title: title.value, body: body.value }),
    });
    title.value = "";
    body.value = "";
    threadStatus.textContent = "started";
    location.hash = `#/thread/${thread.id}`;
  } catch (err) {
    threadStatus.textContent = err.message;
    threadStatus.classList.add("error");
  }
});

document.getElementById("reply-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeThreadId) return;
  const body = document.getElementById("reply-body");
  replyStatus.textContent = "sending…";
  replyStatus.classList.remove("error");
  try {
    await api(`/threads/${activeThreadId}/posts`, {
      method: "POST",
      body: JSON.stringify({ body: body.value }),
    });
    body.value = "";
    replyStatus.textContent = "sent";
    await loadThread(activeThreadId);
  } catch (err) {
    replyStatus.textContent = err.message;
    replyStatus.classList.add("error");
  }
});

document.getElementById("refresh").addEventListener("click", () => {
  loadThreads().catch((err) => {
    threadListEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  });
});

document.getElementById("refresh-thread").addEventListener("click", () => {
  if (!activeThreadId) return;
  loadThread(activeThreadId).catch((err) => {
    threadDetailEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  });
});

document.getElementById("back-board").addEventListener("click", () => {
  location.hash = "#/";
});

window.addEventListener("hashchange", () => {
  route().catch((err) => {
    const target = parseRoute().view === "thread" ? threadDetailEl : threadListEl;
    target.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  });
});

Promise.all([loadMe(), route()]).catch((err) => {
  threadListEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
});
