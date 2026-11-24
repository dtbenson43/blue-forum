import { getDocumentProxy, getMeta, getResolvedPDFJS } from "unpdf";

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

export type PdfPageStatus =
  | "text"
  | "matched"
  | "no_match"
  | "image_only"
  | "blank";

export type PdfPageSummary = {
  page: number;
  status: PdfPageStatus;
  charCount: number;
  imageCount?: number;
  matchType?: "exact_phrase" | "all_words";
  truncated?: boolean;
};

export type PdfReadMetadata = {
  totalPages: number;
  inspectedPages: number[];
  returnedPages: number[];
  imageOnlyPages: number[];
  blankPages: number[];
  noMatchPages: number[];
  matchedPages?: number[];
  query?: string;
  hasMorePages: boolean;
  nextPage?: number;
  pages: PdfPageSummary[];
};

export type CsvRowEntry = {
  rowNumber: number;
  cells: string[];
};

export type CsvReadMetadata = {
  delimiter: "," | "\t";
  headers: string[];
  columnCount: number;
  totalDataRows: number;
  matchedRows: number;
  rowOffset: number;
  returnedRowCount: number;
  hasMoreRows: boolean;
  nextRowOffset?: number;
  fileByteCapped: boolean;
  filter?: {
    column?: string;
    columnIndex?: number;
    value?: string;
    query?: string;
  };
  rows: CsvRowEntry[];
};

export type DiscoverResolvedSource =
  | "wikipedia"
  | "on_this_day"
  | "arxiv"
  | "hackernews";

export type DiscoverSource = "any" | DiscoverResolvedSource;

export type DiscoverRandomOutput = {
  source: DiscoverResolvedSource;
  title: string;
  url: string;
  summary: string;
  meta?: Record<string, string | number>;
  untrustedBlock: string;
};

export type TextQueryPassage = {
  startChar: number;
  endChar: number;
  matchType: "exact_phrase" | "all_words";
};

export type TextReadMetadata = {
  totalChars: number;
  charOffset: number;
  returnedChars: number;
  hasMoreChars: boolean;
  nextCharOffset?: number;
  fileByteCapped: boolean;
  query?: string;
  matchMode?: "exact_phrase" | "all_words" | "none";
  totalMatches?: number;
  passages?: TextQueryPassage[];
};

export type ZipMemberInfo = {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionMethod: number;
  readableAsCsv: boolean;
  nestedArchive: boolean;
  encrypted: boolean;
  exceedsInflatedCap: boolean;
};

export type ZipReadMetadata = {
  compressedArchiveBytes: number;
  totalMembers: number;
  listedMembers: number;
  membersTruncated: boolean;
  selectedMember?: string;
  selectedMemberCompressedBytes?: number;
  selectedMemberUncompressedBytes?: number;
  inflatedByteCapped?: boolean;
  members: ZipMemberInfo[];
};

export type WebReadOptions = {
  pages?: string;
  query?: string;
  charOffset?: number;
  zipMember?: string;
  rowOffset?: number;
  maxRows?: number;
  filterColumn?: string;
  filterValue?: string;
};

export type WebReadOutput = {
  url: string;
  finalUrl: string;
  title: string;
  contentType: string;
  truncated: boolean;
  untrustedBlock: string;
  text?: TextReadMetadata;
  pdf?: PdfReadMetadata;
  csv?: CsvReadMetadata;
  zip?: ZipReadMetadata;
  pdfLinks?: Array<{ title: string; url: string }>;
  csvLinks?: Array<{ title: string; url: string }>;
  zipLinks?: Array<{ title: string; url: string }>;
};

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB cap for HTML/text/JSON
const MAX_CSV_READ_BYTES = 4 * 1024 * 1024; // 4 MB cap for public CSV/TSV
const MAX_PDF_READ_BYTES = 8 * 1024 * 1024; // 8 MB cap for public PDFs
const MAX_ZIP_READ_BYTES = 8 * 1024 * 1024; // 8 MB compressed cap for public ZIP archives
const MAX_ZIP_INFLATED_BYTES = MAX_CSV_READ_BYTES; // 4 MB streaming inflated cap per CSV/TSV member
const MAX_ZIP_DECLARED_MEMBER_BYTES = 64 * 1024 * 1024; // Reject huge >64 MB declared members upfront
const MAX_ZIP_MEMBERS_LISTED = 200;
const MAX_TEXT_CHARS = 6_000;
const MAX_TEXT_QUERY_CHARS = 7_500;
const TEXT_QUERY_CONTEXT_BEFORE = 320;
const TEXT_QUERY_CONTEXT_AFTER = 680;
const TEXT_QUERY_MERGE_GAP = 120;
const MAX_PDF_TEXT_CHARS = 8_000;
const MAX_CSV_TEXT_CHARS = 8_000;
const DEFAULT_CSV_ROWS_PER_CALL = 40;
const MAX_CSV_ROWS_PER_CALL = 100;
const MAX_PDF_EXPLICIT_PAGES = 20;
const MAX_PDF_DEFAULT_PAGES = 12;
const MAX_PDF_QUERY_SCAN_PAGES = 40;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 12_000;
const PDF_FETCH_TIMEOUT_MS = 20_000;

const ALLOWED_ZIP_CONTENT_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "multipart/x-zip",
];

const ALLOWED_CSV_CONTENT_TYPES = [
  "text/csv",
  "application/csv",
  "text/x-csv",
  "text/tab-separated-values",
];

const ALLOWED_TEXT_CONTENT_TYPES = [
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
    .replaceAll("&mdash;", "—")
    .replaceAll("&ndash;", "–")
    .replaceAll("&rsquo;", "'")
    .replaceAll("&lsquo;", "'")
    .replaceAll("&rdquo;", '"')
    .replaceAll("&ldquo;", '"')
    .replaceAll("&hellip;", "...")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 31 && code < 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 31 && code < 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    });
}

export function extractReadableText(
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

  const COL_SEP_MARKER = "\uE000";
  const stripped = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, COL_SEP_MARKER)
    .replace(
      /<\/?(p|div|section|article|main|header|footer|aside|nav|figure|figcaption|h[1-6]|li|tr|table|thead|tbody|tfoot|caption|dt|dd|br|blockquote|pre)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");

  const decoded = decodeHtmlEntities(stripped)
    .replace(/[ \t\r]+/g, " ")
    .replaceAll(COL_SEP_MARKER, "  |  ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text: decoded };
}

function snapStartToBoundary(text: string, rawStart: number, minStart: number): number {
  if (rawStart <= minStart) return minStart;
  const lookback = Math.max(minStart, rawStart - 40);
  const nl = text.lastIndexOf("\n", rawStart);
  if (nl >= lookback) return nl + 1;
  const sp = text.lastIndexOf(" ", rawStart);
  if (sp >= lookback) return sp + 1;
  return rawStart;
}

function snapEndToBoundary(text: string, rawEnd: number, maxEnd: number): number {
  if (rawEnd >= maxEnd) return maxEnd;
  const lookahead = Math.min(maxEnd, rawEnd + 40);
  const nl = text.indexOf("\n", rawEnd);
  if (nl !== -1 && nl <= lookahead) return nl;
  const sp = text.indexOf(" ", rawEnd);
  if (sp !== -1 && sp <= lookahead) return sp;
  return rawEnd;
}

function tokenizeQueryWords(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/^[^a-z0-9%£$€._-]+|[^a-z0-9%£$€._-]+$/gi, ""))
        .filter((w) => w.length >= 2 || /^\d+$/.test(w)),
    ),
  );
}

/**
 * Slice extracted HTML/text/JSON content by char_offset, or search the full
 * extracted text with query and return bounded, merged passages with context.
 */
