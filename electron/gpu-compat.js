'use strict';

// Decide whether the app should run without GPU-accelerated compositing.
//
// Default scope is intentionally narrow: only Intel Macs (darwin/x64), which
// are the ones hitting OCLP-patched macOS with legacy NVIDIA GPUs that crash
// the GPU process on launch. Windows, Linux and Apple Silicon keep hardware
// acceleration.
//
// An explicit XIAOBA_DISABLE_GPU=1 (or "true") environment override forces
// software rendering on every platform as a safe-mode escape hatch.
function shouldDisableHardwareAcceleration(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;

  if (env.XIAOBA_DISABLE_GPU === '1' || env.XIAOBA_DISABLE_GPU === 'true') {
    return true;
  }

  return platform === 'darwin' && arch === 'x64';
}

module.exports = { shouldDisableHardwareAcceleration };
