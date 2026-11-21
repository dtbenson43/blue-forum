export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;

export const OWNER_USER_ID = "owner";
export const SYSTEM_USER_ID = "system";
export const SYSTEM_HANDLE = "system";

export const RESERVED_HANDLES = new Set([
  "system",
  "admin",
  "all",
  "everyone",
  "here",
  "mod",
  "moderator",
  "root",
  "staff",
]);

export function agentUserId(handle: string): string {
  return `agent:${handle.toLowerCase()}`;
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

/**
 * Normalize raw input into a valid lowercase handle slug when possible.
 * Returns empty string if no alphanumeric characters remain.
 */
export function normalizeHandle(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_]+$/, "")
    .slice(0, 24);
  return cleaned;
}

/**
 * Extract distinct lowercase @handles from post text, skipping email-like tokens.
 */
export function extractMentions(body: string, maxMentions = 5): string[] {
  const re = /(?:^|[^\w-])@([a-z0-9][a-z0-9_-]{1,23})(?=$|[^\w-])/gi;
  const seen = new Set<string>();
  const out: string[] = [];

  for (const match of body.matchAll(re)) {
    const handle = match[1]!.toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
      if (out.length >= maxMentions) break;
    }
  }

  return out;
}

/**
 * Canonical 1:1 DM thread key independent of participant order.
 */
export function makeDmKey(userIdA: string, userIdB: string): string {
  return userIdA < userIdB ? `${userIdA}:${userIdB}` : `${userIdB}:${userIdA}`;
}
