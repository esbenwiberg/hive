/**
 * Branch name generator for Hive tasks.
 *
 * Pattern: `{prefix}/{verb}-{animal}-{taskId}`
 * e.g.  `hive/golden-horse-HIVE-20250319-ab12`
 */

const VERBS = [
  "bold", "brave", "calm", "cool", "crisp", "deft", "eager", "fair",
  "fast", "firm", "glad", "gold", "grand", "green", "keen", "kind",
  "lean", "light", "live", "loud", "mild", "neat", "nice", "pale",
  "plain", "prime", "pure", "quick", "rare", "rich", "safe", "sharp",
  "slim", "smart", "soft", "solid", "stark", "still", "stout", "sure",
  "swift", "tall", "tame", "tidy", "tough", "true", "vast", "warm",
  "wide", "wild", "wise", "young", "able", "apt", "dry", "even",
  "flat", "full", "hot", "new",
] as const;

const ANIMALS = [
  "ant", "ape", "bat", "bear", "bee", "bird", "boar", "bull",
  "calf", "cat", "clam", "cod", "colt", "cow", "crab", "crow",
  "deer", "dog", "dove", "duck", "eagle", "eel", "elk", "ewe",
  "fish", "fly", "fox", "frog", "goat", "gull", "hare", "hawk",
  "hen", "hog", "horse", "jay", "kite", "lark", "lion", "lynx",
  "mare", "mink", "mole", "moth", "mule", "newt", "orca", "otter",
  "owl", "ox", "panda", "pike", "pony", "ram", "ray", "robin",
  "seal", "shark", "slug", "snail", "snake", "swan", "toad", "trout",
] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Validates a branch prefix: alphanumeric + hyphens, max 30 chars. */
export function isValidBranchPrefix(prefix: string): boolean {
  return /^[a-zA-Z0-9-]{1,30}$/.test(prefix);
}

/**
 * Generates a branch name in the format `{prefix}/{verb}-{animal}-{taskId}`.
 */
export function generateBranchName(prefix: string, taskId: string): string {
  const verb = pick(VERBS);
  const animal = pick(ANIMALS);
  return `${prefix}/${verb}-${animal}-${taskId}`;
}

/**
 * Generates a branch name, retrying up to `maxRetries` times if a branch
 * with that name already exists remotely.
 */
export async function generateBranchNameWithRetry(
  prefix: string,
  taskId: string,
  existsCheck: (name: string) => Promise<boolean>,
  maxRetries = 5,
): Promise<string> {
  for (let i = 0; i <= maxRetries; i++) {
    const name = generateBranchName(prefix, taskId);
    if (!(await existsCheck(name))) return name;
  }
  // Fallback: use a timestamp suffix to guarantee uniqueness
  const verb = pick(VERBS);
  const animal = pick(ANIMALS);
  return `${prefix}/${verb}-${animal}-${taskId}-${Date.now()}`;
}
