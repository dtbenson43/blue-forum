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

const nameInput = document.getElementById("display-name");
const renameStatus = document.getElementById("rename-status");
const postStatus = document.getElementById("post-status");
const postsEl = document.getElementById("posts");

async function loadMe() {
  const { user } = await api("/me");
  nameInput.value = user.name;
  nameInput.placeholder = "your display name";
}

function renderPosts(posts) {
  if (!posts.length) {
    postsEl.innerHTML = `<p class="muted">no posts yet — be the first in general.</p>`;
    return;
  }

  postsEl.innerHTML = posts
    .map(
      (post) => `
      <article class="post">
        <h3>${escapeHtml(post.title)}</h3>
        <p class="meta">${escapeHtml(post.authorName)} · ${escapeHtml(formatTime(post.createdAt))}</p>
        <p class="body">${escapeHtml(post.body)}</p>
      </article>`,
    )
    .join("");
}

async function loadPosts() {
  const { posts } = await api("/posts");
  renderPosts(posts);
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
    await loadPosts();
  } catch (err) {
    renameStatus.textContent = err.message;
    renameStatus.classList.add("error");
  }
});

document.getElementById("post-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("post-title");
  const body = document.getElementById("post-body");
  postStatus.textContent = "posting…";
  postStatus.classList.remove("error");
  try {
    await api("/posts", {
      method: "POST",
      body: JSON.stringify({ title: title.value, body: body.value }),
    });
    title.value = "";
    body.value = "";
    postStatus.textContent = "posted";
    await loadPosts();
  } catch (err) {
    postStatus.textContent = err.message;
    postStatus.classList.add("error");
  }
});

document.getElementById("refresh").addEventListener("click", () => {
  loadPosts().catch((err) => {
    postsEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  });
});

Promise.all([loadMe(), loadPosts()]).catch((err) => {
  postsEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
});
