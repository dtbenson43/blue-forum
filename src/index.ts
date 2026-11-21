import { Forum } from "./forum/forum";
import { Agent } from "./agents/agent";
import {
  AGENT_NAMES,
  getAgentDirectory,
  isRegisteredAgent,
} from "./agents/personalities";
import { OWNER_USER_ID } from "./shared/handles";
import {
  buildOwnerCookie,
  clearOwnerCookie,
  createOwnerToken,
  OWNER_COOKIE,
  verifyOwnerToken,
  verifyPassphrase,
} from "./shared/auth";

export { Forum, Agent };

export type Env = {
  FORUM: DurableObjectNamespace<Forum>;
  AGENTS: DurableObjectNamespace<Agent>;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_DEFAULT_MODEL?: string;
  AGENT_MODEL_ORACLE?: string;
  AGENT_MODEL_SKEPTIC?: string;
  AGENT_MODEL_GHOST?: string;
  AGENTS_ENABLED?: string;
  OWNER_KEY?: string;
  OWNER_HANDLE?: string;
  ADMIN_TOKEN?: string;
  SITE_URL?: string;
};

let bootstrapInitiated = false;

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [k, ...rest] = part.trim().split("=");
      return [k!, decodeURIComponent(rest.join("=") || "")];
    }),
  );
}

function forumStub(env: Env) {
  return env.FORUM.getByName("general");
}

function getOwnerHandle(env: Env): string {
  return env.OWNER_HANDLE?.trim() || "overlord";
}

async function isSignedInOwner(request: Request, env: Env): Promise<boolean> {
  const ownerKey = env.OWNER_KEY?.trim();
  if (!ownerKey) return false;
  const cookies = parseCookies(request.headers.get("Cookie"));
  return verifyOwnerToken(cookies[OWNER_COOKIE], ownerKey);
}

async function bootstrapAllAgents(env: Env): Promise<void> {
  await forumStub(env).registerAgents([...AGENT_NAMES]);
  await Promise.all(
    AGENT_NAMES.map((name) => env.AGENTS.getByName(name).bootstrap(name)),
  );
}

function ensureAgentsBootstrapped(env: Env, ctx: ExecutionContext) {
  if (bootstrapInitiated || env.AGENTS_ENABLED === "false") return;
  bootstrapInitiated = true;
  ctx.waitUntil(
    bootstrapAllAgents(env).catch((err) => {
      bootstrapInitiated = false;
      console.error("[Worker] Agent bootstrap failed:", err);
    }),
  );
}

async function isAuthorizedAdmin(request: Request, env: Env): Promise<boolean> {
  if (await isSignedInOwner(request, env)) {
    return true;
  }

  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const provided = auth.slice("Bearer ".length).trim();
    const adminToken = env.ADMIN_TOKEN?.trim();
    if (adminToken && (await verifyPassphrase(provided, adminToken))) {
      return true;
    }
    const ownerKey = env.OWNER_KEY?.trim();
    if (ownerKey && (await verifyPassphrase(provided, ownerKey))) {
      return true;
    }
  }

  if (!env.ADMIN_TOKEN?.trim()) {
    const host = new URL(request.url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }

  return false;
}

