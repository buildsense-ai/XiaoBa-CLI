import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { extractAuthorizedSkillZip } from '../src/skillhub/zip-intake';

interface ZipFixtureEntry {
  name: string;
  content: Buffer;
  mode?: number;
  declaredSize?: number;
}

test('extracts one Skill package under a private temporary directory', async () => {
  const fixture = await createFixture([{ name: 'sample/SKILL.md', content: Buffer.from('---\nname: sample\n---\n') }]);
  let result: Awaited<ReturnType<typeof extractAuthorizedSkillZip>> | undefined;
  try {
    result = await extractAuthorizedSkillZip(fixture.zipPath);
    assert.equal(await fs.promises.readFile(path.join(result.directory, 'SKILL.md'), 'utf8'), '---\nname: sample\n---\n');
    assert.match(path.basename(result.cleanupDirectory), /^xiaoba-skillhub-zip-/);
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
        await assert.rejects(extractAuthorizedSkillZip(fixture.zipPath));
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
    await assert.rejects(extractAuthorizedSkillZip(fixture.zipPath), /per-file size limit/);
  } finally {
    await fs.promises.rm(fixture.root, { recursive: true, force: true });
  }
});

function entry(name: string, content = Buffer.from('---\nname: sample\n---\n')): ZipFixtureEntry {
  return { name, content };
}

async function createFixture(entries: ZipFixtureEntry[]): Promise<{ root: string; zipPath: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-test-'));
  const zipPath = path.join(root, 'fixture.zip');
  await fs.promises.writeFile(zipPath, makeZip(entries));
  return { root, zipPath };
}

function makeZip(entries: ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name);
    const compressed = deflateRawSync(item.content);
    const crc = crc32(item.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(item.declaredSize ?? item.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(item.declaredSize ?? item.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
