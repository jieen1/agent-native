/**
 * P4-B: Network Security Boundary — validation utilities for orchestrator V3.
 *
 * These are VALIDATION FUNCTIONS only. They do not enforce at runtime;
 * the callers (NodeRunner, executor dispatch, etc.) are responsible for
 * invoking them and acting on the result.
 *
 * All allowlists / timeouts are configurable via environment variables so
 * each deployment can tighten or relax the policy without code changes.
 */

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Bash commands that are NEVER allowed inside a microVM sandbox.
 * Covers privilege escalation, host escape, and destructive ops.
 */
export const DISABLED_COMMANDS: readonly string[] = [
  // Privilege escalation
  "sudo",
  "su",
  "pkexec",
  "doas",
  // Host / container escape
  "nsenter",
  "chroot",
  "unshare",
  "mount",
  "umount",
  "pivot_root",
  "chroot",
  // Kernel / low-level
  "insmod",
  "rmmod",
  "modprobe",
  "kexec",
  // Dangerous process control
  "kill",
  "killall",
  "pkill",
  "reboot",
  "shutdown",
  "halt",
  // Package / system managers
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "apk",
  // Disk / partition
  "fdisk",
  "mkfs",
  "dd",
  "parted",
  // Network control
  "iptables",
  "ip6tables",
  "nft",
  "ufw",
  "firewall-cmd",
  "ifconfig",
  "iwconfig",
  "arp",
  // Other destructive
  "rm -rf /",
  "mkswap",
  "swapoff",
  "swapon",
].sort();

/**
 * Parse ORCHESTRATOR_ALLOWED_DOMAINS (comma-separated env var).
 * Falls back to safe defaults when unset.
 */
function parseDomainList(): Set<string> {
  const raw = process.env.ORCHESTRATOR_ALLOWED_DOMAINS;
  if (!raw) {
    return new Set([
      // AI model providers
      "api.anthropic.com",
      "openai.com",
      "api.openai.com",
      "ai.google.dev",
      "generativelanguage.googleapis.com",
      "gateway.ai.cloudflare.com",
      // Git hosting
      "github.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
      "gitlab.com",
      // microsandbox / VM runtime
      "api.microsandbox.sh",
      // Package registries
      "registry.npmjs.org",
      "pnpm.io",
      "registry.yarnpkg.com",
      // NuGet / pip (common in polyglot workspaces)
      "pypi.org",
      "files.pythonhosted.org",
    ]);
  }
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
  );
}

export const ALLOWED_DOMAINS = parseDomainList();

/**
 * Default HTTP timeout in milliseconds.  Overridable via env.
 */
export const DEFAULT_TIMEOUT_MS = Number(
  process.env.ORCHESTRATOR_DEFAULT_TIMEOUT_MS ?? "300000",
);

/* ------------------------------------------------------------------ */
/*  URL Allowlist                                                      */
/* ------------------------------------------------------------------ */

/**
 * Check whether a URL is permitted by the network allowlist.
 *
 * Returns `true` when the URL hostname matches ALLOWED_DOMAINS or when the
 * URL uses the `file:` scheme (local reads never leave the sandbox).
 *
 * This is a **validation function**.  The caller decides what to do
 * when it returns `false` (reject, log, fall back, etc.).
 */
