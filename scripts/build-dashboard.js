const path = require('path');
const esbuild = require('esbuild');

const root = process.cwd();
esbuild.buildSync({
  entryPoints: [path.join(root, 'dashboard/react-src/dashboard-shell.tsx')],
  outfile: path.join(root, 'dashboard/build/dashboard-shell.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  logLevel: 'info',
});
