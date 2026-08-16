/**
 * Least-privilege environment for xurl subprocess invocation.
 *
 * xurl is an external CLI that reads Codex/Pi history. It must NOT receive
 * unrelated XiaoBa/model/CatsCo secrets through the inherited parent
 * environment. This module builds a minimal, allowlisted environment that
 * preserves required OS-essential variables across macOS, Linux, and Windows
 * while scrubbing every other variable — including all XiaoBa-prefixed
 * configuration, which is parent-side state that the xurl child does not need.
 *
 * Design: allowlist, not denylist. Only explicitly named OS essentials survive.
 * All API keys, tokens, credentials, application secrets, execution-control
 * variables (NODE_OPTIONS, NODE_PATH), and parent-only XiaoBa configuration
 * are excluded by default because they are not in the allowlist.
 *
 * Trust boundary
 * --------------
 * The boundary is the xurl child process. The allowlist is derived from what
 * an external CLI needs to execute and resolve files across supported
 * platforms: PATH for executable lookup, HOME/USERPROFILE for session-log
 * discovery, temp dirs, locale/encoding, and Windows system directories.
 *
 * Variables removed by design (not OS essentials for xurl):
 *   - NODE_OPTIONS, NODE_PATH — execution control; can inject code or modules
 *     into a Node-based wrapper and are not OS essentials.
 *   - SHLVL, PWD, OLDPWD, SHELL — shell bookkeeping; xurl is invoked directly,
 *     not through an interactive shell, and does not need the parent's CWD.
 *   - TERM, TERM_PROGRAM, COLORTERM, NO_COLOR, FORCE_COLOR — terminal/color
 *     control; xurl output is parsed programmatically, so color is not needed
 *     and color codes would be harmful to the parser.
 *   - XIAOBA_* (all prefixes) — parent-only XiaoBa configuration
 *     (XIAOBA_EXTERNAL_SESSION_LOG_XURL_COMMAND, XIAOBA_RUNTIME_ROOT,
 *     XIAOBA_RUNTIME_SHIM_DIR, activation-limit overrides, etc.). These are
 *     read by the parent process (XurlOfficialRunner / resolveActivationLimit)
 *     from process.env, never by the xurl child. Passing them to the child
 *     leaks parent configuration without evidence of child need.
 *
 * Escape hatch
 * -----------
 * Callers that need to pass additional variables to xurl can set them via the
 * explicit `env` option on XurlExternalSourceReader / XurlExternalBackfillSource
 * / getXurlVersion. When a caller provides an explicit env, this builder is
 * bypassed entirely. An explicit env is an internal/test override; it is NOT
 * automatically a safe operator boundary. Operators who need to inject
 * variables must do so through the explicit env option, not by relying on
 * prefix-based passthrough.
 */

// ---------------------------------------------------------------------------
// OS-essential allowlist (cross-platform)
// ---------------------------------------------------------------------------

/**
 * Exact-match OS-essential variable names. These are required for process
 * execution, file-system access, and locale resolution. None of them carry
 * application secrets or execution-control semantics.
 */
const OS_ESSENTIAL_EXACT: ReadonlySet<string> = new Set([
  // Path resolution
  'PATH',
  'Path', // Windows case variant
  // Home / user profile
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  // Temp directories
  'TMP',
  'TEMP',
  'TMPDIR',
  // Shell (Windows)
  'COMSPEC',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  // Locale / encoding
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_TIME',
  'LC_NUMERIC',
  'LC_MONETARY',
  // Process / platform identity
  'USER',
  'LOGNAME',
  'USERNAME',
]);

/**
 * Defense-in-depth: even if a variable matches the allowlist, reject it when
 * its name contains secret-like terms. This catches edge cases where an
 * allowlisted name is combined with a secret suffix.
 */
const SECRET_NAME_RE =
  /(?:^|_)(secret|password|passwd|credential|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key)(?:_|$)/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a least-privilege environment for xurl subprocess invocation.
 *
 * Copies only OS-essential variables from `baseEnv`. All other variables —
 * including API keys, model tokens, CatsCo secrets, execution-control
 * variables (NODE_OPTIONS, NODE_PATH), and all XiaoBa-prefixed parent
 * configuration — are excluded.
 *
 * @param baseEnv - The parent process environment to filter (defaults to
 *   `process.env`).
 * @returns A new environment object containing only allowlisted variables.
 */
export function buildXurlSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!isAllowedEnvKey(key)) continue;
    env[key] = value;
  }

  return env;
}

/**
 * Test whether a single environment variable name is allowed in the xurl
 * subprocess environment. Exported for adversarial regression tests.
 */
export function isAllowedEnvKey(key: string): boolean {
  // Defense-in-depth: reject secret-like names even if they match the allowlist.
  if (SECRET_NAME_RE.test(key)) return false;

  // Exact-match OS essentials only. No prefix allowlisting: XiaoBa-prefixed
  // variables are parent-only configuration, not child-runtime requirements.
  return OS_ESSENTIAL_EXACT.has(key);
}

/**
 * Diagnostic summary of the least-privilege policy. Used by security
 * diagnostics and tests to verify the allowlist contents.
 */
export function getXurlSubprocessEnvPolicy(): {
  readonly osEssentialExact: readonly string[];
} {
  return {
    osEssentialExact: [...OS_ESSENTIAL_EXACT].sort(),
  };
}