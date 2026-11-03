import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAndPublishSkillPresentation } from '../src/skillhub/presentation-generator';

const skillId = 'publisher/guide-skill';
const version = '1.0.0';

function generatedContent() {
  return {
    schemaVersion: 1,
    summary: '整理你提供的会议记录，并提取待办事项。',
    primaryCategory: 'documents',
    tags: ['会议', '摘要'],
    scenarios: [{ title: '整理会议记录', description: '从会议记录中提取明确的决定与行动项。' }],
    steps: ['提供会议记录', '说明关注重点', '检查输出'],
    example: {
      kind: 'document',
      input: '示意，非实测：一段会议记录',
      output: '示意，非实测：摘要与待办列表',
    },
    requirements: ['需要提供可读取的会议记录。'],
    limitations: ['示例为示意，非实测；请核对源记录。'],
    details: '适用于将已有会议文本整理成便于跟进的内容。',
  };
}

function fixture(options: {
  published?: boolean;
  draft?: boolean;
  output?: unknown;
  unpublishedReads?: number;
} = {}) {
  const calls: string[] = [];
  const saved = { revision: 1 };
  let savedInput: any;
  let unpublishedReads = options.unpublishedReads || 0;
  const service = {
    getPresentation: async () => {
      calls.push('read-published');
      if (unpublishedReads > 0) {
        unpublishedReads -= 1;
        const error: any = new Error('version not published yet');
        error.status = 404;
        error.code = 'skillhub.request_failed';
        throw error;
      }
      return { presentation: options.published ? { revision: 3 } : null };
    },
    getPresentationDraft: async () => {
      calls.push('read-draft');
      return { presentation: { revision: options.draft ? 2 : 0, draft: options.draft ? { summary: 'author text' } : null } };
    },
    savePresentationDraft: async (input: any) => {
      calls.push(`save:${input.expectedRevision}`);
      savedInput = input;
      return { presentation: saved };
    },
    publishPresentation: async (input: any) => {
      calls.push(`publish:${input.expectedRevision}`);
      return { presentation: { revision: input.expectedRevision } };
    },
  };
  const aiService = {
    chat: async (messages: any[]) => {
      calls.push('model');
      assert.match(messages[0].content, /不执行代码/);
      assert.match(messages[1].content, /SKILL\.md/);
      return { content: JSON.stringify(options.output ?? generatedContent()) };
    },
  };
  return { calls, service, aiService, get savedInput() { return savedInput; } };
}

const files = [{
  path: 'SKILL.md',
  contentBase64: Buffer.from('---\nname: guide-skill\ndescription: Summarize meeting notes.\n---\n').toString('base64'),
}];

test('generates from the exact uploaded package and publishes under the publisher session', async () => {
  const f = fixture();
  const result = await generateAndPublishSkillPresentation({
    aiService: f.aiService as any,
    service: f.service,
    skillId,
    version,
    files,
  });
  assert.equal(result, 'published');
  assert.deepEqual(f.calls, ['read-published', 'read-draft', 'model', 'save:0', 'publish:1']);
});

test('waits for an asynchronously published package to become readable before generating', async () => {
  const f = fixture({ unpublishedReads: 2 });
  const waits: number[] = [];
  const result = await generateAndPublishSkillPresentation({
    aiService: f.aiService as any,
    service: f.service,
    skillId,
    version,
    files,
    wait: async milliseconds => { waits.push(milliseconds); },
  });
  assert.equal(result, 'published');
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(f.calls, [
    'read-published', 'read-published', 'read-published', 'read-draft', 'model', 'save:0', 'publish:1',
  ]);
});

test('stops polling after the bounded version-visibility window', async () => {
  const f = fixture({ unpublishedReads: 100 });
  const waits: number[] = [];
  await assert.rejects(generateAndPublishSkillPresentation({
    aiService: f.aiService as any,
    service: f.service,
    skillId,
    version,
    files,
    wait: async milliseconds => { waits.push(milliseconds); },
  }), /not published yet/);
  assert.equal(waits.length, 9);
  assert.equal(f.calls.filter(call => call === 'read-published').length, 10);
  assert.equal(f.calls.includes('model'), false);
});

test('does not call the model or overwrite an existing author presentation', async () => {
  const published = fixture({ published: true });
  assert.equal(await generateAndPublishSkillPresentation({
    aiService: published.aiService as any,
    service: published.service,
    skillId,
    version,
    files,
  }), 'already_published');
  assert.deepEqual(published.calls, ['read-published']);

  const draft = fixture({ draft: true });
  assert.equal(await generateAndPublishSkillPresentation({
    aiService: draft.aiService as any,
    service: draft.service,
    skillId,
    version,
    files,
  }), 'author_draft_exists');
  assert.deepEqual(draft.calls, ['read-published', 'read-draft']);
});

test('rejects untested examples that are not clearly labeled', async () => {
  const output = generatedContent();
  output.example.input = '真实测试：会议记录';
  output.example.output = '摘要';
  const f = fixture({ output });
  await assert.rejects(generateAndPublishSkillPresentation({
    aiService: f.aiService as any,
    service: f.service,
    skillId,
    version,
    files,
  }), /labeled as illustrative/);
  assert.deepEqual(f.calls, ['read-published', 'read-draft', 'model']);
});

test('treats omitted optional lists as empty lists', async () => {
  const output = generatedContent();
  delete (output as any).tags;
  delete (output as any).scenarios;
  delete (output as any).steps;
  delete (output as any).requirements;
  delete (output as any).limitations;
  const f = fixture({ output });
  assert.equal(await generateAndPublishSkillPresentation({
    aiService: f.aiService as any,
    service: f.service,
    skillId,
    version,
    files,
  }), 'published');
  assert.deepEqual(f.savedInput.content.tags, []);
  assert.deepEqual(f.savedInput.content.scenarios, []);
  assert.deepEqual(f.savedInput.content.steps, []);
  assert.deepEqual(f.savedInput.content.requirements, []);
  assert.deepEqual(f.savedInput.content.limitations, []);
  assert.deepEqual(f.calls, ['read-published', 'read-draft', 'model', 'save:0', 'publish:1']);
});

test('requires a root SKILL.md and does not truncate it for the model', async () => {
  const f = fixture();
  await assert.rejects(generateAndPublishSkillPresentation({
    aiService: f.aiService as any,
    service: f.service,
    skillId,
    version,
    files: [],
  }), /root SKILL\.md/);
  const oversized = [{
    path: 'SKILL.md',
    contentBase64: Buffer.alloc(65 * 1024, 0x61).toString('base64'),
  }];
  await assert.rejects(generateAndPublishSkillPresentation({
    aiService: f.aiService as any,
    service: f.service,
    skillId,
    version,
    files: oversized,
  }), /too large/);
});
