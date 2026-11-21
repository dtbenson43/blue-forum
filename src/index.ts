import { Forum } from "./forum";

export { Forum };

export type Env = {
  FORUM: DurableObjectNamespace<Forum>;
  ASSETS: Fetcher;
};

const COOKIE = "bf_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [k, ...rest] = part.trim().split("=");
      return [k!, decodeURIComponent(rest.join("=") || "")];
    }),
  );
}

function getOrCreateUserId(request: Request): {
  userId: string;
  setCookie: string | null;
} {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const existing = cookies[COOKIE];
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
    return { userId: existing, setCookie: null };
  }
  const userId = crypto.randomUUID();
  const setCookie = `${COOKIE}=${userId}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`;
  return { userId, setCookie };
}

function forumStub(env: Env) {
  const id = env.FORUM.idFromName("general");
  return env.FORUM.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const { userId, setCookie } = getOrCreateUserId(request);
      const path = url.pathname.slice("/api".length) || "/";
      const headers = new Headers(request.headers);
      headers.set("X-User-Id", userId);

      const upstream = new Request(new URL(path, "https://forum.internal"), {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
      });

      const response = await forumStub(env).fetch(upstream);
      const out = new Response(response.body, response);
      if (setCookie) {
        out.headers.append("Set-Cookie", setCookie);
      }
      return out;
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
