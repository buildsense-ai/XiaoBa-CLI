import { build } from 'esbuild';
import path from 'node:path';

const projectRoot = process.cwd();
const outdir = path.join(projectRoot, 'dist', 'connector-dashboard');
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  packages: 'external',
  external: [
    'express',
    'ws',
  ],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [path.join(projectRoot, 'src', 'dashboard', 'connector-lite-server.ts')],
  outfile: path.join(outdir, 'server.js'),
});

await build({
  ...common,
  entryPoints: [path.join(projectRoot, 'src', 'dashboard', 'local-file-grants.ts')],
  outfile: path.join(outdir, 'local-file-grants.js'),
});

console.log('Built standalone Connector Lite Dashboard entrypoints.');
