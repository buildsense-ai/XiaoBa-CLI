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
  packages: 'external',
  external: [
    'ws',
    'glob',
    'sharp',
    'pdf-parse',
    '@napi-rs/canvas',
    'axios',
    'chalk',
    'dotenv',
    'gray-matter',
    'ora',
  ],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: process.env.CONNECTOR_METAFILE === '1',
  logLevel: 'info',
});

console.log(`Built standalone CatsCo Connector Lite entry: ${path.relative(projectRoot, outfile)}`);
