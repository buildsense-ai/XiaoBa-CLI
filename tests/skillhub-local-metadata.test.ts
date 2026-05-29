import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applySkillHubLocalMetadata,
  computeLocalSkillContentHash,
  readSkillHubLocalMetadata,
} from '../src/skillhub/local-skill-metadata';

describe('SkillHub local metadata', () => {
  test('writes readable SkillHub frontmatter without content hash', () => {
    const text = applySkillHubLocalMetadata([
      '---',
      'name: demo',
      'description: Demo skill',
      '---',
      '',
      '# Demo',
      '',
    ].join('\n'), {
      author: 'lin',
      version: '1.0.0',
      uploadedAt: '2026-05-28T00:00:00.000Z',
    });

    assert.match(text, /skillhub_author: "lin"/);
    assert.match(text, /skillhub_version: "1\.0\.0"/);
    assert.match(text, /skillhub_uploaded_at: "2026-05-28T00:00:00\.000Z"/);
    assert.doesNotMatch(text, /content_hash/);
  });

  test('merges metadata into CRLF frontmatter instead of prepending a second block', () => {
    const text = applySkillHubLocalMetadata('---\r\nname: demo\r\ndescription: Demo skill\r\n---\r\n\r\n# Demo\r\n', {
      author: 'lin',
      version: '1.0.1',
      uploadedAt: '2026-05-28T01:00:00.000Z',
    });

    assert.equal((text.match(/^---/gm) || []).length, 2);
    assert.doesNotMatch(text, /^---[\s\S]*?---\n\n---/);
    assert.match(text, /name: demo/);
    assert.match(text, /skillhub_author: "lin"/);
    assert.match(text, /skillhub_version: "1\.0\.1"/);
  });

  test('reads metadata and ignores generated package files in local hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skillhub-meta-'));
    try {
      const skillDir = path.join(root, 'demo');
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillFile, applySkillHubLocalMetadata('---\nname: demo\ndescription: Demo\n---\n\n# Demo\n', {
        author: 'lin',
        version: '1.0.0',
        uploadedAt: '2026-05-28T00:00:00.000Z',
      }));
      const before = computeLocalSkillContentHash(skillDir);
      fs.writeFileSync(path.join(skillDir, 'skill.json'), '{"generated":true}\n');
      fs.writeFileSync(path.join(skillDir, 'REVIEW.json'), '{}\n');
      fs.writeFileSync(path.join(skillDir, 'SBOM.json'), '{}\n');
      assert.equal(computeLocalSkillContentHash(skillDir), before);
      assert.deepEqual(readSkillHubLocalMetadata(skillFile), {
        author: 'lin',
        version: '1.0.0',
        uploadedAt: '2026-05-28T00:00:00.000Z',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('includes SkillHub frontmatter metadata in local content hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skillhub-meta-hash-'));
    try {
      const skillDir = path.join(root, 'demo');
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillFile, '---\r\nname: demo\r\ndescription: Demo\r\n---\r\n\r\n# Demo\r\n');
      const before = computeLocalSkillContentHash(skillDir);
      fs.writeFileSync(skillFile, applySkillHubLocalMetadata(fs.readFileSync(skillFile, 'utf8'), {
        author: 'lin',
        version: '9.9.9',
        uploadedAt: '2026-05-29T00:00:00.000Z',
      }));
      assert.notEqual(computeLocalSkillContentHash(skillDir), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
