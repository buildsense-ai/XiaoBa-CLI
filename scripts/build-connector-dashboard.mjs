import { build } from 'esbuild';
import path from 'node:path';

const projectRoot = process.cwd();
const outdir = path.join(projectRoot, 'dist', 'connector-dashboard');
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // Bundle the small HTTP stack so Connector Lite has no production
  // node_modules tree. Native optional ws addons are not used by Dashboard.
  external: ['bufferutil', 'utf-8-validate'],
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

console.log('Built standalone Connector Lite Dashboard entrypoint.');