export function extractTextWindowOrQuery(
  fullText: string,
  fileByteCapped: boolean,
  options?: Pick<WebReadOptions, "query" | "charOffset">,
): {
  bodyText: string;
  truncated: boolean;
  meta: TextReadMetadata;
} {
  const totalChars = fullText.length;
  const charOffset =
    typeof options?.charOffset === "number" &&
    Number.isFinite(options.charOffset) &&
    options.charOffset >= 0
      ? Math.floor(options.charOffset)
      : 0;
  const query = options?.query?.trim().slice(0, 200) || "";

  // Mode A: keyword / phrase search across full extracted text
  if (query) {
    const searchStart = Math.min(charOffset, totalChars);
    const lowerFull = fullText.toLowerCase();
    const lowerQuery = query.toLowerCase();

    type RawHit = { start: number; end: number; matchType: "exact_phrase" | "all_words" };
    const hits: RawHit[] = [];

    // 1. Exact phrase matches
    let pos = searchStart;
    while (pos < totalChars && hits.length < 200) {
      const idx = lowerFull.indexOf(lowerQuery, pos);
      if (idx === -1) break;
      hits.push({ start: idx, end: idx + lowerQuery.length, matchType: "exact_phrase" });
      pos = idx + Math.max(1, lowerQuery.length);
    }

    // 2. Fallback: all-words matches across paragraphs (and adjacent paragraph pairs)
    let matchMode: "exact_phrase" | "all_words" | "none" =
      hits.length > 0 ? "exact_phrase" : "none";

    if (hits.length === 0) {
      const words = tokenizeQueryWords(query);
      if (words.length >= 2) {
        // Split into non-empty line/paragraph blocks with character offsets
        const blocks: Array<{ start: number; end: number; lower: string }> = [];
        const lineRe = /[^\n]+/g;
        lineRe.lastIndex = searchStart;
        let m: RegExpExecArray | null;
        while ((m = lineRe.exec(fullText)) !== null) {
          blocks.push({
            start: m.index,
            end: m.index + m[0].length,
            lower: m[0].toLowerCase(),
          });
        }

        for (let i = 0; i < blocks.length && hits.length < 200; i++) {
          const cur = blocks[i]!;
          if (words.every((w) => cur.lower.includes(w))) {
            hits.push({ start: cur.start, end: cur.end, matchType: "all_words" });
            continue;
          }
          // Check minimal consecutive block span up to 800 chars (covers heading + table header + rows)
          let combined = cur.lower;
          for (let j = i + 1; j < blocks.length; j++) {
            const nxt = blocks[j]!;
            if (nxt.end - cur.start > 800) break;
            combined += `\n${nxt.lower}`;
            if (words.every((w) => combined.includes(w))) {
              hits.push({ start: cur.start, end: nxt.end, matchType: "all_words" });
              i = j;
              break;
            }
          }
        }
        if (hits.length > 0) {
          matchMode = "all_words";
        }
      }
    }

    if (hits.length === 0) {
      return {
        bodyText: `(0 passages matched query ${JSON.stringify(query)} across ${totalChars} extracted chars${searchStart > 0 ? ` starting at char_offset=${searchStart}` : ""}${fileByteCapped ? "; raw page exceeded 2 MB byte cap" : ""})`,
        truncated: fileByteCapped,
        meta: {
          totalChars,
          charOffset: searchStart,
          returnedChars: 0,
          hasMoreChars: false,
          fileByteCapped,
          query,
          matchMode: "none",
          totalMatches: 0,
          passages: [],
        },
      };
    }

    // Build context windows & merge overlapping/nearby windows
    type Window = { start: number; end: number; matchType: "exact_phrase" | "all_words" };
    const windows: Window[] = [];
    for (const h of hits) {
      const start = snapStartToBoundary(
        fullText,
        Math.max(searchStart, h.start - TEXT_QUERY_CONTEXT_BEFORE),
        searchStart,
      );
      const end = snapEndToBoundary(
        fullText,
        Math.min(totalChars, h.end + TEXT_QUERY_CONTEXT_AFTER),
        totalChars,
      );
      const prev = windows[windows.length - 1];
      if (prev && start <= prev.end + TEXT_QUERY_MERGE_GAP) {
        prev.end = Math.max(prev.end, end);
      } else {
        windows.push({ start, end, matchType: h.matchType });
      }
    }

    const renderedPassages: string[] = [];
    const returnedPassages: TextQueryPassage[] = [];
    let usedChars = 0;
    let omittedCount = 0;
    let nextCharOffset: number | undefined;

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!;
      const header = `--- Passage ${i + 1} [chars ${w.start}–${w.end} of ${totalChars}] ---`;
      let snippet = fullText.slice(w.start, w.end).trim();
      const overhead = header.length + 1 + (renderedPassages.length > 0 ? 2 : 0);
      const remaining = MAX_TEXT_QUERY_CHARS - usedChars - overhead;

      if (remaining < 160) {
        omittedCount = windows.length - i;
        nextCharOffset = w.start;
        break;
      }

      let actualEnd = w.end;
      if (snippet.length > remaining) {
        snippet = `${snippet.slice(0, Math.max(80, remaining - 3)).trimEnd()}...`;
        actualEnd = Math.min(w.end, w.start + remaining);
        omittedCount = windows.length - i - 1;
        nextCharOffset = actualEnd;
      }

      const block = `${header}\n${snippet}`;
      renderedPassages.push(block);
      returnedPassages.push({
        startChar: w.start,
        endChar: actualEnd,
        matchType: w.matchType,
      });
      usedChars += block.length + (renderedPassages.length > 1 ? 2 : 0);

      if (nextCharOffset !== undefined) {
        break;
      }
    }

    const hasMoreChars = nextCharOffset !== undefined;
    const footer = hasMoreChars
      ? `\n[truncated — returned ${returnedPassages.length} of ${windows.length} matching passage(s) (${hits.length} total hit(s)); pass query=${JSON.stringify(query)} with char_offset=${nextCharOffset} to inspect later matches]`
      : fileByteCapped
        ? `\n[note — raw page exceeded 2 MB byte cap; ${returnedPassages.length} matching passage(s) found within fetched portion]`
        : "";

    return {
      bodyText: `${renderedPassages.join("\n\n")}${footer}`,
      truncated: hasMoreChars || fileByteCapped,
      meta: {
        totalChars,
        charOffset: searchStart,
        returnedChars: usedChars,
        hasMoreChars,
        ...(nextCharOffset !== undefined ? { nextCharOffset } : {}),
        fileByteCapped,
        query,
        matchMode,
        totalMatches: hits.length,
        passages: returnedPassages,
      },
    };
  }

  // Mode B: sequential char_offset slice
  if (charOffset >= totalChars) {
    return {
      bodyText:
        totalChars === 0
          ? "(no readable text extracted)"
          : `(char_offset=${charOffset} is at or past end of extracted text; total_chars=${totalChars})`,
      truncated: fileByteCapped,
      meta: {
        totalChars,
        charOffset,
        returnedChars: 0,
        hasMoreChars: false,
        fileByteCapped,
      },
    };
  }

  let end = Math.min(totalChars, charOffset + MAX_TEXT_CHARS);
  if (end < totalChars) {
    // Snap backward slightly to a newline or space so we don't chop mid-word
    const minSnap = charOffset + Math.floor(MAX_TEXT_CHARS * 0.85);
    const nl = fullText.lastIndexOf("\n", end);
    if (nl >= minSnap) {
      end = nl;
    } else {
      const sp = fullText.lastIndexOf(" ", end);
      if (sp >= minSnap) {
        end = sp;
      }
    }
  }

  const snippet = fullText.slice(charOffset, end);
  const hasMoreChars = end < totalChars;
  const nextCharOffset = hasMoreChars ? end : undefined;

  return {
    bodyText: snippet || "(no readable text extracted)",
    truncated: hasMoreChars || fileByteCapped,
    meta: {
      totalChars,
      charOffset,
      returnedChars: snippet.length,
      hasMoreChars,
      ...(nextCharOffset !== undefined ? { nextCharOffset } : {}),
      fileByteCapped,
    },
  };
}

function extractPdfLinksFromHtml(
  rawHtml: string,
  baseUrl: URL,
): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const links: Array<{ title: string; url: string }> = [];
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const m of rawHtml.matchAll(anchorRe)) {
    const rawHref = (m[2] || m[3] || m[4] || "").trim();
    const attrs = `${m[1] || ""} ${m[5] || ""}`.toLowerCase();
    if (!rawHref) continue;

    let resolved: URL;
    try {
      resolved = validateSafePublicUrl(new URL(rawHref, baseUrl).toString());
    } catch {
      continue;
    }

    const pathLower = resolved.pathname.toLowerCase();
    const isPdfLink =
      pathLower.endsWith(".pdf") ||
      attrs.includes("application/pdf") ||
      /\.pdf(\b|$)/i.test(resolved.search);
    if (!isPdfLink) continue;

    const urlStr = resolved.toString();
    if (seen.has(urlStr)) continue;
    seen.add(urlStr);

    const text = decodeHtmlEntities((m[6] || "").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    links.push({ title: text || urlStr, url: urlStr });
    if (links.length >= 6) break;
  }

  return links;
}

function extractCsvLinksFromHtml(
  rawHtml: string,
  baseUrl: URL,
): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const links: Array<{ title: string; url: string }> = [];
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const m of rawHtml.matchAll(anchorRe)) {
    const rawHref = (m[2] || m[3] || m[4] || "").trim();
    const attrs = `${m[1] || ""} ${m[5] || ""}`.toLowerCase();
    if (!rawHref) continue;

    let resolved: URL;
    try {
      resolved = validateSafePublicUrl(new URL(rawHref, baseUrl).toString());
    } catch {
      continue;
    }

    const pathLower = resolved.pathname.toLowerCase();
    const isCsvLink =
      pathLower.endsWith(".csv") ||
      pathLower.endsWith(".tsv") ||
      attrs.includes("text/csv") ||
      /\.csv(\b|$)/i.test(resolved.search);
    if (!isCsvLink) continue;

    const urlStr = resolved.toString();
    if (seen.has(urlStr)) continue;
    seen.add(urlStr);

    const text = decodeHtmlEntities((m[6] || "").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    links.push({ title: text || urlStr, url: urlStr });
    if (links.length >= 6) break;
  }

  return links;
}

function extractZipLinksFromHtml(
  rawHtml: string,
  baseUrl: URL,
): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const links: Array<{ title: string; url: string }> = [];
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const m of rawHtml.matchAll(anchorRe)) {
    const rawHref = (m[2] || m[3] || m[4] || "").trim();
    const attrs = `${m[1] || ""} ${m[5] || ""}`.toLowerCase();
    if (!rawHref) continue;

    let resolved: URL;
    try {
      resolved = validateSafePublicUrl(new URL(rawHref, baseUrl).toString());
    } catch {
      continue;
    }

    const pathLower = resolved.pathname.toLowerCase();
    const isZipLink =
      pathLower.endsWith(".zip") ||
      attrs.includes("application/zip") ||
      /\.zip(\b|$)/i.test(resolved.search);
    if (!isZipLink) continue;

    const urlStr = resolved.toString();
    if (seen.has(urlStr)) continue;
    seen.add(urlStr);

    const text = decodeHtmlEntities((m[6] || "").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
    links.push({ title: text || urlStr, url: urlStr });
    if (links.length >= 6) break;
  }

  return links;
}

