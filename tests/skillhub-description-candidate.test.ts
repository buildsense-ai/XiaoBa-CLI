import assert from 'node:assert/strict';
import { test } from 'node:test';
import matter from 'gray-matter';
import { createDescriptionCandidate, isConfirmedDescriptionCandidate } from '../src/skillhub/publication-candidate';

const report = { coverage: 'complete', issues: [{ code: 'metadata.description_missing', category: 'format',
  blocking: true, repairPolicy: 'confirmation_required', location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' } }] };
const description = '用于整理示例文档。';
for (const scalar of [undefined, '', ' ""', " ''", ' "  "', ' null', ' ~', ' # keep comment', ' "" # keep comment']) {
  for (const eol of ['\n', '\r\n']) test(`confirms empty description ${JSON.stringify(scalar)} with ${JSON.stringify(eol)}`, () => {
    const source = ['---', 'name: fixture', ...(scalar === undefined ? [] : [`description:${scalar}`]),
      'compatibility: example # unchanged', '---', '# Body', 'description: body stays unchanged', ''].join(eol);
    const files = [{ path: 'SKILL.md', contentBase64: Buffer.from(source).toString('base64') },
      { path: 'notes.txt', contentBase64: Buffer.from('untouched').toString('base64') }];
    const result = createDescriptionCandidate(files, report, description);
    assert.ok(result);
    const output = Buffer.from(result[0].contentBase64, 'base64').toString();
    assert.equal(matter(output).data.description, description);
    assert.equal(matter(output).content, matter(source).content);
    assert.match(output, /compatibility: example # unchanged/);
    if (scalar?.includes('#')) assert.match(output, /# keep comment/);
    assert.equal(result[1].contentBase64, files[1].contentBase64);
    assert.equal(files[0].contentBase64, Buffer.from(source).toString('base64'));
    assert.equal(isConfirmedDescriptionCandidate(files[0].contentBase64, result[0].contentBase64, description), true);
    assert.equal(isConfirmedDescriptionCandidate(files[0].contentBase64,
      Buffer.from(output.replace('# Body', '# Changed behavior')).toString('base64'), description), false);
  });
}
for (const field of ['description: already present', 'description: 42', 'description: []', 'description: {}',
  'description: ""\ndescription: ""', '"description": ""', 'description: |\n  Existing instructions']) {
  test(`does not replace a nonempty or ambiguous description: ${field}`, () => {
    assert.equal(createDescriptionCandidate([{ path: 'SKILL.md', contentBase64: Buffer.from(`---\nname: fixture\n${field}\n---\nBody`).toString('base64') }], report, description), undefined);
  });
}
