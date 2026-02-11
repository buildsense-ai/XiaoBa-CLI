import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillParser } from '../src/skills/skill-parser';

test('skill parser reads allowed-tools policy from frontmatter', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-parser-'));
  const skillDir = path.join(tmpRoot, 'sample-skill');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillPath = path.join(skillDir, 'SKILL.md');
  const skillContent = `---\nname: sample-skill\ndescription: sample\ninvocable: user\nallowed-tools:\n  - read_file\n  - glob\n---\n\n# sample\n`;
  fs.writeFileSync(skillPath, skillContent, 'utf-8');

  try {
    const parsed = SkillParser.parse(skillPath);
    assert.ok(parsed.metadata.toolPolicy);
    assert.deepEqual(parsed.metadata.toolPolicy?.allowedTools, ['read_file', 'glob']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
