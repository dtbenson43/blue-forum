export const OWNER_COOKIE = "bf_owner";
export const OWNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const TOKEN_VERSION = "v1";
const SIGNING_DOMAIN = "blue-forum-owner-session-v1";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`${SIGNING_DOMAIN}:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Constant-time passphrase comparison using fixed-length SHA-256 digests.
 */
export async function verifyPassphrase(
  candidate: string,
  expected: string,
): Promise<boolean> {
  if (!candidate || !expected) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}

export async function createOwnerToken(ownerKey: string): Promise<string> {
  const issuedAtSec = Math.floor(Date.now() / 1000);
  const payload = `${TOKEN_VERSION}.${issuedAtSec}`;
  const key = await importHmacKey(ownerKey);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
  return `${payload}.${toHex(sig)}`;
}

export async function verifyOwnerToken(
  token: string | undefined,
  ownerKey: string | undefined,
): Promise<boolean> {
  if (!token || !ownerKey) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, issuedStr, sigHex] = parts;
  if (version !== TOKEN_VERSION) return false;

  const issuedAtSec = Number(issuedStr);
  if (!Number.isInteger(issuedAtSec)) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (issuedAtSec > nowSec + 300 || nowSec - issuedAtSec > OWNER_COOKIE_MAX_AGE) {
    return false;
  }

  const sigBytes = fromHex(sigHex!);
  if (!sigBytes) return false;

  const key = await importHmacKey(ownerKey);
  const payload = `${version}.${issuedStr}`;
  return crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    encoder.encode(payload),
  );
}

export function buildOwnerCookie(token: string, secure: boolean): string {
  return [
    `${OWNER_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${OWNER_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearOwnerCookie(secure: boolean): string {
  return [
    `${OWNER_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