/**
 * Strict RFC-4180 CSV/TSV parser that preserves empty cells (""), trailing empty cells,
 * quoted fields with embedded commas/newlines, and literal missing-value markers.
 */
export function parseCsvRecords(
  rawText: string,
  delimiter: "," | "\t" = ",",
  dropTrailingIncomplete = false,
): string[][] {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (fieldStart && ch === '"') {
      inQuotes = true;
      fieldStart = false;
      continue;
    }

    if (ch === delimiter) {
      currentRow.push(field);
      field = "";
      fieldStart = true;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") {
        i++;
      }
      currentRow.push(field);
      rows.push(currentRow);
      currentRow = [];
      field = "";
      fieldStart = true;
      continue;
    }

    field += ch;
    fieldStart = false;
  }

  // Push trailing record unless the stream was byte-capped mid-record or trailing blank EOF newline
  const hasTrailingContent = currentRow.length > 0 || field.length > 0;
  if (hasTrailingContent && !dropTrailingIncomplete) {
    currentRow.push(field);
    rows.push(currentRow);
  }

  // Drop a single completely blank trailing row produced only by empty input
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.length === 1 &&
    rows[rows.length - 1]![0] === ""
  ) {
    rows.pop();
  }

  return rows;
}

function formatCsvCellDisplay(cell: string): string {
  if (cell === "") return '""';
  const collapsed = cell.replace(/\r?\n/g, "\\n");
  if (
    collapsed.includes("|") ||
    collapsed === '""' ||
    /^\s|\s$/.test(collapsed)
  ) {
    return JSON.stringify(collapsed);
  }
  return collapsed;
}

export function extractCsvRows(
  bytes: Uint8Array,
  fileByteCapped: boolean,
  rawUrl: string,
  finalUrl: string,
  contentType: string,
  options?: WebReadOptions,
): WebReadOutput {
  const delimiter: "," | "\t" =
    contentType === "text/tab-separated-values" ||
    finalUrl.toLowerCase().includes(".tsv")
      ? "\t"
      : ",";

  const rawText = new TextDecoder("utf-8").decode(bytes);
  const allRecords = parseCsvRecords(rawText, delimiter, fileByteCapped);
  if (allRecords.length === 0) {
    throw new Error("CSV file is empty or contains no parseable rows.");
  }

  const headers = allRecords[0]!;
  const columnCount = headers.length;
  const rawDataRows = allRecords.slice(1);
  const totalDataRows = rawDataRows.length;

  // Align every row to at least header columnCount (preserving empty strings and any ragged extra cells)
  const alignRow = (row: string[]): string[] => {
    if (row.length >= columnCount) return row;
    const padded = row.slice();
    while (padded.length < columnCount) padded.push("");
    return padded;
  };

  // Resolve optional filter_column (header name case-insensitive OR 1-based column index)
  const rawFilterCol = options?.filterColumn?.trim();
  const hasFilterValue = options?.filterValue !== undefined;
  const filterValue = options?.filterValue;
  const query = options?.query?.trim().slice(0, 200) || "";

  let filterColIndex: number | undefined;
  let resolvedFilterColName: string | undefined;

  if (rawFilterCol) {
    const exactIdx = headers.findIndex(
      (h) => h.trim().toLowerCase() === rawFilterCol.toLowerCase(),
    );
    if (exactIdx >= 0) {
      filterColIndex = exactIdx;
      resolvedFilterColName = headers[exactIdx]!;
    } else if (/^\d+$/.test(rawFilterCol)) {
      const oneBased = Number(rawFilterCol);
      if (oneBased >= 1 && oneBased <= columnCount) {
        filterColIndex = oneBased - 1;
        resolvedFilterColName = headers[filterColIndex]!;
      }
    }
    if (filterColIndex === undefined) {
      const avail = headers
        .slice(0, 25)
        .map((h, i) => `[${i + 1}] ${h || '""'}`)
        .join(", ");
      throw new Error(
        `Column "${rawFilterCol}" not found in CSV headers. Available columns: ${avail}`,
      );
    }
    if (!hasFilterValue) {
      throw new Error(
        `filter_value is required when filter_column ("${resolvedFilterColName}") is specified (pass "" to match empty cells).`,
      );
    }
  }

  const matched: CsvRowEntry[] = [];
  const lowerFilterVal = hasFilterValue ? filterValue!.toLowerCase() : "";
  const lowerQuery = query.toLowerCase();

  for (let idx = 0; idx < rawDataRows.length; idx++) {
    const cells = alignRow(rawDataRows[idx]!);

    if (hasFilterValue) {
      if (filterColIndex !== undefined) {
        const cell = cells[filterColIndex] ?? "";
        if (cell.toLowerCase() !== lowerFilterVal) continue;
      } else {
        const anyExact = cells.some((c) => c.toLowerCase() === lowerFilterVal);
        if (!anyExact) continue;
      }
    }

    if (lowerQuery) {
      const anySubstr = cells.some((c) => c.toLowerCase().includes(lowerQuery));
      if (!anySubstr) continue;
    }

    matched.push({ rowNumber: idx + 1, cells });
  }

  const matchedRows = matched.length;
  const rowOffset =
    typeof options?.rowOffset === "number" &&
    Number.isInteger(options.rowOffset) &&
    options.rowOffset >= 0
      ? options.rowOffset
      : 0;
  const maxRows =
    typeof options?.maxRows === "number" && Number.isFinite(options.maxRows)
      ? Math.max(1, Math.min(MAX_CSV_ROWS_PER_CALL, Math.round(options.maxRows)))
      : DEFAULT_CSV_ROWS_PER_CALL;

  const sliced = matched.slice(rowOffset, rowOffset + maxRows);

  const headerLine = `Columns (${columnCount}): ${headers
    .map((h, i) => `[${i + 1}] ${formatCsvCellDisplay(h)}`)
    .join(" | ")}`;
  const renderedRows: string[] = [];
  const returnedRows: CsvRowEntry[] = [];
  let usedChars = headerLine.length + 2;
  let charCapped = false;

  for (const entry of sliced) {
    const line = `Row ${entry.rowNumber} | ${entry.cells
      .map(formatCsvCellDisplay)
      .join(" | ")}`;
    if (
      renderedRows.length > 0 &&
      usedChars + line.length + 1 > MAX_CSV_TEXT_CHARS
    ) {
      charCapped = true;
      break;
    }
    renderedRows.push(line);
    returnedRows.push(entry);
    usedChars += line.length + 1;
  }

  const hasMoreRows =
    fileByteCapped ||
    charCapped ||
    rowOffset + returnedRows.length < matchedRows;
  const nextRowOffset =
    rowOffset + returnedRows.length < matchedRows
      ? rowOffset + returnedRows.length
      : undefined;

  const filterMeta =
    hasFilterValue || query
      ? {
          ...(resolvedFilterColName !== undefined
            ? { column: resolvedFilterColName }
            : {}),
          ...(filterColIndex !== undefined
            ? { columnIndex: filterColIndex + 1 }
            : {}),
          ...(hasFilterValue ? { value: filterValue } : {}),
          ...(query ? { query } : {}),
        }
      : undefined;

  const safeUrl = finalUrl.replaceAll('"', "&quot;");
  const filterNote = filterMeta
    ? `Filter: ${[
        filterMeta.column
          ? `${filterMeta.column} == ${JSON.stringify(filterMeta.value)}`
          : filterMeta.value !== undefined
            ? `any cell == ${JSON.stringify(filterMeta.value)}`
            : null,
        filterMeta.query ? `contains ${JSON.stringify(filterMeta.query)}` : null,
      ]
        .filter(Boolean)
        .join(" AND ")}`
    : "";

  const untrustedLines = [
    `<untrusted_web_page url="${safeUrl}" content_type="${contentType}" total_rows="${totalDataRows}" matched_rows="${matchedRows}" row_offset="${rowOffset}" returned_rows="${returnedRows.length}">`,
    headerLine,
    ...(filterNote ? [filterNote] : []),
    `Note: "" denotes an empty cell; literal missing-value markers (e.g. -, .., N/A, [c]) are preserved verbatim.`,
    "",
    ...(renderedRows.length > 0
      ? renderedRows
      : [
          matchedRows === 0
            ? "(0 rows matched the filter)"
            : `(no rows at row_offset=${rowOffset}; matched_rows=${matchedRows})`,
        ]),
    ...(hasMoreRows
      ? [
          `[truncated — showing ${returnedRows.length} of ${matchedRows} matching row(s) (${totalDataRows} total data rows${fileByteCapped ? "; source exceeded 4 MB byte cap" : ""})${nextRowOffset !== undefined ? `; pass row_offset=${nextRowOffset} to continue` : ""}]`,
        ]
      : []),
    `</untrusted_web_page>`,
  ];

  return {
    url: rawUrl,
    finalUrl,
    title: "",
    contentType,
    truncated: hasMoreRows,
    untrustedBlock: untrustedLines.join("\n"),
    csv: {
      delimiter,
      headers,
      columnCount,
      totalDataRows,
      matchedRows,
      rowOffset,
      returnedRowCount: returnedRows.length,
      hasMoreRows,
      ...(nextRowOffset !== undefined ? { nextRowOffset } : {}),
      fileByteCapped,
      ...(filterMeta ? { filter: filterMeta } : {}),
      rows: returnedRows,
    },
  };
}