export function isNetworkAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Allow local file access
    if (parsed.protocol === "file:") return true;

    // Require HTTP(S)
    if (!/^https?:$/.test(parsed.protocol)) return false;

    // Missing hostname (e.g. "http:///foo")
    if (!parsed.hostname) return false;

    // Exact match first
    if (ALLOWED_DOMAINS.has(parsed.hostname)) return true;

    // Subdomain wildcard: if the allowlist contains "example.com",
    // "api.example.com" is also permitted.
    for (const domain of ALLOWED_DOMAINS) {
      if (
        domain !== parsed.hostname &&
        parsed.hostname.endsWith(`.${domain}`)
      ) {
        return true;
      }
    }

    return false;
  } catch {
    // Malformed URL
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Bash Command Validation                                            */
/* ------------------------------------------------------------------ */

/**
 * Check whether a bash command is permitted inside the sandbox.
 *
 * The check parses the base command (first token, stripped of flags) and
 * rejects it if it appears in DISABLED_COMMANDS.  It also rejects commands
 * that contain obvious injection patterns (pipes to shell, redirects to
 * device files, background chains with ampersands).
 *
 * This is a **validation function** — it provides best-effort detection.
 * It is NOT a complete sandbox enforcement layer.
 */
export function isToolCommandAllowed(command: string): boolean {
  if (!command || typeof command !== "string") return false;

  const trimmed = command.trim();

  // Reject empty after trim
  if (trimmed.length === 0) return false;

  // Obvious injection / escape patterns
  const injectionPatterns = [
    /;\s*\w+/, // command chaining with semicolon
    /\|\s*(sudo|su)/, // pipe to privilege escalation
    />\s*\/dev\//, // redirect to device
    /2>&1\s*;/, // suppress errors before chain
    /\$\(/, // command substitution
    /`[^`]+`/, // backtick command substitution
    /&&\s*(sudo|su|rm)/, // AND-chain to dangerous cmd
    /\|\|/, // OR-chain (too easy to hide a bad cmd)
  ];

  if (injectionPatterns.some((re) => re.test(trimmed))) return false;

  // Extract the base command (first word, strip leading flags like `sudo`)
  const tokens = trimmed.split(/\s+/);
  const baseCommand = tokens[0].toLowerCase();

  // Check against disabled list
  if (DISABLED_COMMANDS.includes(baseCommand)) return false;

  // Also check if any token is a disabled command (catches `git sudo push`)
  for (const token of tokens) {
    const clean = token.toLowerCase();
    // Skip flags, paths, quoted strings, arguments
    if (
      clean.startsWith("-") ||
      clean.startsWith("'") ||
      clean.startsWith('"') ||
      clean.endsWith(":") || // port
      /^\d+$/.test(clean) || // numeric
      clean.includes("/")
    ) {
      continue;
    }
    if (DISABLED_COMMANDS.includes(clean)) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/*  Symlink Safety                                                     */
/* ------------------------------------------------------------------ */

/**
 * Check whether a path is safe relative to the sandbox working directory.
 *
 * The orchestrator sandbox uses `/work` as the root working directory.
 * This function detects symlink escape attempts by resolving the
 * canonical path and verifying it still starts with `/work`.
 *
 * IMPORTANT: This function performs a string-based check on the resolved
 * real path.  On the actual sandbox host, `fs.realpath()` (or the
 * microVM equivalent) must be called to resolve symlinks at the
 * filesystem level.  This is a **validation function** — the caller
 * (NodeRunner, mount setup) is responsible for real filesystem resolution.
 *
 * @param path - The path to check (absolute or relative).
 * @param workRoot - The sandbox root; defaults to "/work".
 */
export function isSymlinkSafe(
  path: string,
  workRoot: string = "/work",
): boolean {
  if (!path || typeof path !== "string") return false;

  // Normalize: collapse double-slashes, resolve . and ..
  const normalized = normalizePath(path, workRoot);

  // The normalized path must start with the work root
  const cleanRoot = workRoot.endsWith("/") ? workRoot : `${workRoot}/`;
  return normalized === workRoot || normalized.startsWith(cleanRoot);
}

/**
 * Resolve a path by collapsing `.` and `..` segments.
 * This is a pure string operation; it does NOT resolve symlinks on disk.
 * The caller must use `fs.realpath()` for actual symlink resolution.
 */
function normalizePath(path: string, baseRoot: string): string {
  // Make absolute if relative
  const absolute = path.startsWith("/") ? path : `${baseRoot}/${path}`;

  const parts = absolute.split("/").filter(Boolean);
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      // Allow going up, but we'll check the result
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return `/${resolved.join("/")}` || "/";
}
