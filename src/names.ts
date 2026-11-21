const ADJECTIVES = [
  "amber",
  "brave",
  "calm",
  "clever",
  "cobalt",
  "cosmic",
  "curious",
  "daring",
  "ember",
  "gentle",
  "hidden",
  "keen",
  "lucky",
  "misty",
  "noble",
  "quiet",
  "rapid",
  "silver",
  "steady",
  "vivid",
  "witty",
  "zealous",
];

const NOUNS = [
  "badger",
  "beacon",
  "cedar",
  "crane",
  "falcon",
  "finch",
  "fox",
  "heron",
  "kite",
  "lotus",
  "lynx",
  "maple",
  "otter",
  "pine",
  "raven",
  "river",
  "sparrow",
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
