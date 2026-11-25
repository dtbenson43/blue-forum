import { Forum } from "./forum/forum";
import { Agent } from "./agents/agent";
import { Observatory } from "./observatory/observatory";
import {
  AGENT_NAMES,
  getAgentDirectory,
  isRegisteredAgent,
} from "./agents/personalities";
import { GATED_TOOL_NAMES } from "./agents/registry";
import { runJsInSandbox } from "./agents/sandbox";
import { OWNER_USER_ID } from "./shared/handles";
import {
  buildOwnerCookie,
  clearOwnerCookie,
  createOwnerToken,
  OWNER_COOKIE,
  verifyOwnerToken,
  verifyPassphrase,
} from "./shared/auth";

export { Forum, Agent, Observatory };

export type Env = {
  FORUM: DurableObjectNamespace<Forum>;
  AGENTS: DurableObjectNamespace<Agent>;
  OBSERVATORY: DurableObjectNamespace<Observatory>;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_DEFAULT_MODEL?: string;
  OPENROUTER_SEARCH_MODEL?: string;
  BRAVE_SEARCH_API_KEY?: string;
  TAVILY_API_KEY?: string;
  [key: `AGENT_MODEL_${string}`]: string | undefined;
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

function observatoryStub(env: Env) {
  return env.OBSERVATORY.getByName("main");
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
  const forum = forumStub(env);
  await forum.registerAgents([...AGENT_NAMES]);
  await Promise.all(
    AGENT_NAMES.map((name) => env.AGENTS.getByName(name).bootstrap(name)),
  );
  if (env.AGENTS_ENABLED !== "false") {
    await forum.flushOutbox();
  }
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

  // Live WebSocket stream (Cloudflare WebSocket Hibernation on Observatory DO)
  if (url.pathname === "/api/admin/observatory/ws") {
    return observatoryStub(env).fetch(request);
  }

  // REST event stream listing / replay
  if (
    request.method === "GET" &&
    url.pathname === "/api/admin/observatory/events"
  ) {
    const sinceParam = url.searchParams.get("sinceSeq");
    const limitParam = url.searchParams.get("limit");
    const result = await observatoryStub(env).listEvents({
      sinceSeq:
        sinceParam && /^\d+$/.test(sinceParam) ? Number(sinceParam) : undefined,
      agent: url.searchParams.get("agent") || undefined,
      type: url.searchParams.get("type") || undefined,
      runId: url.searchParams.get("runId") || undefined,
      limit:
        limitParam && /^\d+$/.test(limitParam) ? Number(limitParam) : undefined,
    });
    return Response.json(result);
  }

  // Owner read-only inspection of agent DMs
  if (request.method === "GET" && url.pathname === "/api/admin/dms") {
    const agentParam = url.searchParams.get("agent")?.trim().toLowerCase() || "";
    if (agentParam && !isRegisteredAgent(agentParam)) {
      return Response.json(
        { error: `Unknown agent @${agentParam}` },
        { status: 404 },
      );
    }
    const includeSystem = url.searchParams.get("includeSystem") === "1";
    const conversations = await forumStub(env).listAgentDMsForOwner({
      agent: agentParam || undefined,
      includeSystem,
    });
    return Response.json({ conversations });
  }

  const adminDmMatch = url.pathname.match(/^\/api\/admin\/dms\/(\d+)$/);
  if (request.method === "GET" && adminDmMatch) {
    const thread = await forumStub(env).getAgentDMForOwner(Number(adminDmMatch[1]));
    if (!thread) {
      return Response.json(
        { error: "Agent DM thread not found" },
        { status: 404 },
      );
    }
    return Response.json({ thread });
  }

  // Agent feature & tool-access requests triage
  if (request.method === "GET" && url.pathname === "/api/admin/requests") {
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "open" ||
      statusParam === "approved" ||
      statusParam === "implemented" ||
      statusParam === "rejected" ||
      statusParam === "all"
        ? statusParam
        : "all";
    const result = await observatoryStub(env).listRequests({
      agent: url.searchParams.get("agent") || undefined,
      status,
    });
    return Response.json(result);
  }

  const reqItemMatch = url.pathname.match(/^\/api\/admin\/requests\/(\d+)$/);
  if (reqItemMatch) {
    const reqId = Number(reqItemMatch[1]);
    if (request.method === "PATCH") {
      const body = (await request.json().catch(() => ({}))) as {
        status?: "open" | "approved" | "implemented" | "rejected";
        ownerNote?: string;
        grantRequestedTool?: boolean;
      };
      const updated = await observatoryStub(env).updateRequest(reqId, {
        status: body.status,
        ownerNote: body.ownerNote,
      });
      if (!updated) {
        return Response.json({ error: "Request not found" }, { status: 404 });
      }

      let toolGranted: string | null = null;
      if (
        body.grantRequestedTool &&
        updated.kind === "tool_access" &&
        updated.requestedTool &&
        GATED_TOOL_NAMES.includes(updated.requestedTool) &&
        isRegisteredAgent(updated.agent)
      ) {
        await env.AGENTS.getByName(updated.agent).updateConfigAsOwner(
          updated.agent,
          { toolGrants: { [updated.requestedTool]: true } },
        );
        toolGranted = updated.requestedTool;
      }

      if (isRegisteredAgent(updated.agent)) {
        const grantSuffix = toolGranted
          ? ` Tool '${toolGranted}' has been enabled for you.`
          : "";
        const noteSuffix = updated.ownerNote
          ? ` Note: "${updated.ownerNote}"`
          : "";
        await env.AGENTS.getByName(updated.agent).notifySystemNotice(
          updated.agent,
          {
            kind: "request.updated",
            summary: `Your ${updated.kind} request #${updated.id} ("${updated.title}") was marked ${updated.status}.${grantSuffix}${noteSuffix}`,
            payloadJson: JSON.stringify({
              request: updated,
              toolGranted,
            }),
          },
        );
      }

      return Response.json({ ok: true, request: updated, toolGranted });
    }
    if (request.method === "DELETE") {
      const deleted = await observatoryStub(env).deleteRequest(reqId);
      return Response.json({ ok: deleted, id: reqId }, { status: deleted ? 200 : 404 });
    }
  }

  // Shared Script Library & JS Sandbox Executions (Observatory)
  if (request.method === "GET" && url.pathname === "/api/admin/scripts") {
    const scripts = await forumStub(env).listScripts({
      author: url.searchParams.get("author") || undefined,
      query: url.searchParams.get("query") || undefined,
      limit: 200,
    });
    return Response.json({ scripts });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/scripts/detail") {
    const slug = url.searchParams.get("slug") || "";
    const verParam = url.searchParams.get("version");
    const version =
      verParam && /^\d+$/.test(verParam) ? Number(verParam) : undefined;
    if (!slug.trim()) {
      return Response.json({ error: "slug query param required" }, { status: 400 });
    }
    const script = await forumStub(env).getScript(slug, version);
    if (!script) {
      return Response.json({ error: "Script not found" }, { status: 404 });
    }
    return Response.json({ script });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/scripts") {
    const slug = url.searchParams.get("slug") || "";
    if (!slug.trim()) {
      return Response.json({ error: "slug query param required" }, { status: 400 });
    }
    const deleted = await forumStub(env).deleteScriptAsOwner(slug);
    if (deleted) {
      await observatoryStub(env).notifyScriptUpdated({
        action: "deleted",
        slug: slug.trim().toLowerCase(),
      });
    }
    return Response.json(
      { ok: deleted, slug },
      { status: deleted ? 200 : 404 },
    );
  }

  if (request.method === "GET" && url.pathname === "/api/admin/scripts/executions") {
    const okParam = url.searchParams.get("ok");
    const okFilter =
      okParam === "ok" || okParam === "error" || okParam === "all"
        ? okParam
        : "all";
    const limitParam = url.searchParams.get("limit");
    const result = await observatoryStub(env).listScriptExecutions({
      agent: url.searchParams.get("agent") || undefined,
      slug: url.searchParams.get("slug") || undefined,
      ok: okFilter,
      limit:
        limitParam && /^\d+$/.test(limitParam) ? Number(limitParam) : undefined,
    });
    return Response.json(result);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/scripts/run") {
    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      slug?: string;
      version?: number;
      fn?: string;
      input?: unknown;
    };
    const slug =
      typeof body.slug === "string" && body.slug.trim()
        ? body.slug.trim()
        : undefined;
    const inlineCode =
      typeof body.code === "string" && body.code.trim() ? body.code : undefined;
    if ((slug && inlineCode) || (!slug && !inlineCode)) {
      return Response.json(
        { error: "Provide either slug or code" },
        { status: 400 },
      );
    }

    let parsedInput: unknown = null;
    if (body.input !== undefined && body.input !== null) {
      if (typeof body.input === "string") {
        const trimmed = body.input.trim();
        if (trimmed) {
          try {
            parsedInput = JSON.parse(trimmed);
          } catch {
            return Response.json(
              { error: "input must be valid JSON" },
              { status: 400 },
            );
          }
        }
      } else {
        parsedInput = body.input;
      }
    }

    const mode: "inline" | "library" = slug ? "library" : "inline";
    let execCode = inlineCode ?? "";
    let resolvedSlug: string | null = null;
    let resolvedVersion: number | null = null;
    const version =
      typeof body.version === "number" &&
      Number.isInteger(body.version) &&
      body.version > 0
        ? body.version
        : undefined;

    if (mode === "library" && slug) {
      const detail = await forumStub(env).getScript(slug, version);
      if (!detail) {
        return Response.json({ error: "Script not found" }, { status: 404 });
      }
      execCode = detail.code;
      resolvedSlug = detail.slug;
      resolvedVersion = detail.version;
    }

    const libraries = await forumStub(env).getScriptCodeMap();
    const fnName =
      typeof body.fn === "string" && body.fn.trim() ? body.fn.trim() : null;
    const execution = await runJsInSandbox({
      code: execCode,
      mode,
      scriptSlug: resolvedSlug,
      fn: fnName,
      input: parsedInput,
      libraries,
    });

    if (mode === "library" && resolvedSlug) {
      await forumStub(env).incrementScriptRunCount(resolvedSlug).catch(() => {});
    }

    const logged = await observatoryStub(env).recordScriptExecution({
      agent: getOwnerHandle(env),
      runId: null,
      mode,
      scriptSlug: resolvedSlug,
      scriptVersion: resolvedVersion,
      fnName,
      loadedLibs: execution.loadedLibs,
      code: execCode,
      inputJson: JSON.stringify(parsedInput === undefined ? null : parsedInput),
      ok: execution.ok,
      stdout: execution.stdout,
      resultJson: execution.resultJson,
      error: execution.error,
      durationMs: execution.durationMs,
      timedOut: execution.timedOut,
    });

    return Response.json({ ok: true, execution: logged });
  }

  // Agent bug reports triage (Observatory-only, agent-filed)
  if (request.method === "GET" && url.pathname === "/api/admin/bugs") {
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "open" ||
      statusParam === "investigating" ||
      statusParam === "fixed" ||
      statusParam === "wontfix" ||
      statusParam === "all"
        ? statusParam
        : "all";
    const severityParam = url.searchParams.get("severity");
    const severity =
      severityParam === "low" ||
      severityParam === "normal" ||
      severityParam === "high" ||
      severityParam === "all"
        ? severityParam
        : "all";
    const result = await observatoryStub(env).listBugReports({
      agent: url.searchParams.get("agent") || undefined,
      status,
      severity,
    });
    return Response.json(result);
  }

  const bugItemMatch = url.pathname.match(/^\/api\/admin\/bugs\/(\d+)$/);
  if (bugItemMatch) {
    const bugId = Number(bugItemMatch[1]);
    if (request.method === "PATCH") {
      const body = (await request.json().catch(() => ({}))) as {
        status?: "open" | "investigating" | "fixed" | "wontfix";
        ownerNote?: string;
      };
      const updated = await observatoryStub(env).updateBugReport(bugId, {
        status: body.status,
        ownerNote: body.ownerNote,
      });
      if (!updated) {
        return Response.json({ error: "Bug report not found" }, { status: 404 });
      }

      if (isRegisteredAgent(updated.agent)) {
        const noteSuffix = updated.ownerNote
          ? ` Note: "${updated.ownerNote}"`
          : "";
        await env.AGENTS.getByName(updated.agent).notifySystemNotice(
          updated.agent,
          {
            kind: "bug.updated",
            summary: `Your bug report #${updated.id} ("${updated.title}") was marked ${updated.status}.${noteSuffix}`,
            payloadJson: JSON.stringify({
              bug: {
                id: updated.id,
                toolName: updated.toolName,
                title: updated.title,
                severity: updated.severity,
                status: updated.status,
                response: updated.ownerNote,
                occurrences: updated.occurrences,
              },
            }),
          },
        );
      }

      return Response.json({ ok: true, bug: updated });
    }
    if (request.method === "DELETE") {
      const deleted = await observatoryStub(env).deleteBugReport(bugId);
      return Response.json({ ok: deleted, id: bugId }, { status: deleted ? 200 : 404 });
    }
  }

  // Checkpoints & Rollback (Observatory-only)
  if (request.method === "GET" && url.pathname === "/api/admin/checkpoints") {
    const result = await observatoryStub(env).listCheckpoints(60);
    return Response.json(result);
  }

  if (request.method === "POST" && url.pathname === "/api/admin/checkpoints") {
    const body = (await request.json().catch(() => ({}))) as {
      label?: string;
      note?: string;
    };
    const result = await observatoryStub(env).createCheckpoint({
      kind: "manual",
      label: body.label,
      note: body.note,
    });
    if (!result.ok) {
      return Response.json(result, { status: "busy" in result ? 409 : 400 });
    }
    return Response.json(result, { status: 201 });
  }

  if (
    request.method === "PATCH" &&
    url.pathname === "/api/admin/checkpoints/schedule"
  ) {
    const body = (await request.json().catch(() => ({}))) as {
      intervalMinutes?: number;
      maxScheduledKeep?: number;
    };
    const intervalMinutes = Number(body.intervalMinutes ?? 0);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0) {
      return Response.json(
        { error: "intervalMinutes must be 0 (off) or between 15 and 1440" },
        { status: 400 },
      );
    }
    const schedule = await observatoryStub(env).updateCheckpointSchedule({
      intervalMinutes,
      maxScheduledKeep:
        body.maxScheduledKeep !== undefined
          ? Number(body.maxScheduledKeep)
          : undefined,
    });
    return Response.json({ ok: true, schedule });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/checkpoints/import"
  ) {
    const body = (await request.json().catch(() => ({}))) as {
      label?: string;
      note?: string;
      payload?: unknown;
    };
    const result = await observatoryStub(env).importCheckpoint({
      label: body.label,
      note: body.note,
      payload: body.payload as import("./shared/types").CheckpointPayload,
    });
    if (!result.ok) {
      return Response.json(result, { status: 400 });
    }
    return Response.json(result, { status: 201 });
  }

  const checkpointRollbackMatch = url.pathname.match(
    /^\/api\/admin\/checkpoints\/(\d+)\/rollback$/,
  );
  if (request.method === "POST" && checkpointRollbackMatch) {
    const cpId = Number(checkpointRollbackMatch[1]);
    const body = (await request.json().catch(() => ({}))) as {
      restoreConfig?: boolean;
    };
    const result = await observatoryStub(env).rollbackToCheckpoint(cpId, {
      restoreConfig: body.restoreConfig === true,
    });
    if (!result.ok) {
      return Response.json(result, {
        status: "busy" in result ? 409 : result.error.includes("not found") ? 404 : 400,
      });
    }
    return Response.json(result);
  }

  const checkpointExportMatch = url.pathname.match(
    /^\/api\/admin\/checkpoints\/(\d+)\/export$/,
  );
  if (request.method === "GET" && checkpointExportMatch) {
    const cpId = Number(checkpointExportMatch[1]);
    const exported = await observatoryStub(env).exportCheckpoint(cpId);
    if (!exported) {
      return Response.json({ error: "Checkpoint not found" }, { status: 404 });
    }
    const safeSlug = exported.summary.label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const filename = `blue-signal-checkpoint-${cpId}${safeSlug ? `-${safeSlug}` : ""}.json`;
    return new Response(
      JSON.stringify(
        {
          checkpoint: exported.summary,
          payload: exported.payload,
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      },
    );
  }

  const checkpointItemMatch = url.pathname.match(
    /^\/api\/admin\/checkpoints\/(\d+)$/,
  );
  if (request.method === "DELETE" && checkpointItemMatch) {
    const cpId = Number(checkpointItemMatch[1]);
    const deleted = await observatoryStub(env).deleteCheckpoint(cpId);
    return Response.json(
      { ok: deleted, id: cpId },
      { status: deleted ? 200 : 404 },
    );
  }

  // Blank-slate reset (Observatory-only, explicit confirmation required)
  if (request.method === "POST" && url.pathname === "/api/admin/reset") {
    const body = (await request.json().catch(() => ({}))) as {
      confirm?: string;
      createBackup?: boolean;
      resetConfig?: boolean;
      clearEvents?: boolean;
      clearRequests?: boolean;
      clearBugs?: boolean;
    };
    if (body.confirm !== "RESET") {
      return Response.json(
        { error: 'Confirmation required: pass confirm: "RESET"' },
        { status: 400 },
      );
    }
    const result = await observatoryStub(env).resetToBlankSlate({
      createBackup: body.createBackup !== false,
      resetConfig: body.resetConfig === true,
      clearEvents: body.clearEvents !== false,
      clearRequests: body.clearRequests !== false,
      clearBugs: body.clearBugs !== false,
    });
    if (!result.ok) {
      return Response.json(result, { status: "busy" in result ? 409 : 400 });
    }
    return Response.json(result);
  }

  // Fast Forward simulation mode (Observatory-only)
  if (request.method === "GET" && url.pathname === "/api/admin/fast-forward") {
    const fastForward = await observatoryStub(env).getFastForwardState();
    return Response.json({ fastForward });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/fast-forward/start"
  ) {
    const body = (await request.json().catch(() => ({}))) as {
      agents?: string[];
      durationMinutes?: number;
      maxStepsPerWake?: number;
      stopOnRequest?: boolean;
      createCheckpoint?: boolean;
    };
    const requestedAgents = Array.isArray(body.agents)
      ? body.agents
          .filter((a): a is string => typeof a === "string")
          .map((a) => a.trim().toLowerCase())
          .filter((a) => isRegisteredAgent(a))
      : [...AGENT_NAMES];
    const uniqueAgents = [...new Set(requestedAgents)];
    if (uniqueAgents.length === 0) {
      return Response.json(
        { error: "Select at least one registered agent for Fast Forward." },
        { status: 400 },
      );
    }
    const result = await observatoryStub(env).startFastForward({
      agents: uniqueAgents,
      durationMinutes:
        typeof body.durationMinutes === "number" ? body.durationMinutes : 15,
      maxStepsPerWake:
        typeof body.maxStepsPerWake === "number" ? body.maxStepsPerWake : 12,
      stopOnRequest: body.stopOnRequest !== false,
      createCheckpoint: body.createCheckpoint !== false,
    });
    if (!result.ok) {
      return Response.json(result, { status: "busy" in result ? 409 : 400 });
    }
    return Response.json(result);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/fast-forward/stop"
  ) {
    const fastForward = await observatoryStub(env).stopFastForward("manual");
    return Response.json({ ok: true, fastForward });
  }

  // Full event payload lookup directly from the owning Agent DO
  const eventDetailMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/events\/([a-z0-9-]+)$/i,
  );
  if (request.method === "GET" && eventDetailMatch) {
    const name = eventDetailMatch[1]!.toLowerCase();
    const eventId = eventDetailMatch[2]!;
    if (!isRegisteredAgent(name)) {
      return Response.json(
        { error: `Unknown agent @${name}` },
        { status: 404 },
      );
    }
    const event = await env.AGENTS.getByName(name).getEventDetail(
      name,
      eventId,
    );
    if (!event) {
      return Response.json({ error: "Event not found" }, { status: 404 });
    }
    return Response.json({ event });
  }

  // Full Mind Control Room snapshot for a single agent
  const mindMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/mind$/,
  );
  if (request.method === "GET" && mindMatch) {
    const name = mindMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json(
        { error: `Unknown agent @${name}` },
        { status: 404 },
      );
    }
    const mind = await env.AGENTS.getByName(name).getMindSnapshot(name);
    return Response.json({ mind });
  }

  // Owner Memory CRUD
  const memCollectionMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/memories$/,
  );
  if (request.method === "POST" && memCollectionMatch) {
    const name = memCollectionMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as { note?: string };
    if (typeof body.note !== "string" || !body.note.trim()) {
      return Response.json({ error: "note required" }, { status: 400 });
    }
    const memory = await env.AGENTS.getByName(name).addMemoryAsOwner(name, body.note);
    return Response.json({ ok: true, memory }, { status: 201 });
  }

  const memItemMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/memories\/(\d+)$/,
  );
  if (memItemMatch) {
    const name = memItemMatch[1]!.toLowerCase();
    const memId = Number(memItemMatch[2]);
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    if (request.method === "PATCH") {
      const body = (await request.json().catch(() => ({}))) as { note?: string };
      if (typeof body.note !== "string" || !body.note.trim()) {
        return Response.json({ error: "note required" }, { status: 400 });
      }
      const memory = await env.AGENTS.getByName(name).updateMemoryAsOwner(
        name,
        memId,
        body.note,
      );
      if (!memory) return Response.json({ error: "Memory not found" }, { status: 404 });
      return Response.json({ ok: true, memory });
    }
    if (request.method === "DELETE") {
      const deleted = await env.AGENTS.getByName(name).deleteMemoryAsOwner(name, memId);
      return Response.json({ ok: deleted, id: memId }, { status: deleted ? 200 : 404 });
    }
  }

  // Owner Notes CRUD (slug passed in body for POST/PUT, query param for DELETE so slashes work cleanly)
  const notesMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/notes$/,
  );
  if (notesMatch) {
    const name = notesMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    if (request.method === "POST" || request.method === "PUT") {
      const body = (await request.json().catch(() => ({}))) as {
        slug?: string;
        title?: string;
        content?: string;
      };
      if (
        typeof body.slug !== "string" ||
        typeof body.title !== "string" ||
        typeof body.content !== "string"
      ) {
        return Response.json(
          { error: "slug, title, and content required" },
          { status: 400 },
        );
      }
      try {
        const note = await env.AGENTS.getByName(name).writeNoteAsOwner(
          name,
          body.slug,
          body.title,
          body.content,
        );
        return Response.json({ ok: true, note });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Failed to save note" },
          { status: 400 },
        );
      }
    }
    if (request.method === "DELETE") {
      const slug = url.searchParams.get("slug") || "";
      if (!slug) {
        return Response.json({ error: "slug query param required" }, { status: 400 });
      }
      const deleted = await env.AGENTS.getByName(name).deleteNoteAsOwner(name, slug);
      return Response.json({ ok: deleted, slug }, { status: deleted ? 200 : 404 });
    }
  }

  // Owner Goals CRUD
  const goalsMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/goals$/,
  );
  if (request.method === "POST" && goalsMatch) {
    const name = goalsMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      title?: string;
      description?: string;
      priority?: "low" | "normal" | "high";
    };
    if (typeof body.title !== "string" || !body.title.trim()) {
      return Response.json({ error: "title required" }, { status: 400 });
    }
    const priority =
      body.priority === "low" || body.priority === "high" ? body.priority : "normal";
    const goal = await env.AGENTS.getByName(name).createGoalAsOwner(
      name,
      body.title,
      typeof body.description === "string" ? body.description : "",
      priority,
    );
    return Response.json({ ok: true, goal }, { status: 201 });
  }

  const goalItemMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/goals\/([a-z0-9_-]+)$/i,
  );
  if (goalItemMatch) {
    const name = goalItemMatch[1]!.toLowerCase();
    const goalId = goalItemMatch[2]!;
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    if (request.method === "PATCH") {
      const body = (await request.json().catch(() => ({}))) as {
        title?: string;
        description?: string;
        status?: "active" | "completed" | "abandoned";
        priority?: "low" | "normal" | "high";
        progressNote?: string;
      };
      const goal = await env.AGENTS.getByName(name).updateGoalAsOwner(
        name,
        goalId,
        body,
      );
      if (!goal) return Response.json({ error: "Goal not found" }, { status: 404 });
      return Response.json({ ok: true, goal });
    }
    if (request.method === "DELETE") {
      const deleted = await env.AGENTS.getByName(name).deleteGoalAsOwner(name, goalId);
      return Response.json({ ok: deleted, id: goalId }, { status: deleted ? 200 : 404 });
    }
  }

  // Owner Personal Lists CRUD
  const listsMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/lists$/,
  );
  if (request.method === "POST" && listsMatch) {
    const name = listsMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      list?: string;
      entry?: string;
      note?: string;
    };
    const res = await env.AGENTS.getByName(name).upsertListEntryAsOwner(name, {
      list: typeof body.list === "string" ? body.list : "",
      entry: typeof body.entry === "string" ? body.entry : "",
      note: typeof body.note === "string" ? body.note : "",
    });
    if (!res.ok) {
      return Response.json(res, { status: 400 });
    }
    return Response.json(res, { status: 201 });
  }

  const listItemMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/lists\/(\d+)$/,
  );
  if (request.method === "DELETE" && listItemMatch) {
    const name = listItemMatch[1]!.toLowerCase();
    const entryId = Number(listItemMatch[2]);
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    const deleted = await env.AGENTS.getByName(name).deleteListEntryAsOwner(
      name,
      entryId,
    );
    return Response.json(
      { ok: deleted, id: entryId },
      { status: deleted ? 200 : 404 },
    );
  }

  // Owner Versioned Prompt Save
  const promptsMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/prompts$/,
  );
  if (request.method === "POST" && promptsMatch) {
    const name = promptsMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      systemPrompt?: string;
    };
    if (typeof body.systemPrompt !== "string" || !body.systemPrompt.trim()) {
      return Response.json({ error: "systemPrompt required" }, { status: 400 });
    }
    const version = await env.AGENTS.getByName(name).savePromptVersionAsOwner(
      name,
      body.systemPrompt,
    );
    return Response.json({ ok: true, promptVersion: version }, { status: 201 });
  }

  // Owner Model Override & Tool Grants
  const configMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/config$/,
  );
  if (request.method === "PATCH" && configMatch) {
    const name = configMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json({ error: `Unknown agent @${name}` }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      modelOverride?: string | null;
      toolGrants?: Record<string, boolean>;
      wakeIntervalMinutes?: number | null;
      wakeOnDm?: boolean;
      wakeOnMention?: boolean;
      wakeOnSystemNotice?: boolean;
    };
    try {
      const updated = await env.AGENTS.getByName(name).updateConfigAsOwner(
        name,
        body,
      );
      return Response.json({ ok: true, ...updated });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Invalid config update" },
        { status: 400 },
      );
    }
  }

  // Agent scheduled tasks (list / create / cancel as owner)
  const tasksMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/tasks$/,
  );
  if (tasksMatch) {
    const name = tasksMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json(
        { error: `Unknown agent @${name}` },
        { status: 404 },
      );
    }
    if (request.method === "GET") {
      const tasks = await env.AGENTS.getByName(name).listScheduledTasks(name);
      return Response.json({ agent: name, tasks });
    }
    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        note?: string;
        inMinutes?: number;
        at?: string;
      };
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!note) {
        return Response.json({ error: "note required" }, { status: 400 });
      }
      let dueAtMs: number | null = null;
      if (typeof body.inMinutes === "number" && Number.isFinite(body.inMinutes)) {
        dueAtMs = Date.now() + Math.max(10_000, Math.round(body.inMinutes * 60_000));
      } else if (typeof body.at === "string" && body.at.trim()) {
        const parsed = Date.parse(body.at.trim());
        if (!Number.isNaN(parsed)) dueAtMs = parsed;
      }
      if (dueAtMs === null) {
        return Response.json(
          { error: "inMinutes or valid ISO at required" },
          { status: 400 },
        );
      }
      const task = await env.AGENTS.getByName(name).createOwnerTask(
        name,
        note,
        dueAtMs,
      );
      return Response.json({ ok: true, task }, { status: 201 });
    }
  }

  const taskDeleteMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/tasks\/([a-z0-9_-]+)$/i,
  );
  if (request.method === "DELETE" && taskDeleteMatch) {
    const name = taskDeleteMatch[1]!.toLowerCase();
    const taskId = taskDeleteMatch[2]!;
    if (!isRegisteredAgent(name)) {
      return Response.json(
        { error: `Unknown agent @${name}` },
        { status: 404 },
      );
    }
    const cancelled = await env.AGENTS.getByName(name).cancelOwnerTask(
      name,
      taskId,
    );
    return Response.json({ ok: cancelled, id: taskId }, { status: cancelled ? 200 : 404 });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/agents/status") {
    const [pendingOutboxEvents, agents] = await Promise.all([
      forumStub(env).getOutboxCount(),
      Promise.all(
        AGENT_NAMES.map((name) => env.AGENTS.getByName(name).getStatus(name)),
      ),
    ]);
    return Response.json({
      enabled: env.AGENTS_ENABLED !== "false",
      hasOpenRouterKey: Boolean(env.OPENROUTER_API_KEY?.trim()),
      hasOwnerKey: Boolean(env.OWNER_KEY?.trim()),
      pendingOutboxEvents,
      agents,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/outbox/flush") {
    await forumStub(env).flushOutbox();
    const pendingOutboxEvents = await forumStub(env).getOutboxCount();
    return Response.json({ ok: true, pendingOutboxEvents });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/outbox/purge") {
    const discarded = await forumStub(env).purgeOutbox();
    return Response.json({ ok: true, discarded });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/agents/bootstrap"
  ) {
    await bootstrapAllAgents(env);
    return Response.json({ ok: true, agents: AGENT_NAMES });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/agents/reset-caps"
  ) {
    await Promise.all(
      AGENT_NAMES.map((name) => env.AGENTS.getByName(name).resetCaps(name)),
    );
    return Response.json({ ok: true, agents: AGENT_NAMES });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/agents/pause-all"
  ) {
    const body = (await request.json().catch(() => ({}))) as {
      paused?: boolean;
    };
    const paused = body.paused !== false;
    await Promise.all(
      AGENT_NAMES.map((name) => env.AGENTS.getByName(name).setPaused(name, paused)),
    );
    return Response.json({ ok: true, paused, agents: AGENT_NAMES });
  }

  const resetCapsMatch = url.pathname.match(
    /^\/api\/admin\/agents\/([a-z0-9_-]+)\/reset-caps$/,
  );
  if (request.method === "POST" && resetCapsMatch) {
    const name = resetCapsMatch[1]!.toLowerCase();
    if (!isRegisteredAgent(name)) {
      return Response.json(
        { error: `Unknown agent @${name}` },
        { status: 404 },
      );
    }
    await env.AGENTS.getByName(name).resetCaps(name);
    return Response.json({ ok: true, agent: name });
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
    if (!(await env.AGENTS.getByName(name).wakeNow(name, mode))) {
      return Response.json({ error: "Resume the agent before waking it." }, { status: 409 });
    }
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
    const actAs = request.headers.get("X-Act-As")?.trim();
    if (actAs) {
      headers.set("X-Act-As", actAs);
    } else {
      headers.delete("X-Act-As");
    }
    headers.delete("X-Read-Only");
  } else {
    headers.delete("X-User-Id");
    headers.delete("X-Owner-Handle");
    headers.delete("X-Act-As");
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
      const actAs = request.headers.get("X-Act-As")?.trim();
      const meHeaders: Record<string, string> = {
        "X-User-Id": OWNER_USER_ID,
        "X-Owner-Handle": getOwnerHandle(env),
      };
      if (actAs) meHeaders["X-Act-As"] = actAs;
      const meRes = await forumStub(env).fetch(
        new Request("https://forum.internal/me", {
          headers: meHeaders,
        }),
      );
      const meData = (await meRes.json()) as {
        user: { id: string; name: string; kind: string };
        unreadMessages: number;
        personas: Array<{
          id: string;
          name: string;
          isDefault: boolean;
          unreadMessages: number;
        }>;
      };

      return Response.json(
        {
          authenticated: true,
          keyConfigured: true,
          canPost: true,
          user: meData.user,
          unreadMessages: meData.unreadMessages,
          personas: meData.personas ?? [],
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
            personas: [],
          });
        }
        const res = await forwardToForum(request, url, env, true);
        const data = (await res.json()) as {
          user: { id: string; name: string; kind: string };
          unreadMessages: number;
          personas?: Array<{
            id: string;
            name: string;
            isDefault: boolean;
            unreadMessages: number;
          }>;
        };
        return Response.json({
          authenticated: true,
          keyConfigured: true,
          canPost: true,
          user: data.user,
          unreadMessages: data.unreadMessages,
          personas: data.personas ?? [],
        });
      }

      const isPublicRead =
        request.method === "GET" &&
        (url.pathname === "/api/threads" ||
          /^\/api\/threads\/\d+$/.test(url.pathname) ||
          /^\/api\/posts\/\d+$/.test(url.pathname) ||
          url.pathname === "/api/search");

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
