import * as path from 'path';
import { readFileSync } from 'fs';

// Read package.json using fs for consistency with ES modules
// This replaces the CommonJS require() approach for better ESM compatibility
const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

export const APP_VERSION = packageJson.version;
