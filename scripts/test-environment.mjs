export const RUNTIME_WRITE_PATH_ENV_KEYS = Object.freeze([
  'XIAOBA_USER_DATA_DIR',
  'CATSCO_USER_DATA_DIR',
  'XIAOBA_ELECTRON_USER_DATA_DIR',
  'XIAOBA_RUNTIME_ROOT',
  'CATSCO_LOCAL_CONFIG_PATH',
  'CATSCO_CONFIG_PATH',
  'XIAOBA_CONFIG_PATH',
  'XIAOBA_SKILLS_DIR',
  'XIAOBA_BOT_DEFINITION_SIMULATED_CLOUD_DIR',
  'XIAOBA_TOOL_RESULT_ARTIFACT_DIR',
  'XIAOBA_PET_DATA_DIR',
  'XIAOBA_PROMPT_OVERRIDES_DIR',
  'CATSCO_PROMPT_OVERRIDES_DIR',
  'XIAOBA_PROMPT_TRACE_DIR',
]);

export function buildIsolatedTestEnvironment(
  source = process.env,
  options = {},
) {
  const env = { ...source };
  for (const key of RUNTIME_WRITE_PATH_ENV_KEYS) delete env[key];

  const homeDir = String(options.homeDir || '').trim();
  const tempDir = String(options.tempDir || '').trim();
  const appRoot = String(options.appRoot || '').trim();
  const dotenvPath = String(options.dotenvPath || '').trim();
  if (homeDir) {
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
  }
  if (tempDir) {
    env.TMPDIR = tempDir;
    env.TMP = tempDir;
    env.TEMP = tempDir;
  }
  if (appRoot) env.XIAOBA_APP_ROOT = appRoot;
  if (dotenvPath) env.DOTENV_CONFIG_PATH = dotenvPath;
  else delete env.DOTENV_CONFIG_PATH;
  env.NODE_ENV = 'test';
  env.XIAOBA_TEST_RUNNER = '1';
  return env;
}
