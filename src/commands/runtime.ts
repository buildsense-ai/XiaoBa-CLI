import { Logger } from '../utils/logger';
import { formatRuntimeSummary, resolveRuntimeEnvironment } from '../utils/runtime-environment';

export async function runtimeCommand(): Promise<void> {
  const runtimeEnvironment = resolveRuntimeEnvironment({
    env: process.env,
  });

  Logger.title('Runtime Diagnostics');

  if (runtimeEnvironment.bundledExecutablesDir) {
    Logger.info(`Bundled executables: ${runtimeEnvironment.bundledExecutablesDir}`);
  } else {
    Logger.warning('Bundled executables: not detected');
  }

  if (runtimeEnvironment.shimDirectory) {
    Logger.info(`Runtime shim directory: ${runtimeEnvironment.shimDirectory}`);
  } else {
    Logger.info('Runtime shim directory: none');
  }

  if (runtimeEnvironment.prependedPaths.length > 0) {
    Logger.info(`Prepended PATH entries: ${runtimeEnvironment.prependedPaths.join(', ')}`);
  } else {
    Logger.info('Prepended PATH entries: none');
  }

  for (const name of ['node', 'python', 'git', 'xurl'] as const) {
    const binary = runtimeEnvironment.binaries[name];
    if (binary.executable) {
      Logger.text(formatRuntimeSummary(binary));
      continue;
    }

    Logger.warning(`${name}: missing`);
  }
}
