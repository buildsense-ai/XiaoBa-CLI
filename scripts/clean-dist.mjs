import { rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = resolve(projectRoot, 'dist');

// `dist` is generated and ignored. A clean build is necessary when a source
// entry point is removed, otherwise TypeScript leaves its stale JS artifact in
// place and an Electron package can still ship it.
if (relative(projectRoot, distDirectory) !== 'dist') {
  throw new Error('refusing to remove a path outside the project dist directory');
}

await rm(distDirectory, { recursive: true, force: true });