async function readBytesCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; capped: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), capped: false };
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

  return { bytes: merged, capped };
}

type ZipCentralEntry = ZipMemberInfo & {
  localHeaderOffset: number;
  flags: number;
};

const NESTED_ARCHIVE_EXT_RE = /\.(zip|gz|gzip|tgz|tar|7z|rar|bz2|xz|zst|lz4)$/i;

function hasZipMagicHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  // Local file header PK\x03\x04 or empty archive EOCD PK\x05\x06
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

function normalizeZipMemberName(raw: string): string {
  return raw
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/|\/)+/, "")
    .trim();
}

function isMacOsMetadataMember(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("__macosx/")) return true;
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return base.startsWith("._");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function parseZipCentralDirectory(bytes: Uint8Array): {
  entries: ZipCentralEntry[];
  totalEntries: number;
} {
  const len = bytes.byteLength;
  if (len < 22) {
    throw new Error("Invalid ZIP archive: file too short.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End of Central Directory (PK\x05\x06) scanning backward
  const minPos = Math.max(0, len - 65_557);
  let eocdPos = -1;
  for (let pos = len - 22; pos >= minPos; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      const commentLen = view.getUint16(pos + 20, true);
      if (pos + 22 + commentLen === len) {
        eocdPos = pos;
        break;
      }
    }
  }
  if (eocdPos === -1) {
    throw new Error("Invalid or truncated ZIP archive: missing End of Central Directory.");
  }

  const diskNum = view.getUint16(eocdPos + 4, true);
  const cdDiskNum = view.getUint16(eocdPos + 6, true);
  const totalEntries = view.getUint16(eocdPos + 10, true);
  const cdSize = view.getUint32(eocdPos + 12, true);
  const cdOffset = view.getUint32(eocdPos + 16, true);

  if (diskNum !== 0 || cdDiskNum !== 0) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported.");
  }
  if (cdOffset + cdSize > eocdPos) {
    throw new Error("Corrupt ZIP archive: Central Directory extends past EOCD.");
  }

  const decoder = new TextDecoder("utf-8");
  const entries: ZipCentralEntry[] = [];
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  const parseLimit = Math.min(totalEntries, 2000);

  for (let i = 0; i < parseLimit && pos + 46 <= cdEnd; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error("Corrupt ZIP archive: invalid Central Directory entry header.");
    }
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const nameStart = pos + 46;
    const nextPos = nameStart + nameLen + extraLen + commentLen;
    if (nextPos > cdEnd) {
      throw new Error("Corrupt ZIP archive: Central Directory entry truncated.");
    }

    const rawName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    pos = nextPos;

    // Skip directories and macOS resource fork metadata
    if (!rawName || rawName.endsWith("/") || rawName.endsWith("\\")) continue;
    const name = normalizeZipMemberName(rawName);
    if (!name || name.includes("..") || isMacOsMetadataMember(name)) continue;

    const encrypted = Boolean(flags & 0x01);
    const nestedArchive = NESTED_ARCHIVE_EXT_RE.test(name);
    const lower = name.toLowerCase();
    const isCsvExt = lower.endsWith(".csv") || lower.endsWith(".tsv");
    const supportedMethod = method === 0 || method === 8;
    const readableAsCsv = !encrypted && !nestedArchive && isCsvExt && supportedMethod;

    entries.push({
      name,
      compressedBytes: compressedSize,
      uncompressedBytes: uncompressedSize,
      compressionMethod: method,
      readableAsCsv,
      nestedArchive,
      encrypted,
      exceedsInflatedCap: uncompressedSize > MAX_ZIP_INFLATED_BYTES,
      localHeaderOffset,
      flags,
    });
  }

  return { entries, totalEntries: entries.length };
}

async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onCapped?: () => void,
): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const reader = stream.getReader();
  reader.closed.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        capped = true;
        onCapped?.();
        await reader.cancel().catch(() => {});
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
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: merged, capped };
}

async function inflateZipMemberCapped(
  archiveBytes: Uint8Array,
  entry: ZipCentralEntry,
): Promise<{ bytes: Uint8Array; capped: boolean }> {
  if (entry.encrypted) {
    throw new Error(`ZIP member '${entry.name}' is encrypted and cannot be read.`);
  }
  if (entry.nestedArchive) {
    throw new Error(
      `Nested archives are not permitted ('${entry.name}'). Only direct .csv and .tsv members can be read.`,
    );
  }
  const lower = entry.name.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".tsv")) {
    throw new Error(
      `Unsupported ZIP member '${entry.name}'. Only .csv and .tsv members can be read.`,
    );
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(
      `Unsupported ZIP compression method (${entry.compressionMethod}) for '${entry.name}'. Only stored (0) and deflate (8) are supported.`,
    );
  }
  if (entry.uncompressedBytes > MAX_ZIP_DECLARED_MEMBER_BYTES) {
    const mb = (entry.uncompressedBytes / (1024 * 1024)).toFixed(1);
    throw new Error(
      `ZIP member '${entry.name}' declares ${mb} MB uncompressed, exceeding the maximum inspectable limit (${MAX_ZIP_DECLARED_MEMBER_BYTES / (1024 * 1024)} MB).`,
    );
  }

  const view = new DataView(
    archiveBytes.buffer,
    archiveBytes.byteOffset,
    archiveBytes.byteLength,
  );
  const lh = entry.localHeaderOffset;
  if (lh + 30 > archiveBytes.byteLength || view.getUint32(lh, true) !== 0x04034b50) {
    throw new Error(`Corrupt ZIP local file header for '${entry.name}'.`);
  }
  const localNameLen = view.getUint16(lh + 26, true);
  const localExtraLen = view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + localNameLen + localExtraLen;
  const dataEnd = dataStart + entry.compressedBytes;
  if (dataEnd > archiveBytes.byteLength) {
    throw new Error(`Corrupt ZIP archive: member '${entry.name}' data out of bounds.`);
  }

  const compressedSlice = archiveBytes.subarray(dataStart, dataEnd);

  if (entry.compressionMethod === 0) {
    const capped = compressedSlice.byteLength > MAX_ZIP_INFLATED_BYTES;
    const out = capped
      ? compressedSlice.slice(0, MAX_ZIP_INFLATED_BYTES)
      : compressedSlice.slice();
    return { bytes: out, capped };
  }

  // Method 8 (DEFLATE raw): pump small 4 KB slices into DecompressionStream so even high-ratio
  // archives stop immediately at MAX_ZIP_INFLATED_BYTES without unhandled Z_BUF_ERROR rejections.
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.closed.catch(() => {});
  let stopped = false;

  const writePromise = (async () => {
    try {
      const CHUNK_SIZE = 4 * 1024;
      for (
        let offset = 0;
        offset < compressedSlice.byteLength && !stopped;
        offset += CHUNK_SIZE
      ) {
        const end = Math.min(offset + CHUNK_SIZE, compressedSlice.byteLength);
        await writer.write(compressedSlice.subarray(offset, end));
      }
      if (!stopped) {
        await writer.close();
      }
    } catch {
      // Expected if reader cancels early upon hitting MAX_ZIP_INFLATED_BYTES
    }
  })();

  let inflated: Uint8Array;
  let capped: boolean;
  try {
    const res = await readStreamCapped(
      ds.readable,
      MAX_ZIP_INFLATED_BYTES,
      () => {
        stopped = true;
      },
    );
    inflated = res.bytes;
    capped = res.capped;
  } finally {
    stopped = true;
    await writer.abort().catch(() => {});
    await writePromise.catch(() => {});
  }

  // Guard against zip-bomb headers claiming a tiny uncompressed size that actually explodes past the cap
  if (capped && entry.uncompressedBytes > 0 && entry.uncompressedBytes <= MAX_ZIP_INFLATED_BYTES) {
    throw new Error(
      `ZIP member '${entry.name}' exceeded inflated size cap (${MAX_ZIP_INFLATED_BYTES / (1024 * 1024)} MB) despite smaller declared size (${formatByteSize(entry.uncompressedBytes)}).`,
    );
  }

  return { bytes: inflated, capped };
}

function toPublicMemberInfo(entry: ZipCentralEntry): ZipMemberInfo {
  return {
    name: entry.name,
    compressedBytes: entry.compressedBytes,
    uncompressedBytes: entry.uncompressedBytes,
    compressionMethod: entry.compressionMethod,
    readableAsCsv: entry.readableAsCsv,
    nestedArchive: entry.nestedArchive,
    encrypted: entry.encrypted,
    exceedsInflatedCap: entry.exceedsInflatedCap,
  };
}

