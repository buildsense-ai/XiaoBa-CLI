import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), 'skills');
const baseDir = path.join(root, '_base');
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

if (!fs.existsSync(root)) {
  console.log(`skills directory not found: ${root}`);
  process.exit(0);
}

fs.mkdirSync(baseDir, { recursive: true });

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === '_base') continue;
  const source = path.join(root, entry.name);
  const directSkill = path.join(source, 'SKILL.md');
  const isFlatSkill = fs.existsSync(directSkill);
  const isInvalidNamespace = !safeName.test(entry.name);
  if (!isFlatSkill && !isInvalidNamespace) continue;

  const target = path.join(baseDir, entry.name);
  if (fs.existsSync(target)) {
    throw new Error(`Cannot migrate ${source}: target already exists: ${target}`);
  }
  fs.renameSync(source, target);
  console.log(`migrated ${path.relative(root, source)} -> ${path.relative(root, target)}`);
}