async function handleAdminRoute(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  if (!(await isAuthorizedAdmin(request, env))) {
    return Response.json(
      { error: "Unauthorized (sign in as owner or provide Bearer token)" },
      { status: 403 },
    );
  }

  if (request.method === "GET" && url.pathname === "/api/admin/agents/status") {
    const agents = await Promise.all(
      AGENT_NAMES.map((name) => env.AGENTS.getByName(name).getStatus(name)),
    );
    return Response.json({
      enabled: env.AGENTS_ENABLED !== "false",
      hasOpenRouterKey: Boolean(env.OPENROUTER_API_KEY?.trim()),
      hasOwnerKey: Boolean(env.OWNER_KEY?.trim()),
      agents,
    });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/agents/bootstrap"
  ) {
    await bootstrapAllAgents(env);
    return Response.json({ ok: true, agents: AGENT_NAMES });
  }

  const wakeMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/wake$/,
  );
  if (request.method === "POST" && wakeMatch) {
    const name = wakeMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json(
        { error: `Unknown agent @${name}` },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      mode?: "inbox" | "browse";
    };
    const mode = body.mode === "inbox" ? "inbox" : "browse";
    await env.AGENTS.getByName(name).wakeNow(name, mode);
    return Response.json({ ok: true, agent: name, mode });
  }

  const pauseMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/pause$/,
  );
  if (request.method === "POST" && pauseMatch) {
    const name = pauseMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json(
        { error: `Unknown agent @${name}` },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as {
      paused?: boolean;
    };
    const paused = body.paused !== false;
    await env.AGENTS.getByName(name).setPaused(name, paused);
    return Response.json({ ok: true, agent: name, paused });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

function forwardToForum(
  request: Request,
  url: URL,
  env: Env,
  isOwner: boolean,
): Promise<Response> {
  const path = url.pathname.slice("/api".length) || "/";
  const headers = new Headers(request.headers);
  if (isOwner) {
    headers.set("X-User-Id", OWNER_USER_ID);
    headers.set("X-Owner-Handle", getOwnerHandle(env));
    headers.delete("X-Read-Only");
  } else {
    headers.delete("X-User-Id");
    headers.set("X-Read-Only", "1");
  }

  const upstream = new Request(
    new URL(`${path}${url.search}`, "https://forum.internal"),
    {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
    },
  );
  return forumStub(env).fetch(upstream);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const isSecure = url.protocol === "https:";
    const ownerKey = env.OWNER_KEY?.trim() || "";

    if (url.pathname.startsWith("/api/admin/")) {
      return handleAdminRoute(request, url, env);
    }

    if (request.method === "GET" && url.pathname === "/api/agents") {
      ensureAgentsBootstrapped(env, ctx);
      return Response.json({
        enabled: env.AGENTS_ENABLED !== "false",
        agents: getAgentDirectory(),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth") {
      if (!ownerKey) {
        return Response.json(
          { error: "OWNER_KEY secret is not configured" },
          { status: 503 },
        );
      }
      const { passphrase } = (await request.json().catch(() => ({}))) as {
        passphrase?: string;
      };
      if (
        typeof passphrase !== "string" ||
        !(await verifyPassphrase(passphrase, ownerKey))
      ) {
        return Response.json({ error: "Invalid passphrase" }, { status: 401 });
      }

      const token = await createOwnerToken(ownerKey);
      const meRes = await forumStub(env).fetch(
        new Request("https://forum.internal/me", {
          headers: {
            "X-User-Id": OWNER_USER_ID,
            "X-Owner-Handle": getOwnerHandle(env),
          },
        }),
      );
      const meData = (await meRes.json()) as {
        user: { id: string; name: string; kind: string };
        unreadMessages: number;
      };

      return Response.json(
        {
          authenticated: true,
          keyConfigured: true,
          canPost: true,
          user: meData.user,
          unreadMessages: meData.unreadMessages,
        },
        {
          headers: {
            "Set-Cookie": buildOwnerCookie(token, isSecure),
          },
        },
      );
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      return Response.json(
        { authenticated: false, canPost: false },
        {
          headers: {
            "Set-Cookie": clearOwnerCookie(isSecure),
          },
        },
      );
    }

    if (url.pathname.startsWith("/api/")) {
      ensureAgentsBootstrapped(env, ctx);
      const isOwner = await isSignedInOwner(request, env);

      if (request.method === "GET" && url.pathname === "/api/me") {
        if (!isOwner) {
          return Response.json({
            authenticated: false,
            keyConfigured: Boolean(ownerKey),
            canPost: false,
            user: null,
            unreadMessages: 0,
          });
        }
        const res = await forwardToForum(request, url, env, true);
        const data = (await res.json()) as {
          user: { id: string; name: string; kind: string };
          unreadMessages: number;
        };
        return Response.json({
          authenticated: true,
          keyConfigured: true,
          canPost: true,
          user: data.user,
          unreadMessages: data.unreadMessages,
        });
      }

      // Public read-only routes: GET /api/threads and GET /api/threads/:id (general only)
      const isPublicRead =
        request.method === "GET" &&
        (url.pathname === "/api/threads" ||
          /^\/api\/threads\/\d+$/.test(url.pathname));

      if (!isPublicRead && !isOwner) {
        if (!ownerKey) {
          return Response.json(
            { error: "Posting disabled: OWNER_KEY secret is not configured" },
            { status: 503 },
          );
        }
        return Response.json(
          { error: "Owner sign-in required" },
          { status: 401 },
        );
      }

      return forwardToForum(request, url, env, isOwner);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
