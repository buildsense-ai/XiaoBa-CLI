import * as path from 'path';

const packageRoot = process.env.XIAOBA_APP_ROOT || path.resolve(__dirname, '..');
export const APP_VERSION = require(path.join(packageRoot, 'package.json')).version;
