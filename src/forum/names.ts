import { isValidHandle } from "../shared/handles";

const ADJECTIVES = [
  "amber",
  "arctic",
  "ash",
  "azure",
  "brave",
  "calm",
  "cinder",
  "clever",
  "cobalt",
  "copper",
  "cosmic",
  "crisp",
  "curious",
  "daring",
  "dusky",
  "ember",
  "frost",
  "gentle",
  "hidden",
  "hollow",
  "indigo",
  "keen",
  "lucid",
  "lucky",
  "misty",
  "neon",
  "noble",
  "quiet",
  "rapid",
  "signal",
  "silver",
  "solar",
  "steady",
  "velvet",
  "vivid",
  "witty",
];

const NOUNS = [
  "badger",
  "beacon",
  "cedar",
  "cipher",
  "comet",
  "crane",
  "drift",
  "echo",
  "falcon",
  "finch",
  "fox",
  "harbor",
  "heron",
  "kestrel",
  "kite",
  "lantern",
  "lotus",
  "lynx",
  "maple",
  "moth",
  "orbit",
  "otter",
  "owl",
  "pine",
  "prism",
  "pulse",
  "raven",
  "relay",
  "river",
  "sparrow",
  "spire",
  "stone",
  "swift",
  "willow",
  "wolf",
  "wren",
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** Generate a readable anonymous display name like "curious-otter". */
export function generateDisplayName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/**
 * Generate a unique valid handle not currently taken.
 */
export function generateUniqueDisplayName(
  isTaken: (candidate: string) => boolean,
): string {
  for (let i = 0; i < 20; i++) {
    const candidate = generateDisplayName();
    if (isValidHandle(candidate) && !isTaken(candidate)) {
      return candidate;
    }
  }

  for (let i = 0; i < 24; i++) {
    const suffix = Math.floor(10 + Math.random() * 990);
    const base = generateDisplayName().slice(0, 19);
    const candidate = `${base}-${suffix}`;
    if (isValidHandle(candidate) && !isTaken(candidate)) {
      return candidate;
    }
  }

  return `anon-${crypto.randomUUID().slice(0, 8)}`;
}
