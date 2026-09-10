#!/usr/bin/env node
'use strict';

// Fixed package-relative entrypoint: never load executable code from runtime data.
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== '--root' || !args[1] || !path.isAbsolute(args[1])) {
  console.error(JSON.stringify({ ok: false, code: 'INVALID_ROOT', message: 'An absolute --root is required.' }));
  process.exitCode = 1;
} else {
  const root = path.resolve(args[1]);
  process.env.XIAOBA_USER_DATA_DIR = root;
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_APP_ROOT = path.resolve(__dirname, '../../..');
  require('../../../dist/skills/prompt-editor-command.js').runPromptEditorCommand(args.slice(2))
    .then(result => {
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    })
    .catch(() => {
      console.error(JSON.stringify({ ok: false, code: 'HELPER_FAILED', message: 'Prompt helper failed; no success is confirmed.' }));
      process.exitCode = 1;
    });
}
