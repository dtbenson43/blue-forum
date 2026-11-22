export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchStatus = "ok" | "summary_only" | "no_results";

export type WebSearchOutput = {
  provider: "brave" | "tavily" | "openrouter";
  query: string;
  status: WebSearchStatus;
  summary?: string;
  results: WebSearchResultItem[];
  untrustedBlock: string;
};

export type WebReadOutput = {
  url: string;
  finalUrl: string;
  title: string;
  contentType: string;
  truncated: boolean;
  untrustedBlock: string;
};

const MAX_READ_BYTES = 256 * 1024; // 256 KB raw download cap
const MAX_TEXT_CHARS = 6_000;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
];

function isPrivateOrBlockedIp(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, "").toLowerCase();

  // Block IPv6 loopback, link-local, unique-local, IPv4-mapped
  if (clean.includes(":")) {
    if (
      clean === "::1" ||
      clean === "::" ||
      clean.startsWith("fe80:") ||
      clean.startsWith("fc") ||
      clean.startsWith("fd") ||
      clean.startsWith("::ffff:")
    ) {
      return true;
    }
    return false;
  }

  // Block bare decimal/hex integer IP obfuscation (e.g. 2130706433 or 0x7f000001)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(clean)) {
    return true;
  }

  const ipv4 = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;

  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export function validateSafePublicUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid URL format.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Only https:// URLs are permitted.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not permitted.");
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa") ||
    !host.includes(".") ||
    isPrivateOrBlockedIp(host)
  ) {
    throw new Error("Target host is not a public internet address.");
  }

  return parsed;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 31 && code < 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    });
}

function extractReadableText(
  raw: string,
  contentType: string,
): { title: string; text: string } {
  if (!contentType.includes("html")) {
    return { title: "", text: raw.trim() };
  }

  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1]!.replace(/\s+/g, " ").trim()).slice(0, 160)
    : "";

  const stripped = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|section|article|main|h[1-6]|li|tr|br|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const decoded = decodeHtmlEntities(stripped)
    .replace(/[ \t\r]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text: decoded };
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; capped: boolean }> {
  if (!response.body) return { text: "", capped: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        capped = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder("utf-8").decode(merged), capped };
}

/**
 * Hardened public HTTPS page reader with SSRF protection, manual redirect validation,
 * byte/time caps, and untrusted-data XML delimiters.
 */
export async function readWebPage(rawUrl: string): Promise<WebReadOutput> {
  let currentUrl = validateSafePublicUrl(rawUrl);
  let response: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(currentUrl.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": "BlueSignalAgent/1.0 (+https://blue-forum.local)",
        Accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (!loc) {
        throw new Error(`Redirect (${res.status}) missing Location header.`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
      }
      currentUrl = validateSafePublicUrl(new URL(loc, currentUrl).toString());
      continue;
    }

    response = res;
    break;
  }

  if (!response) {
    throw new Error("Failed to fetch URL.");
  }

  if (!response.ok) {
    throw new Error(`Upstream returned HTTP ${response.status}.`);
  }

  const rawContentType = (response.headers.get("Content-Type") || "text/plain")
    .split(";")[0]!
    .trim()
    .toLowerCase();

  if (!ALLOWED_CONTENT_TYPES.some((allowed) => rawContentType === allowed)) {
    throw new Error(`Unsupported Content-Type: ${rawContentType}`);
  }

  const { text: rawBody, capped } = await readBodyCapped(response, MAX_READ_BYTES);
  const { title, text } = extractReadableText(rawBody, rawContentType);
  const truncated = capped || text.length > MAX_TEXT_CHARS;
  const snippet = text.slice(0, MAX_TEXT_CHARS);

  const safeUrl = currentUrl.toString().replaceAll('"', "&quot;");
  const safeTitle = title.replaceAll('"', "&quot;");
  const untrustedBlock = [
    `<untrusted_web_page url="${safeUrl}"${safeTitle ? ` title="${safeTitle}"` : ""}>`,
    snippet || "(no readable text extracted)",
    truncated ? "\n[truncated]" : "",
    `</untrusted_web_page>`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url: rawUrl,
    finalUrl: currentUrl.toString(),
    title,
    contentType: rawContentType,
    truncated,
    untrustedBlock,
  };
}

function looksLikeNoResultsSummary(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (/^no_matching_results\b/.test(normalized)) return true;
  if (normalized.includes("no_matching_results")) return true;
  // If the retriever cited real URLs inline without the sentinel, it found sources.
  if (/https?:\/\/[^\s)<>]+/.test(normalized)) return false;
  if (normalized.length > 420) return false;
  return /\b(no (matching |relevant )?(web |search )?results|could not find|couldn't find|unable to find|no relevant (information|results|sources)|none of the (attached |returned |provided )?(web |search )?results|do not match|doesn't match|nothing found|search returned (no|zero|0) results)\b/.test(
    normalized,
  );
}

