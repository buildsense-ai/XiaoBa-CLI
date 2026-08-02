import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export type RuntimeDataRootSource =
  | 'XIAOBA_USER_DATA_DIR'
  | 'CATSCO_USER_DATA_DIR'
  | 'XIAOBA_ELECTRON_USER_DATA_DIR'
  | 'XIAOBA_RUNTIME_ROOT'
  | 'test-workspace'
  | 'profile'
  | 'default';

export interface RuntimeDataRootResolution {
  path: string;
  source: RuntimeDataRootSource;
  profile: string;
}

const DEFAULT_PROFILE = 'default';
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class PathResolver {
  static resolveRuntimeDataRoot(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
    homeDir: string = os.homedir(),
  ): RuntimeDataRootResolution {
    const explicitCandidates: Array<[RuntimeDataRootSource, string | undefined]> = [
      ['XIAOBA_USER_DATA_DIR', env.XIAOBA_USER_DATA_DIR],
      ['CATSCO_USER_DATA_DIR', env.CATSCO_USER_DATA_DIR],
      ['XIAOBA_ELECTRON_USER_DATA_DIR', env.XIAOBA_ELECTRON_USER_DATA_DIR],
      // Legacy data-root compatibility only. Bundled executable discovery uses
      // XIAOBA_BUNDLED_EXECUTABLES_DIR and must not write this variable.
      ['XIAOBA_RUNTIME_ROOT', env.XIAOBA_RUNTIME_ROOT],
    ];
    const explicit = explicitCandidates.find(([, value]) => String(value || '').trim());
    const profile = normalizeProfileName(env.XIAOBA_PROFILE);
    const defaultRoot = path.join(path.resolve(homeDir), '.xiaoba');
    const testSandboxRoot = String(env.XIAOBA_TEST_SANDBOX_ROOT || '').trim();
    const runnerDefaultRoot = String(env.XIAOBA_TEST_DEFAULT_DATA_DIR || '').trim();
    const explicitIsRunnerDefault = Boolean(
      explicit
      && runnerDefaultRoot
      && path.resolve(String(explicit[1]).trim()) === path.resolve(runnerDefaultRoot),
    );
    const isolatedTestWorkspace = env.XIAOBA_TEST_RUNNER === '1'
      && testSandboxRoot
      && isPathInside(path.resolve(cwd), path.resolve(testSandboxRoot))
      && (!explicit || explicitIsRunnerDefault)
      ? path.resolve(cwd)
      : undefined;
    const resolution: RuntimeDataRootResolution = isolatedTestWorkspace
      ? { path: isolatedTestWorkspace, source: 'test-workspace', profile }
      : explicit
      ? {
        path: path.resolve(String(explicit[1]).trim()),
        source: explicit[0],
        profile,
      }
      : profile === DEFAULT_PROFILE
        ? { path: defaultRoot, source: 'default', profile }
        : { path: path.join(defaultRoot, 'profiles', profile), source: 'profile', profile };

    const allowedTestRoots = [
      path.resolve(os.tmpdir()),
      ...(testSandboxRoot ? [path.resolve(testSandboxRoot)] : []),
    ];

    if (
      env.NODE_TEST_CONTEXT
      && env.XIAOBA_ALLOW_NON_TEMP_TEST_RUNTIME_ROOT !== '1'
      && !allowedTestRoots.some(root => isPathInside(resolution.path, root))
    ) {
      throw new Error(
        `Refusing Node test runtime data root outside the OS temporary directory: ${resolution.path}`,
      );
    }

    return resolution;
  }

  static getRuntimeDataRoot(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
    homeDir: string = os.homedir(),
  ): string {
    return this.resolveRuntimeDataRoot(env, cwd, homeDir).path;
  }

  static getDataPath(...segments: string[]): string {
    return path.join(this.getRuntimeDataRoot(), 'data', ...segments);
  }

  static getLogsPath(...segments: string[]): string {
    return path.join(this.getRuntimeDataRoot(), 'logs', ...segments);
  }

  static getAttachmentsPath(...segments: string[]): string {
    return this.getDataPath('attachments', ...segments);
  }

  static getPromptOverridesPath(): string {
    return path.join(this.getRuntimeDataRoot(), 'prompt-overrides');
  }

  static getSkillsPath(): string {
    const override = process.env.XIAOBA_SKILLS_DIR?.trim();
    if (override) return path.resolve(override);
    return this.getUserDataSkillsPath();
  }

  static getUserDataSkillsPath(): string {
    return path.join(this.getRuntimeDataRoot(), 'skills');
  }

  static ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  static findSkillFiles(baseDir: string): string[] {
    const results: string[] = [];

    if (!fs.existsSync(baseDir)) {
      return results;
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        const skillFile = path.join(fullPath, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          results.push(skillFile);
        }
        results.push(...this.findSkillFiles(fullPath));
      }
    }

    return results;
  }
}

export function normalizeProfileName(value: string | undefined): string {
  const profile = String(value || '').trim() || DEFAULT_PROFILE;
  if (!PROFILE_PATTERN.test(profile) || profile === '.' || profile === '..') {
    throw new Error(
      'Invalid XiaoBa profile. Use 1-64 letters, numbers, dots, underscores, or hyphens; start with a letter or number.',
    );
  }
  return profile;
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(canonicalizeBoundaryPath(parent), canonicalizeBoundaryPath(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalizeBoundaryPath(value: string): string {
  const missingSegments: string[] = [];
  let cursor = path.resolve(value);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.join(fs.realpathSync(cursor), ...missingSegments);
  } catch {
    return path.resolve(value);
  }
}
