import * as path from 'path';

export const APP_VERSION = require(path.resolve(__dirname, '..', 'package.json')).version;