export async function extractZipCsvOrListing(
  bytes: Uint8Array,
  rawUrl: string,
  finalUrl: string,
  options?: WebReadOptions,
): Promise<WebReadOutput> {
  const { entries, totalEntries } = parseZipCentralDirectory(bytes);
  const listed = entries.slice(0, MAX_ZIP_MEMBERS_LISTED);
  const membersTruncated = entries.length > listed.length;
  const publicMembers = listed.map(toPublicMemberInfo);
  const requestedMember = options?.zipMember?.trim() || "";

  if (!requestedMember) {
    const safeUrl = finalUrl.replaceAll('"', "&quot;");
    const memberLines =
      publicMembers.length > 0
        ? publicMembers.map((m, idx) => {
            const status = m.encrypted
              ? "encrypted (unsupported)"
              : m.nestedArchive
                ? "nested archive (blocked)"
                : m.readableAsCsv
                  ? m.exceedsInflatedCap
                    ? `csv/tsv (inflated > 4 MB; will stream first 4 MB)`
                    : "csv/tsv (readable)"
                  : "unsupported format";
            return `${idx + 1}. ${m.name} — ${formatByteSize(m.uncompressedBytes)} uncompressed (${formatByteSize(m.compressedBytes)} compressed) [${status}]`;
          })
        : ["(archive contains no readable file members)"];

    const untrustedLines = [
      `<untrusted_web_page url="${safeUrl}" content_type="application/zip" compressed_bytes="${bytes.byteLength}" total_members="${totalEntries}" listed_members="${publicMembers.length}">`,
      `ZIP archive members (${totalEntries} total, ${formatByteSize(bytes.byteLength)} compressed):`,
      ...memberLines,
      ...(membersTruncated
        ? [`[truncated — showing first ${publicMembers.length} of ${totalEntries} members]`]
        : []),
      `</untrusted_web_page>`,
    ];

    return {
      url: rawUrl,
      finalUrl,
      title: "",
      contentType: "application/zip",
      truncated: membersTruncated,
      untrustedBlock: untrustedLines.join("\n"),
      zip: {
        compressedArchiveBytes: bytes.byteLength,
        totalMembers: totalEntries,
        listedMembers: publicMembers.length,
        membersTruncated,
        members: publicMembers,
      },
    };
  }

  // Locate requested member: exact normalized -> case-insensitive -> unique basename
  const normReq = normalizeZipMemberName(requestedMember);
  const lowerReq = normReq.toLowerCase();
  let matched = entries.find((e) => e.name === normReq);
  if (!matched) {
    matched = entries.find((e) => e.name.toLowerCase() === lowerReq);
  }
  if (!matched && !normReq.includes("/")) {
    const byBase = entries.filter((e) => {
      const base = e.name.slice(e.name.lastIndexOf("/") + 1).toLowerCase();
      return base === lowerReq;
    });
    if (byBase.length === 1) {
      matched = byBase[0];
    } else if (byBase.length > 1) {
      throw new Error(
        `Ambiguous zip_member '${requestedMember}'. Matching paths: ${byBase.slice(0, 6).map((e) => e.name).join(", ")}. Pass the full member path.`,
      );
    }
  }
  if (!matched) {
    const sample = entries
      .slice(0, 10)
      .map((e) => e.name)
      .join(", ");
    throw new Error(
      `ZIP member '${requestedMember}' not found. Available members${entries.length > 10 ? " (first 10)" : ""}: ${sample || "(none)"}.`,
    );
  }

  const { bytes: inflatedBytes, capped: inflatedCapped } =
    await inflateZipMemberCapped(bytes, matched);

  const memberContentType = matched.name.toLowerCase().endsWith(".tsv")
    ? "text/tab-separated-values"
    : "text/csv";

  const csvOut = extractCsvRows(
    inflatedBytes,
    inflatedCapped,
    rawUrl,
    finalUrl,
    memberContentType,
    options,
  );

  // Annotate the <untrusted_web_page> tag with zip_member metadata
  const safeMember = matched.name.replaceAll('"', "&quot;");
  const annotatedBlock = csvOut.untrustedBlock.replace(
    /^<untrusted_web_page /,
    `<untrusted_web_page zip_member="${safeMember}" `,
  );

  return {
    ...csvOut,
    contentType: "application/zip",
    truncated: csvOut.truncated || inflatedCapped,
    untrustedBlock: annotatedBlock,
    zip: {
      compressedArchiveBytes: bytes.byteLength,
      totalMembers: totalEntries,
      listedMembers: publicMembers.length,
      membersTruncated,
      selectedMember: matched.name,
      selectedMemberCompressedBytes: matched.compressedBytes,
      selectedMemberUncompressedBytes: matched.uncompressedBytes,
      inflatedByteCapped: inflatedCapped,
      members: publicMembers,
    },
  };
}

function hasPdfMagicHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  // Allow tiny leading whitespace/BOM before %PDF-
  const limit = Math.min(bytes.byteLength - 5, 32);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}

export function parsePdfPageRange(
  spec: string | undefined,
  totalPages: number,
  maxPages: number,
): { pages: number[]; truncatedSpec: boolean } {
  if (totalPages <= 0) {
    return { pages: [], truncatedSpec: false };
  }

  const clean = (spec || "").trim();
  if (!clean) {
    const count = Math.min(totalPages, maxPages);
    const pages: number[] = [];
    for (let p = 1; p <= count; p++) pages.push(p);
    return { pages, truncatedSpec: totalPages > count };
  }

  const pageSet = new Set<number>();
  const parts = clean.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(
      "Invalid pages range. Use formats like '1-5', '3', or '1,4-6'.",
    );
  }

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start
      ) {
        throw new Error(
          `Invalid page range '${part}'. Start must be >= 1 and <= end.`,
        );
      }
      const cappedEnd = Math.min(end, totalPages);
      for (let p = start; p <= cappedEnd; p++) {
        pageSet.add(p);
        if (pageSet.size > maxPages + 1) break;
      }
      continue;
    }

    if (/^\d+$/.test(part)) {
      const p = Number(part);
      if (p < 1) {
        throw new Error(`Invalid page number '${part}'. Pages are 1-based.`);
      }
      if (p <= totalPages) {
        pageSet.add(p);
      }
      continue;
    }

    throw new Error(
      `Invalid pages range '${part}'. Use formats like '1-5', '3', or '1,4-6'.`,
    );
  }

  const sorted = Array.from(pageSet).sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error(
      `Requested pages '${clean}' are out of range (PDF has ${totalPages} page${totalPages === 1 ? "" : "s"}).`,
    );
  }

  const truncatedSpec = sorted.length > maxPages;
  return {
    pages: truncatedSpec ? sorted.slice(0, maxPages) : sorted,
    truncatedSpec,
  };
}

type PdfTextToken = {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
};

/**
 * Reconstruct readable line- and table-preserving text from PDF.js TextContent items.
 * Groups items into visual rows by Y coordinate and inserts column separators (" | ")
 * when horizontal gaps indicate tabular columns.
 */
