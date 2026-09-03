import { build } from 'esbuild';
import path from 'node:path';

const projectRoot = process.cwd();
const outfile = path.join(projectRoot, 'dist', 'connector', 'index.js');

await build({
  entryPoints: [path.join(projectRoot, 'src', 'connector', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // Bundle third-party packages into the isolated Connector artifact. This
  // avoids shipping the full CLI dependency tree; native optional ws addons
  // remain optional and ws falls back to its built-in JavaScript path.
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: process.env.CONNECTOR_METAFILE === '1',
  logLevel: 'info',
});

console.log(`Built standalone CatsCo Connector Lite entry: ${path.relative(projectRoot, outfile)}`);