function classifySearchStatus(
  results: WebSearchResultItem[],
  summary?: string,
): WebSearchStatus {
  if (summary && looksLikeNoResultsSummary(summary)) return "no_results";
  if (results.length > 0) return "ok";
  if (summary && summary.trim().length > 0) return "summary_only";
  return "no_results";
}

function formatUntrustedSearchBlock(
  query: string,
  results: WebSearchResultItem[],
  status: WebSearchStatus,
  summary?: string,
): string {
  const safeQuery = query.replaceAll('"', "&quot;");
  const lines = [`<untrusted_web_results query="${safeQuery}" status="${status}">`];
  if (summary && status !== "no_results") {
    lines.push(`Summary: ${summary.slice(0, 1200)}`, "");
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. ${r.title || r.url}`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) lines.push(`   Snippet: ${r.snippet.slice(0, 400)}`);
  }
  if (status === "no_results") {
    lines.push("(no matching web results found for this query)");
  }
  lines.push("</untrusted_web_results>");
  return lines.join("\n");
}

function sanitizePublicResultUrl(raw: string): string | null {
  const cleaned = raw.trim().replace(/[),.;:!?]+$/, "");
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host || !host.includes(".") || isPrivateOrBlockedIp(host)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractInlineUrlsFromMarkdown(
  text: string,
  seenUrls: Set<string>,
  maxTotal: number,
): WebSearchResultItem[] {
  const extra: WebSearchResultItem[] = [];
  if (!text) return extra;

  // 1. Markdown links: [Title](https://...)
  const mdLinkRe = /\[([^\]\n]{1,180})\]\((https?:\/\/[^\s)<>]+)\)/g;
  for (const match of text.matchAll(mdLinkRe)) {
    if (seenUrls.size >= maxTotal) break;
    const rawTitle = (match[1] || "").trim();
    const validUrl = sanitizePublicResultUrl(match[2] || "");
    if (!validUrl || seenUrls.has(validUrl)) continue;
    seenUrls.add(validUrl);
    extra.push({
      title: rawTitle.slice(0, 180) || validUrl,
      url: validUrl,
      snippet: "",
    });
  }

  // 2. Bare https:// URLs if still short of results
  if (seenUrls.size < maxTotal) {
    const bareUrlRe = /\bhttps?:\/\/[^\s<>()[\]"']+/g;
    for (const match of text.matchAll(bareUrlRe)) {
      if (seenUrls.size >= maxTotal) break;
      const validUrl = sanitizePublicResultUrl(match[0] || "");
      if (!validUrl || seenUrls.has(validUrl)) continue;
      seenUrls.add(validUrl);
      extra.push({
        title: validUrl,
        url: validUrl,
        snippet: "",
      });
    }
  }

  return extra;
}

async function searchViaBrave(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<WebSearchOutput> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Brave Search HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string }>;
    };
  };

  const results: WebSearchResultItem[] = (data.web?.results || [])
    .slice(0, maxResults)
    .filter((r) => Boolean(r.url))
    .map((r) => ({
      title: (r.title || "").trim().slice(0, 180),
      url: r.url!,
      snippet: decodeHtmlEntities((r.description || "").replace(/<[^>]+>/g, "")).slice(0, 400),
    }));

  const status = classifySearchStatus(results);
  return {
    provider: "brave",
    query,
    status,
    results,
    untrustedBlock: formatUntrustedSearchBlock(query, results, status),
  };
}

async function searchViaTavily(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<WebSearchOutput> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Tavily Search HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  const results: WebSearchResultItem[] = (data.results || [])
    .slice(0, maxResults)
    .filter((r) => Boolean(r.url))
    .map((r) => ({
      title: (r.title || "").trim().slice(0, 180),
      url: r.url!,
      snippet: (r.content || "").trim().slice(0, 400),
    }));

  const status = classifySearchStatus(results);
  return {
    provider: "tavily",
    query,
    status,
    results,
    untrustedBlock: formatUntrustedSearchBlock(query, results, status),
  };
}

type OpenRouterSearchPayload = {
  choices?: Array<{
    message?: {
      content?: string | null;
      annotations?: Array<{
        type?: string;
        url_citation?: {
          url?: string;
          title?: string;
          content?: string;
        };
        url?: string;
        title?: string;
        content?: string;
      }>;
    };
  }>;
};

async function runOpenRouterSearchRequest(params: {
  query: string;
  maxResults: number;
  apiKey: string;
  searchModel: string;
  siteUrl?: string;
  mode: "server_tool" | "web_plugin";
}): Promise<{ summary: string; results: WebSearchResultItem[] }> {
  const { query, maxResults, apiKey, searchModel, siteUrl, mode } = params;
  const body: Record<string, unknown> = {
    model: searchModel,
    temperature: 0.1,
    max_tokens: 900,
    messages: [
      {
        role: "system",
        content:
          mode === "server_tool"
            ? `You are a neutral web search retriever. Always invoke web search for the user's query — never answer solely from memory. Return up to ${maxResults} concise factual findings with explicit markdown source links [Title](https://...). Do not wrap the query in exact-phrase quotes unless the user included them. If the search returns no relevant results matching the query, respond with ONLY the exact token: NO_MATCHING_RESULTS`
            : `You are a neutral web search retriever. Summarize up to ${maxResults} distinct, relevant factual findings from the attached web search results with explicit markdown source links [Title](https://...). If none of the attached search results are actually relevant to the query, do NOT list unrelated URLs — respond with ONLY the exact token: NO_MATCHING_RESULTS`,
      },
      {
        role: "user",
        content: query,
      },
    ],
  };

  if (mode === "server_tool") {
    body.tools = [
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "auto",
          max_results: maxResults,
          max_total_results: maxResults,
          max_uses: 1,
        },
      },
    ];
  } else {
    body.plugins = [
      {
        id: "web",
        engine: "exa",
        max_results: maxResults,
      },
    ];
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": siteUrl || "https://blue-forum.local",
      "X-Title": "BLUE//SIGNAL",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter web search (${mode}) HTTP ${res.status}: ${errText.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as OpenRouterSearchPayload;
  const msg = data.choices?.[0]?.message;
  const summary = (msg?.content || "").trim().slice(0, 1200);
  const seenUrls = new Set<string>();
  const results: WebSearchResultItem[] = [];

  for (const ann of msg?.annotations || []) {
    const cite = ann.url_citation ?? (ann.url ? ann : undefined);
    const validUrl = cite?.url ? sanitizePublicResultUrl(cite.url) : null;
    if (!validUrl || seenUrls.has(validUrl)) continue;
    seenUrls.add(validUrl);
    results.push({
      title: (cite?.title || validUrl).trim().slice(0, 180),
      url: validUrl,
      snippet: (cite?.content || "").trim().slice(0, 400),
    });
    if (results.length >= maxResults) break;
  }

  if (results.length < maxResults && summary) {
    const inline = extractInlineUrlsFromMarkdown(summary, seenUrls, maxResults);
    results.push(...inline);
  }

  return { summary, results: results.slice(0, maxResults) };
}

async function searchViaOpenRouter(
  query: string,
  maxResults: number,
  apiKey: string,
  searchModel: string,
  siteUrl?: string,
): Promise<WebSearchOutput> {
  // Primary: deterministic web plugin (Exa) — always executes search before synthesis
  // so the helper model cannot skip searching or answer solely from memory.
  // Fallback: OpenRouter server tool (engine: "auto" / native search) if primary
  // fails or returns no matching results, providing a second search index.
  let bestSummary = "";
  let bestResults: WebSearchResultItem[] = [];
  let bestStatus: WebSearchStatus = "no_results";
  let primaryError: Error | null = null;

  try {
    const pluginRes = await runOpenRouterSearchRequest({
      query,
      maxResults,
      apiKey,
      searchModel,
      siteUrl,
      mode: "web_plugin",
    });
    bestSummary = pluginRes.summary;
    bestResults = pluginRes.results;
    bestStatus = classifySearchStatus(bestResults, bestSummary);
  } catch (err) {
    primaryError = err instanceof Error ? err : new Error(String(err));
  }

  if (bestStatus !== "ok") {
    try {
      const toolRes = await runOpenRouterSearchRequest({
        query,
        maxResults,
        apiKey,
        searchModel,
        siteUrl,
        mode: "server_tool",
      });
      const toolStatus = classifySearchStatus(toolRes.results, toolRes.summary);
      if (
        toolStatus === "ok" ||
        (bestStatus === "no_results" && toolStatus === "summary_only")
      ) {
        bestResults = toolRes.results;
        bestSummary = toolRes.summary || bestSummary;
        bestStatus = toolStatus;
      }
    } catch (fallbackErr) {
      if (primaryError && bestStatus === "no_results") {
        throw fallbackErr;
      }
    }
  }

  const finalResults = bestStatus === "no_results" ? [] : bestResults;
  return {
    provider: "openrouter",
    query,
    status: bestStatus,
    summary: bestStatus !== "no_results" && bestSummary ? bestSummary : undefined,
    results: finalResults,
    untrustedBlock: formatUntrustedSearchBlock(
      query,
      finalResults,
      bestStatus,
      bestSummary || undefined,
    ),
  };
}

/**
 * Search the public web using Brave (if BRAVE_SEARCH_API_KEY set),
 * Tavily (if TAVILY_API_KEY set), or OpenRouter's built-in openrouter:web_search tool.
 */
export async function searchWeb(params: {
  query: string;
  maxResults: number;
  env: {
    OPENROUTER_API_KEY?: string;
    OPENROUTER_SEARCH_MODEL?: string;
    BRAVE_SEARCH_API_KEY?: string;
    TAVILY_API_KEY?: string;
    SITE_URL?: string;
  };
}): Promise<WebSearchOutput> {
  const query = params.query.trim().slice(0, 200);
  if (!query) throw new Error("Search query is required.");
  const maxResults = Math.max(1, Math.min(params.maxResults, 8));

  const braveKey = params.env.BRAVE_SEARCH_API_KEY?.trim();
  if (braveKey) {
    return searchViaBrave(query, maxResults, braveKey);
  }

  const tavilyKey = params.env.TAVILY_API_KEY?.trim();
  if (tavilyKey) {
    return searchViaTavily(query, maxResults, tavilyKey);
  }

  const orKey = params.env.OPENROUTER_API_KEY?.trim();
  if (orKey) {
    const searchModel =
      params.env.OPENROUTER_SEARCH_MODEL?.trim() || "anthropic/claude-haiku-5.5";
    return searchViaOpenRouter(
      query,
      maxResults,
      orKey,
      searchModel,
      params.env.SITE_URL,
    );
  }

  throw new Error(
    "No search API key configured (set OPENROUTER_API_KEY, BRAVE_SEARCH_API_KEY, or TAVILY_API_KEY).",
  );
}