function formatPdfPageText(items: ReadonlyArray<unknown>): string {
  const tokens: PdfTextToken[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
    const item = raw as {
      str?: unknown;
      transform?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    const tr = Array.isArray(item.transform) ? item.transform : [10, 0, 0, 10, 0, 0];
    const a = Number(tr[0]) || 0;
    const b = Number(tr[1]) || 0;
    const d = Number(tr[3]) || 0;
    const x = Number(tr[4]) || 0;
    const y = Number(tr[5]) || 0;
    const height = typeof item.height === "number" && item.height > 0 ? item.height : 0;
    const fontSize = Math.hypot(a, b) || Math.abs(d) || height || 10;
    const width =
      typeof item.width === "number" && Number.isFinite(item.width) && item.width >= 0
        ? item.width
        : item.str.length * fontSize * 0.5;

    tokens.push({ str: item.str, x, y, width, fontSize });
  }

  if (tokens.length === 0) return "";

  // Sort top-to-bottom (PDF Y increases upward), then left-to-right
  tokens.sort((a, b) => b.y - a.y || a.x - b.x);

  type VisualRow = {
    y: number;
    fontSize: number;
    items: PdfTextToken[];
  };
  const rows: VisualRow[] = [];

  for (const tok of tokens) {
    const lastRow = rows[rows.length - 1];
    const tol = lastRow ? Math.max(2.5, lastRow.fontSize * 0.45) : 0;
    if (lastRow && Math.abs(tok.y - lastRow.y) <= tol) {
      lastRow.items.push(tok);
    } else {
      rows.push({ y: tok.y, fontSize: tok.fontSize, items: [tok] });
    }
  }

  const lines: string[] = [];
  let prevRow: VisualRow | null = null;

  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let line = "";
    let prev: PdfTextToken | null = null;

    for (const item of row.items) {
      if (!prev) {
        line = item.str;
        prev = item;
        continue;
      }

      const gap = item.x - (prev.x + prev.width);
      const colGap = Math.max(12, row.fontSize * 1.45);
      const wordGap = Math.max(1.2, row.fontSize * 0.18);

      if (gap > colGap && line.trim().length > 0 && item.str.trim().length > 0) {
        line = `${line.trimEnd()}  |  ${item.str.trimStart()}`;
      } else if (
        gap > wordGap &&
        !/\s$/.test(line) &&
        !/^\s/.test(item.str)
      ) {
        line += ` ${item.str}`;
      } else {
        line += item.str;
      }
      prev = item;
    }

    const cleaned = line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/, "");
    if (!cleaned) continue;

    if (prevRow) {
      const yDelta = prevRow.y - row.y;
      if (yDelta > Math.max(row.fontSize, prevRow.fontSize) * 1.95 && lines.length > 0) {
        lines.push("");
      }
    }
    lines.push(cleaned);
    prevRow = row;
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function matchPdfPageQuery(
  text: string,
  query: string,
): "exact_phrase" | "all_words" | null {
  const lower = text.toLowerCase();
  const clean = query.trim().toLowerCase();
  if (!clean) return null;
  if (lower.includes(clean)) return "exact_phrase";

  const words = Array.from(
    new Set(
      clean
        .split(/\s+/)
        .map((w) => w.replace(/^[^a-z0-9%£$€._-]+|[^a-z0-9%£$€._-]+$/gi, ""))
        .filter((w) => w.length >= 2),
    ),
  );
  if (words.length >= 2 && words.every((w) => lower.includes(w))) {
    return "all_words";
  }
  return null;
}

export async function extractPdfPages(
  bytes: Uint8Array,
  rawUrl: string,
  finalUrl: string,
  options?: WebReadOptions,
): Promise<WebReadOutput> {
  // Pass a fresh standalone Uint8Array copy so PDF.js's worker transfer never detaches a caller buffer.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const totalPages = pdf.numPages;
    const { OPS } = await getResolvedPDFJS();
    let title = "";
    try {
      const meta = await getMeta(pdf);
      if (typeof meta.info?.Title === "string") {
        title = meta.info.Title.trim().slice(0, 160);
      }
    } catch {
      // non-fatal metadata omission
    }

    const query = options?.query?.trim().slice(0, 200) || "";
    const maxPagesToInspect = options?.pages?.trim()
      ? query
        ? MAX_PDF_QUERY_SCAN_PAGES
        : MAX_PDF_EXPLICIT_PAGES
      : query
        ? MAX_PDF_QUERY_SCAN_PAGES
        : MAX_PDF_DEFAULT_PAGES;

    const { pages: pagesToInspect, truncatedSpec } = parsePdfPageRange(
      options?.pages,
      totalPages,
      maxPagesToInspect,
    );

    const summaries: PdfPageSummary[] = [];
    const imageOnlyPages: number[] = [];
    const blankPages: number[] = [];
    const noMatchPages: number[] = [];
    const matchedPages: number[] = [];
    const returnedPages: number[] = [];
    const blocks: string[] = [];

    let usedChars = 0;
    let charCapped = false;
    let lastInspectedPage = 0;

    for (const pageNum of pagesToInspect) {
      lastInspectedPage = pageNum;
      const page = await pdf.getPage(pageNum);
      let pageText = "";
      let imageCount = 0;

      try {
        const textContent = await page.getTextContent();
        pageText = formatPdfPageText(textContent.items);
        const nonWsChars = pageText.replace(/\s+/g, "").length;

        // Inspect operator list only when selectable text is absent or minimal
        if (nonWsChars < 12) {
          const opList = await page.getOperatorList();
          for (const fn of opList.fnArray) {
            if (
              fn === OPS.paintImageXObject ||
              fn === OPS.paintInlineImageXObject ||
              fn === OPS.paintImageMaskXObject ||
              fn === OPS.paintImageXObjectRepeat
            ) {
              imageCount++;
            }
          }
        }
      } finally {
        page.cleanup();
      }

      const nonWsChars = pageText.replace(/\s+/g, "").length;

      if (nonWsChars === 0 && imageCount === 0) {
        blankPages.push(pageNum);
        summaries.push({ page: pageNum, status: "blank", charCount: 0 });
        if (!query && !charCapped) {
          const block = `--- Page ${pageNum} / ${totalPages} ---\n[blank page: no text or images]`;
          blocks.push(block);
          returnedPages.push(pageNum);
          usedChars += block.length;
        }
        continue;
      }

      if (nonWsChars < 12 && imageCount > 0) {
        imageOnlyPages.push(pageNum);
        summaries.push({
          page: pageNum,
          status: "image_only",
          charCount: nonWsChars,
          imageCount,
        });
        if (!query && !charCapped) {
          const residual = pageText ? ` (minimal text: "${pageText}")` : "";
          const block = `--- Page ${pageNum} / ${totalPages} ---\n[image-only page: no selectable text layer; ${imageCount} image(s) detected${residual}]`;
          blocks.push(block);
          returnedPages.push(pageNum);
          usedChars += block.length;
        }
        continue;
      }

      // Page has selectable text
      if (query) {
        const matchType = matchPdfPageQuery(pageText, query);
        if (!matchType) {
          noMatchPages.push(pageNum);
          summaries.push({
            page: pageNum,
            status: "no_match",
            charCount: pageText.length,
          });
          continue;
        }

        matchedPages.push(pageNum);
        if (charCapped) {
          summaries.push({
            page: pageNum,
            status: "matched",
            charCount: pageText.length,
            matchType,
            truncated: true,
          });
          continue;
        }

        const header = `--- Page ${pageNum} / ${totalPages} (matched: ${matchType}) ---\n`;
        const remaining = MAX_PDF_TEXT_CHARS - usedChars - header.length;
        if (remaining < 120) {
          charCapped = true;
          summaries.push({
            page: pageNum,
            status: "matched",
            charCount: pageText.length,
            matchType,
            truncated: true,
          });
          continue;
        }

        const pageTruncated = pageText.length > remaining;
        const body = pageTruncated
          ? `${pageText.slice(0, remaining)}\n[page ${pageNum} truncated]`
          : pageText;
        blocks.push(`${header}${body}`);
        returnedPages.push(pageNum);
        usedChars += header.length + body.length;
        if (pageTruncated) charCapped = true;
        summaries.push({
          page: pageNum,
          status: "matched",
          charCount: pageText.length,
          matchType,
          ...(pageTruncated ? { truncated: true } : {}),
        });
      } else {
        if (charCapped) {
          summaries.push({
            page: pageNum,
            status: "text",
            charCount: pageText.length,
            truncated: true,
          });
          continue;
        }

        const header = `--- Page ${pageNum} / ${totalPages} ---\n`;
        const remaining = MAX_PDF_TEXT_CHARS - usedChars - header.length;
        if (remaining < 120) {
          charCapped = true;
          summaries.push({
            page: pageNum,
            status: "text",
            charCount: pageText.length,
            truncated: true,
          });
          continue;
        }

        const pageTruncated = pageText.length > remaining;
        const body = pageTruncated
          ? `${pageText.slice(0, remaining)}\n[page ${pageNum} truncated]`
          : pageText;
        blocks.push(`${header}${body}`);
        returnedPages.push(pageNum);
        usedChars += header.length + body.length;
        if (pageTruncated) charCapped = true;
        summaries.push({
          page: pageNum,
          status: "text",
          charCount: pageText.length,
          ...(pageTruncated ? { truncated: true } : {}),
        });
      }
    }

    const lastReturned =
      returnedPages.length > 0 ? returnedPages[returnedPages.length - 1]! : 0;
    const hasMorePages =
      charCapped || truncatedSpec || lastInspectedPage < totalPages;
    const nextPage =
      charCapped && lastReturned > 0 && lastReturned < totalPages
        ? lastReturned + 1
        : lastInspectedPage < totalPages
          ? lastInspectedPage + 1
          : undefined;

    const statusNotes: string[] = [];
    if (query && matchedPages.length === 0) {
      statusNotes.push(
        `No text pages matched "${query}" within inspected pages (${pagesToInspect[0]}–${pagesToInspect[pagesToInspect.length - 1]} of ${totalPages}).`,
      );
      if (noMatchPages.length > 0) {
        statusNotes.push(
          `Text pages without match (${noMatchPages.length}): ${noMatchPages.join(", ")}.`,
        );
      }
      if (imageOnlyPages.length > 0) {
        statusNotes.push(
          `Image-only pages with no selectable text layer (${imageOnlyPages.length}): ${imageOnlyPages.join(", ")}.`,
        );
      }
      if (blankPages.length > 0) {
        statusNotes.push(`Blank pages (${blankPages.length}): ${blankPages.join(", ")}.`);
      }
    } else if (imageOnlyPages.length > 0 && query) {
      statusNotes.push(
        `Note: image-only pages without selectable text could not be searched: ${imageOnlyPages.join(", ")}.`,
      );
    }

    const safeUrl = finalUrl.replaceAll('"', "&quot;");
    const safeTitle = title.replaceAll('"', "&quot;");
    const returnedAttr =
      returnedPages.length > 0 ? returnedPages.join(",") : "none";
    const untrustedLines = [
      `<untrusted_web_page url="${safeUrl}"${safeTitle ? ` title="${safeTitle}"` : ""} content_type="application/pdf" total_pages="${totalPages}" pages_returned="${returnedAttr}">`,
      ...(blocks.length > 0 ? [blocks.join("\n\n")] : []),
      ...(statusNotes.length > 0 ? [statusNotes.join("\n")] : []),
      ...(hasMorePages
        ? [
            `[truncated — total_pages=${totalPages}${nextPage ? `; call web_read with pages="${nextPage}-${Math.min(totalPages, nextPage + 7)}" to inspect further` : ""}]`,
          ]
        : []),
      `</untrusted_web_page>`,
    ];

    return {
      url: rawUrl,
      finalUrl,
      title,
      contentType: "application/pdf",
      truncated: hasMorePages,
      untrustedBlock: untrustedLines.join("\n"),
      pdf: {
        totalPages,
        inspectedPages: pagesToInspect,
        returnedPages,
        imageOnlyPages,
        blankPages,
        noMatchPages,
        ...(query ? { matchedPages, query } : {}),
        hasMorePages,
        ...(nextPage !== undefined ? { nextPage } : {}),
        pages: summaries,
      },
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/**
 * Hardened public HTTPS page & PDF reader with SSRF protection, manual redirect validation,
 * byte/time caps, page-labelled PDF extraction, and untrusted-data XML delimiters.
 */
export async function readWebPage(
  rawUrl: string,
  options?: WebReadOptions,
): Promise<WebReadOutput> {
  let currentUrl = validateSafePublicUrl(rawUrl);
  let response: Response | null = null;
  const looksLikeLargeDoc =
    currentUrl.pathname.toLowerCase().endsWith(".pdf") ||
    currentUrl.pathname.toLowerCase().endsWith(".csv") ||
    currentUrl.pathname.toLowerCase().endsWith(".tsv") ||
    currentUrl.pathname.toLowerCase().endsWith(".zip") ||
    Boolean(
      options?.pages ||
        options?.query ||
        options?.charOffset !== undefined ||
        options?.zipMember ||
        options?.filterColumn ||
        options?.filterValue !== undefined ||
        options?.rowOffset !== undefined,
    );

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(currentUrl.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": "BlueSignalAgent/1.0 (+https://blue-forum.local)",
        Accept:
          "text/html,text/csv,text/tab-separated-values,application/zip,application/pdf,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1",
      },
      signal: AbortSignal.timeout(
        looksLikeLargeDoc ? PDF_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS,
      ),
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

  const isExplicitPdf = rawContentType === "application/pdf";
  const pathLower = currentUrl.pathname.toLowerCase();
  const isPotentialPdfOctet =
    (rawContentType === "application/octet-stream" ||
      rawContentType === "binary/octet-stream") &&
    pathLower.endsWith(".pdf");

  if (isExplicitPdf || isPotentialPdfOctet) {
    const contentLengthHeader = response.headers.get("Content-Length");
    if (contentLengthHeader && /^\d+$/.test(contentLengthHeader)) {
      const reportedBytes = Number(contentLengthHeader);
      if (reportedBytes > MAX_PDF_READ_BYTES) {
        const mb = (reportedBytes / (1024 * 1024)).toFixed(1);
        throw new Error(
          `PDF exceeds maximum allowed size (${MAX_PDF_READ_BYTES / (1024 * 1024)} MB; server reported ${mb} MB).`,
        );
      }
    }

    const { bytes, capped } = await readBytesCapped(response, MAX_PDF_READ_BYTES);
    if (capped) {
      throw new Error(
        `PDF exceeds maximum allowed size (${MAX_PDF_READ_BYTES / (1024 * 1024)} MB).`,
      );
    }
    if (!hasPdfMagicHeader(bytes)) {
      throw new Error(
        "Response declared PDF/binary content but does not contain a valid %PDF header.",
      );
    }
    return extractPdfPages(bytes, rawUrl, currentUrl.toString(), options);
  }

  const isExplicitZip = ALLOWED_ZIP_CONTENT_TYPES.some(
    (allowed) => rawContentType === allowed,
  );
  const isPotentialZipOctet =
    (rawContentType === "application/octet-stream" ||
      rawContentType === "binary/octet-stream") &&
    pathLower.endsWith(".zip");

  if (isExplicitZip || isPotentialZipOctet) {
    const contentLengthHeader = response.headers.get("Content-Length");
    if (contentLengthHeader && /^\d+$/.test(contentLengthHeader)) {
      const reportedBytes = Number(contentLengthHeader);
      if (reportedBytes > MAX_ZIP_READ_BYTES) {
        const mb = (reportedBytes / (1024 * 1024)).toFixed(1);
        throw new Error(
          `ZIP archive exceeds maximum compressed size (${MAX_ZIP_READ_BYTES / (1024 * 1024)} MB; server reported ${mb} MB).`,
        );
      }
    }

    const { bytes, capped } = await readBytesCapped(response, MAX_ZIP_READ_BYTES);
    if (capped) {
      throw new Error(
        `ZIP archive exceeds maximum compressed size (${MAX_ZIP_READ_BYTES / (1024 * 1024)} MB).`,
      );
    }
    if (!hasZipMagicHeader(bytes)) {
      throw new Error(
        "Response declared ZIP/binary content but does not contain a valid PK ZIP header.",
      );
    }
    return extractZipCsvOrListing(bytes, rawUrl, currentUrl.toString(), options);
  }

  const isExplicitCsv = ALLOWED_CSV_CONTENT_TYPES.some(
    (allowed) => rawContentType === allowed,
  );
  const isUrlCsvWithGenericType =
    (pathLower.endsWith(".csv") || pathLower.endsWith(".tsv")) &&
    (rawContentType === "text/plain" ||
      rawContentType === "application/octet-stream" ||
      rawContentType === "binary/octet-stream" ||
      rawContentType === "application/vnd.ms-excel");

  if (isExplicitCsv || isUrlCsvWithGenericType) {
    const { bytes, capped } = await readBytesCapped(response, MAX_CSV_READ_BYTES);
    const effectiveType = isExplicitCsv
      ? rawContentType
      : pathLower.endsWith(".tsv")
        ? "text/tab-separated-values"
        : "text/csv";
    return extractCsvRows(
      bytes,
      capped,
      rawUrl,
      currentUrl.toString(),
      effectiveType,
      options,
    );
  }

  if (
    !ALLOWED_TEXT_CONTENT_TYPES.some((allowed) => rawContentType === allowed)
  ) {
    throw new Error(`Unsupported Content-Type: ${rawContentType}`);
  }

  const { bytes, capped } = await readBytesCapped(response, MAX_READ_BYTES);
  // Some misconfigured servers serve PDFs with text/plain header; catch via %PDF- magic bytes
  if (!capped && hasPdfMagicHeader(bytes)) {
    return extractPdfPages(bytes, rawUrl, currentUrl.toString(), options);
  }

  const rawBody = new TextDecoder("utf-8").decode(bytes);
  const { title, text } = extractReadableText(rawBody, rawContentType);
  const pdfLinks = rawContentType.includes("html")
    ? extractPdfLinksFromHtml(rawBody, currentUrl)
    : [];
  const csvLinks = rawContentType.includes("html")
    ? extractCsvLinksFromHtml(rawBody, currentUrl)
    : [];
  const zipLinks = rawContentType.includes("html")
    ? extractZipLinksFromHtml(rawBody, currentUrl)
    : [];

  const sliced = extractTextWindowOrQuery(text, capped, {
    query: options?.query,
    charOffset: options?.charOffset,
  });

  const safeUrl = currentUrl.toString().replaceAll('"', "&quot;");
  const safeTitle = title.replaceAll('"', "&quot;");
  const pdfLinkBlock =
    pdfLinks.length > 0
      ? [
          "",
          "Linked PDFs on this page (you can pass these directly to web_read):",
          ...pdfLinks.map((l, i) => `${i + 1}. ${l.title} — ${l.url}`),
        ].join("\n")
      : "";
  const csvLinkBlock =
    csvLinks.length > 0
      ? [
          "",
          "Linked CSV/TSV files on this page (you can pass these directly to web_read):",
          ...csvLinks.map((l, i) => `${i + 1}. ${l.title} — ${l.url}`),
        ].join("\n")
      : "";
  const zipLinkBlock =
    zipLinks.length > 0
      ? [
          "",
          "Linked ZIP archives on this page (you can pass these directly to web_read):",
          ...zipLinks.map((l, i) => `${i + 1}. ${l.title} — ${l.url}`),
        ].join("\n")
      : "";

  const truncNote =
    !sliced.meta.query && sliced.meta.hasMoreChars && sliced.meta.nextCharOffset !== undefined
      ? `\n[truncated — showing chars ${sliced.meta.charOffset}–${sliced.meta.charOffset + sliced.meta.returnedChars} of ${sliced.meta.totalChars}${capped ? "; raw page exceeded 2 MB cap" : ""}; pass char_offset=${sliced.meta.nextCharOffset} to continue or query="..." to search the full page]`
      : !sliced.meta.query && capped
        ? `\n[note — raw page exceeded 2 MB byte cap; total_chars extracted=${sliced.meta.totalChars}]`
        : "";

  const queryAttr = sliced.meta.query
    ? ` query="${sliced.meta.query.replaceAll('"', "&quot;")}" matches="${sliced.meta.totalMatches ?? 0}"`
    : "";
  const untrustedBlock = [
    `<untrusted_web_page url="${safeUrl}"${safeTitle ? ` title="${safeTitle}"` : ""} total_chars="${sliced.meta.totalChars}" char_offset="${sliced.meta.charOffset}" returned_chars="${sliced.meta.returnedChars}"${queryAttr}>`,
    sliced.bodyText || "(no readable text extracted)",
    pdfLinkBlock,
    csvLinkBlock,
    zipLinkBlock,
    truncNote,
    `</untrusted_web_page>`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url: rawUrl,
    finalUrl: currentUrl.toString(),
    title,
    contentType: rawContentType,
    truncated: sliced.truncated,
    untrustedBlock,
    text: sliced.meta,
    ...(pdfLinks.length > 0 ? { pdfLinks } : {}),
    ...(csvLinks.length > 0 ? { csvLinks } : {}),
    ...(zipLinks.length > 0 ? { zipLinks } : {}),
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

// ——— Serendipity / External Discovery (no API keys required) ———

const DISCOVERY_USER_AGENT = "BlueSignalForum/1.0 (autonomous-research-reader)";

function formatUntrustedDiscoveryBlock(item: {
  source: DiscoverResolvedSource;
  title: string;
  url: string;
  summary: string;
  meta?: Record<string, string | number>;
}): string {
  const safeUrl = item.url.replaceAll('"', "&quot;");
  const safeTitle = item.title.replaceAll('"', "&quot;");
  const lines = [
    `<untrusted_discovery source="${item.source}" title="${safeTitle}" url="${safeUrl}">`,
    item.title,
    `URL: ${item.url}`,
  ];
  if (item.meta) {
    const metaParts = Object.entries(item.meta)
      .filter(([, v]) => v !== "" && v !== undefined)
      .map(([k, v]) => `${k}: ${v}`);
    if (metaParts.length > 0) {
      lines.push(metaParts.join(" · "));
    }
  }
  lines.push("", item.summary.slice(0, 1200), "</untrusted_discovery>");
  return lines.join("\n");
}

async function fetchRandomWikipedia(): Promise<DiscoverRandomOutput> {
  let lastCandidate: DiscoverRandomOutput | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(
      "https://en.wikipedia.org/api/rest_v1/page/random/summary",
      {
        headers: {
          "User-Agent": DISCOVERY_USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Wikipedia random summary HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      type?: string;
      title?: string;
      description?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };

    const title = (data.title || "").trim().slice(0, 180);
    const url = (data.content_urls?.desktop?.page || "").trim();
    const extract = (data.extract || "").trim().slice(0, 1000);
    if (!title || !url) continue;

    const meta: Record<string, string | number> = {};
    if (data.description) meta.description = data.description.trim().slice(0, 180);

    const out: DiscoverRandomOutput = {
      source: "wikipedia",
      title,
      url,
      summary: extract || "(no summary extract available)",
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      untrustedBlock: formatUntrustedDiscoveryBlock({
        source: "wikipedia",
        title,
        url,
        summary: extract || "(no summary extract available)",
        meta,
      }),
    };
    lastCandidate = out;
    if (data.type !== "disambiguation" && extract.length >= 60) {
      return out;
    }
  }

  if (lastCandidate) return lastCandidate;
  throw new Error("Wikipedia returned no usable random summary.");
}

async function fetchRandomOnThisDay(): Promise<DiscoverRandomOutput> {
  const now = new Date();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const res = await fetch(
    `https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected/${mm}/${dd}`,
    {
      headers: {
        "User-Agent": DISCOVERY_USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Wikipedia On This Day HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    selected?: Array<{
      year?: number;
      text?: string;
      pages?: Array<{
        title?: string;
        normalizedtitle?: string;
        extract?: string;
        content_urls?: { desktop?: { page?: string } };
      }>;
    }>;
  };

  const events = (data.selected || []).filter((e) => Boolean(e.text));
  if (events.length === 0) {
    throw new Error("No On This Day events returned.");
  }

  const chosen = events[Math.floor(Math.random() * events.length)]!;
  const primaryPage = chosen.pages?.find((p) => p.content_urls?.desktop?.page);
  const year = typeof chosen.year === "number" ? chosen.year : undefined;
  const pageTitle = primaryPage?.normalizedtitle || primaryPage?.title || "";
  const title = year !== undefined
    ? `${mm}-${dd} (${year}): ${pageTitle || chosen.text!.slice(0, 90)}`
    : pageTitle || chosen.text!.slice(0, 90);
  const url =
    primaryPage?.content_urls?.desktop?.page ||
    `https://en.wikipedia.org/wiki/${mm}_${dd}`;
  const summaryParts = [chosen.text!.trim()];
  if (primaryPage?.extract) {
    summaryParts.push(primaryPage.extract.trim().slice(0, 600));
  }
  const summary = summaryParts.join("\n\n").slice(0, 1000);
  const meta: Record<string, string | number> = {
    date: `${mm}-${dd}`,
    ...(year !== undefined ? { year } : {}),
  };

  return {
    source: "on_this_day",
    title: title.slice(0, 180),
    url,
    summary,
    meta,
    untrustedBlock: formatUntrustedDiscoveryBlock({
      source: "on_this_day",
      title: title.slice(0, 180),
      url,
      summary,
      meta,
    }),
  };
}

const ARXIV_CATEGORIES = [
  "cs.AI",
  "cs.CY",
  "cs.SI",
  "cs.CL",
  "q-bio.NC",
  "q-bio.PE",
  "physics.soc-ph",
  "econ.TH",
  "math.HO",
  "astro-ph.EP",
  "nlin.AO",
  "stat.AP",
];

async function fetchRandomArxiv(): Promise<DiscoverRandomOutput> {
  const category =
    ARXIV_CATEGORIES[Math.floor(Math.random() * ARXIV_CATEGORIES.length)]!;
  const start = Math.floor(Math.random() * 50);
  const queryUrl = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(category)}&start=${start}&max_results=1&sortBy=submittedDate&sortOrder=descending`;

  const res = await fetch(queryUrl, {
    headers: {
      "User-Agent": DISCOVERY_USER_AGENT,
      Accept: "application/atom+xml,application/xml;q=0.9,*/*;q=0.1",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`arXiv API HTTP ${res.status}`);
  }
  const xml = await res.text();
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!entryMatch) {
    throw new Error(`arXiv returned no entry for ${category}.`);
  }
  const entry = entryMatch[1]!;

  const extractTag = (tag: string): string => {
    const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return m ? decodeHtmlEntities(m[1]!.replace(/\s+/g, " ").trim()) : "";
  };

  const title = extractTag("title").slice(0, 180);
  const summary = extractTag("summary").slice(0, 1000);
  const rawId = extractTag("id");
  const published = extractTag("published").slice(0, 10);
  const authors = Array.from(
    entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi),
  )
    .map((m) => decodeHtmlEntities(m[1]!.replace(/\s+/g, " ").trim()))
    .slice(0, 4);

  if (!title || !rawId) {
    throw new Error("Could not parse arXiv entry.");
  }

  const absUrl = rawId.replace(/^http:\/\//i, "https://");
  const pdfUrl = absUrl.includes("/abs/")
    ? `${absUrl.replace("/abs/", "/pdf/")}.pdf`
    : "";

  const meta: Record<string, string | number> = {
    category,
    ...(published ? { published } : {}),
    ...(authors.length > 0 ? { authors: authors.join(", ") } : {}),
    ...(pdfUrl ? { pdfUrl } : {}),
  };

  return {
    source: "arxiv",
    title,
    url: absUrl,
    summary: summary || "(no abstract)",
    meta,
    untrustedBlock: formatUntrustedDiscoveryBlock({
      source: "arxiv",
      title,
      url: absUrl,
      summary: summary || "(no abstract)",
      meta,
    }),
  };
}

async function fetchRandomHackerNews(): Promise<DiscoverRandomOutput> {
  const listRes = await fetch(
    "https://hacker-news.firebaseio.com/v0/topstories.json",
    {
      headers: { "User-Agent": DISCOVERY_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!listRes.ok) {
    throw new Error(`Hacker News topstories HTTP ${listRes.status}`);
  }
  const ids = (await listRes.json()) as number[];
  const pool = ids.slice(0, 60);
  if (pool.length === 0) {
    throw new Error("Hacker News returned empty topstories list.");
  }

  // Try up to 4 random stories from the top 60 to find one with a title + URL/text
  for (let attempt = 0; attempt < 4; attempt++) {
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    const itemRes = await fetch(
      `https://hacker-news.firebaseio.com/v0/item/${pick}.json`,
      {
        headers: { "User-Agent": DISCOVERY_USER_AGENT },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!itemRes.ok) continue;
    const item = (await itemRes.json()) as {
      id?: number;
      title?: string;
      url?: string;
      text?: string;
      score?: number;
      descendants?: number;
      by?: string;
      type?: string;
    } | null;
    if (!item?.title) continue;

    const commentsUrl = `https://news.ycombinator.com/item?id=${item.id ?? pick}`;
    const url = item.url?.startsWith("https://")
      ? item.url
      : commentsUrl;
    const cleanText = item.text
      ? decodeHtmlEntities(item.text.replace(/<[^>]+>/g, " "))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 900)
      : "";
    const summary =
      cleanText ||
      `Trending Hacker News story (${item.score ?? 0} points, ${item.descendants ?? 0} comments). Pass the URL to web_read if you want to read the article.`;
    const meta: Record<string, string | number> = {
      score: item.score ?? 0,
      comments: item.descendants ?? 0,
      discussionUrl: commentsUrl,
    };

    return {
      source: "hackernews",
      title: item.title.trim().slice(0, 180),
      url,
      summary,
      meta,
      untrustedBlock: formatUntrustedDiscoveryBlock({
        source: "hackernews",
        title: item.title.trim().slice(0, 180),
        url,
        summary,
        meta,
      }),
    };
  }

  throw new Error("Could not fetch a Hacker News story.");
}

/**
 * Fetch a random public external artifact (Wikipedia summary, On This Day history,
 * recent arXiv abstract, or Hacker News story) with automatic source fallback.
 */
export async function discoverRandom(
  requested: DiscoverSource = "any",
): Promise<DiscoverRandomOutput> {
  const allSources: DiscoverResolvedSource[] = [
    "wikipedia",
    "on_this_day",
    "arxiv",
    "hackernews",
  ];

  let order: DiscoverResolvedSource[];
  if (requested !== "any" && allSources.includes(requested)) {
    order = [requested, ...allSources.filter((s) => s !== requested)];
  } else {
    // Fisher-Yates shuffle
    order = allSources.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
  }

  const fetchers: Record<
    DiscoverResolvedSource,
    () => Promise<DiscoverRandomOutput>
  > = {
    wikipedia: fetchRandomWikipedia,
    on_this_day: fetchRandomOnThisDay,
    arxiv: fetchRandomArxiv,
    hackernews: fetchRandomHackerNews,
  };

  let lastErr: Error | null = null;
  for (const src of order) {
    try {
      return await fetchers[src]();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr ?? new Error("External discovery sources are temporarily unavailable.");
}
