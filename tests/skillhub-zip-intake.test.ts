import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { extractAuthorizedSkillZip } from '../src/skillhub/zip-intake';
import { makeZip, type ZipFixtureEntry } from './helpers/zip-fixture';

test('extracts one Skill package under a private temporary directory', async () => {
  const fixture = await createFixture([{ name: 'sample/SKILL.md', content: Buffer.from('---\nname: sample\n---\n') }], '20261107T061234.123Z_ab12cd34_my-skill.zip');
  let result: Awaited<ReturnType<typeof extractAuthorizedSkillZip>> | undefined;
  try {
    result = await extractAuthorizedSkillZip(fixture.zipPath, 'my-skill.zip');
    assert.equal(await fs.promises.readFile(path.join(result.directory, 'SKILL.md'), 'utf8'), '---\nname: sample\n---\n');
    assert.match(path.basename(result.cleanupDirectory), /^xiaoba-skillhub-zip-/);
  } finally {
    if (result) await fs.promises.rm(result.cleanupDirectory, { recursive: true, force: true });
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
});

test('uses the ZIP filename as the candidate directory when SKILL.md is at archive root', async () => {
  const fixture = await createFixture([{ name: 'SKILL.md', content: Buffer.from('---\n---\n') }], '20261107T061234.123Z_ab12cd34_my-skill.zip');
  let result: Awaited<ReturnType<typeof extractAuthorizedSkillZip>> | undefined;
  try {
    result = await extractAuthorizedSkillZip(fixture.zipPath, 'my-skill.zip');
    assert.equal(path.basename(result.directory), 'my-skill');
    assert.equal(await fs.promises.readFile(path.join(result.directory, 'SKILL.md'), 'utf8'), '---\n---\n');
  } finally {
    if (result) await fs.promises.rm(result.cleanupDirectory, { recursive: true, force: true });
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
});

test('derives a bounded candidate directory from the original long ZIP filename, not its cache path', async () => {
  const originalName = 'weekly-report-summarizer-skill-for-internal-ops-team.zip';
  const cachedName = `20261107T061234.123Z_ab12cd34_${originalName}`;
  const fixture = await createFixture([{ name: 'SKILL.md', content: Buffer.from('---\n---\n') }], cachedName);
  let result: Awaited<ReturnType<typeof extractAuthorizedSkillZip>> | undefined;
  try {
    result = await extractAuthorizedSkillZip(fixture.zipPath, originalName);
    assert.equal(path.basename(result.directory), path.basename(originalName, '.zip'));
    assert.ok(path.basename(result.directory).length <= 72);
  } finally {
    if (result) await fs.promises.rm(result.cleanupDirectory, { recursive: true, force: true });
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects traversal, duplicate entries, symlinks, and multiple Skill roots before extraction', async t => {
  const cases: Array<[string, ZipFixtureEntry[]]> = [
    ['path traversal', [entry('sample/SKILL.md'), entry('../outside.txt')]],
    ['absolute path', [entry('sample/SKILL.md'), entry('/outside.txt')]],
    ['Windows alternate stream path', [entry('sample/SKILL.md'), entry('sample/data.txt:secret')]],
    ['Windows reserved device path', [entry('sample/SKILL.md'), entry('sample/CON.txt')]],
    ['duplicate case-folded path', [entry('sample/SKILL.md'), entry('SAMPLE/skill.md')]],
    ['symbolic link', [entry('sample/SKILL.md'), { name: 'sample/link', content: Buffer.from('target'), mode: 0o120777 }]],
    ['multiple Skill entries', [entry('one/SKILL.md'), entry('two/SKILL.md')]],
  ];
  for (const [name, entries] of cases) {
    await t.test(name, async () => {
      const fixture = await createFixture(entries);
      try {
        await assert.rejects(extractAuthorizedSkillZip(fixture.zipPath, 'fixture.zip'));
      } finally {
        await fs.promises.rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects entries whose declared size exceeds the per-file limit', async () => {
  const fixture = await createFixture([
    entry('sample/SKILL.md'),
    { name: 'sample/large.bin', content: Buffer.from('x'), declaredSize: 5 * 1024 * 1024 + 1 },
  ]);
  try {
    await assert.rejects(extractAuthorizedSkillZip(fixture.zipPath, 'fixture.zip'), /per-file size limit/);
  } finally {
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a non-canonical SKILL.md case before the SkillHub service can miss it', async () => {
  const fixture = await createFixture([{ name: 'sample/skill.md', content: Buffer.from('---\nname: sample\n---\n') }]);
  try {
    await assert.rejects(extractAuthorizedSkillZip(fixture.zipPath, 'sample.zip'), /exact filename SKILL\.md/);
  } finally {
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
});

function entry(name: string, content = Buffer.from('---\nname: sample\n---\n')): ZipFixtureEntry {
  return { name, content };
}

test('accepts ZIP-format .skill files and a single wrapped .skill with shared budgets', async () => {
  const inner = makeZip([entry('caveman/SKILL.md'), entry('caveman/README.md', Buffer.from('readme'))]);
  for (const wrapped of [false, true]) {
    const fixture = await createFixture(wrapped ? [entry('caveman.skill', inner)] : [entry('caveman/SKILL.md')], wrapped ? 'caveman.zip' : 'caveman.skill');
    let result: Awaited<ReturnType<typeof extractAuthorizedSkillZip>> | undefined;
    try {
      result = await extractAuthorizedSkillZip(fixture.zipPath, path.basename(fixture.zipPath));
      assert.equal(path.basename(result.directory), 'caveman');
      assert.match(fs.readFileSync(path.join(result.directory, 'SKILL.md'), 'utf8'), /name: sample/);
      if (wrapped) assert.ok(result.uncompressedBytes > inner.length);
    } finally {
      if (result) await fs.promises.rm(result.cleanupDirectory, { recursive: true, force: true });
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rejects ambiguous wrappers, unsafe inner paths, deeper wrappers, and aggregate entry overflow', async () => {
  const good = makeZip([entry('SKILL.md')]);
  const cases = [
    [entry('a.skill', good), entry('b.skill', good)],
    [entry('a.skill', good), entry('README.md')],
    [entry('a.skill', makeZip([entry('../SKILL.md')]))],
    [entry('a.skill', makeZip([entry('b.zip', good)]))],
    [entry('a.skill', makeZip([entry('SKILL.md'), ...Array.from({ length: 99 }, (_, i) => entry(`file${i}`))]))],
    [entry('a.skill', Buffer.from('not a zip'))],
    [entry('a.skill', makeZip([entry('SKILL.md'), { name: 'link', content: Buffer.from('target'), mode: 0o120777 }]))],
    [entry('a.skill', makeZip([entry('SKILL.md'), ...Array.from({ length: 5 }, (_, i) => entry(`large${i}`, Buffer.alloc(5 * 1024 * 1024)))]))],
  ];
  for (const entries of cases) {
    const fixture = await createFixture(entries);
    try { await assert.rejects(extractAuthorizedSkillZip(fixture.zipPath, 'fixture.zip')); }
    finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }); }
  }
});

async function createFixture(entries: ZipFixtureEntry[], fileName = 'fixture.zip'): Promise<{ root: string; zipPath: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-test-'));
  const zipPath = path.join(root, fileName);
  await fs.promises.writeFile(zipPath, makeZip(entries));
  return { root, zipPath };
}
