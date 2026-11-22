export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchOutput = {
  provider: "brave" | "tavily" | "openrouter";
  query: string;
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

function formatUntrustedSearchBlock(
  query: string,
  results: WebSearchResultItem[],
  summary?: string,
): string {
  const safeQuery = query.replaceAll('"', "&quot;");
  const lines = [`<untrusted_web_results query="${safeQuery}">`];
  if (summary) {
    lines.push(`Summary: ${summary.slice(0, 1200)}`, "");
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. ${r.title || r.url}`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) lines.push(`   Snippet: ${r.snippet.slice(0, 400)}`);
  }
  if (results.length === 0 && !summary) {
    lines.push("(no results returned)");
  }
  lines.push("</untrusted_web_results>");
  return lines.join("\n");
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

  return {
    provider: "brave",
    query,
    results,
    untrustedBlock: formatUntrustedSearchBlock(query, results),
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

  return {
    provider: "tavily",
    query,
    results,
    untrustedBlock: formatUntrustedSearchBlock(query, results),
  };
}

async function searchViaOpenRouter(
  query: string,
  maxResults: number,
  apiKey: string,
  searchModel: string,
  siteUrl?: string,
): Promise<WebSearchOutput> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": siteUrl || "https://blue-forum.local",
      "X-Title": "BLUE//SIGNAL",
    },
    body: JSON.stringify({
      model: searchModel,
      temperature: 0.1,
      max_tokens: 700,
      tools: [{ type: "openrouter:web_search" }],
      messages: [
        {
          role: "system",
          content:
            "You are a neutral web search retriever. Use web search for the user's query and summarize up to the requested number of key factual findings with citations. Be concise and objective.",
        },
        {
          role: "user",
          content: `Search the web for: "${query}" (return up to ${maxResults} concise findings with sources).`,
        },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter web search HTTP ${res.status}: ${errText.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as {
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
        }>;
      };
    }>;
  };

  const msg = data.choices?.[0]?.message;
  const summary = (msg?.content || "").trim().slice(0, 1200);
  const seenUrls = new Set<string>();
  const results: WebSearchResultItem[] = [];

  for (const ann of msg?.annotations || []) {
    const cite = ann.url_citation;
    if (!cite?.url || seenUrls.has(cite.url)) continue;
    seenUrls.add(cite.url);
    results.push({
      title: (cite.title || cite.url).trim().slice(0, 180),
      url: cite.url,
      snippet: (cite.content || "").trim().slice(0, 400),
    });
    if (results.length >= maxResults) break;
  }

  return {
    provider: "openrouter",
    query,
    summary: summary || undefined,
    results,
    untrustedBlock: formatUntrustedSearchBlock(query, results, summary),
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
