import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import matter from 'gray-matter';
import type { Server } from 'http';
import { SkillHubService } from '../src/skillhub/service';
import { ShareSkillHubSkillTool } from '../src/tools/share-skillhub-skill-tool';
import { collectBotSkillPackageFiles } from '../src/bot-skills/local-manifest';
import type { SkillHubTrustedRootKey } from '../src/skillhub/trusted-keys';
import { CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS } from '../src/skillhub/trusted-keys';
import { SkillParser } from '../src/skills/skill-parser';
import { applySkillHubLocalMetadata } from '../src/skillhub/local-skill-metadata';

describe('SkillHub connected install service', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalEnv: string | undefined;
  let originalSkillsEnv: string | undefined;
  let originalRuntimeRootEnv: string | undefined;
  let originalCatsCoEnv: Record<string, string | undefined>;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalEnv = process.env.CATSCO_SKILLHUB_BASE_URL;
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    originalRuntimeRootEnv = process.env.XIAOBA_USER_DATA_DIR;
    const catsCoEnvKeys = [
      'CATSCO_USER_TOKEN',
      'CATSCO_USER_UID',
      'CATSCO_HTTP_BASE_URL',
      'CATSCOMPANY_USER_TOKEN',
      'CATSCOMPANY_USER_UID',
      'CATSCOMPANY_HTTP_BASE_URL',
      'CATSCO_LOCAL_CONFIG_PATH',
      'CATSCO_CONFIG_PATH',
    ];
    originalCatsCoEnv = Object.fromEntries(catsCoEnvKeys.map(key => [key, process.env[key]]));
    for (const key of catsCoEnvKeys) delete process.env[key];
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skillhub-service-'));
    process.chdir(testRoot);
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
    process.env.CATSCO_USER_TOKEN = 'catsco-test-token';
    process.env.CATSCO_USER_UID = 'usr_test';
    process.env.CATSCO_HTTP_BASE_URL = 'https://app.catsco.cc';
    fs.mkdirSync(path.join(testRoot, 'skills'), { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.CATSCO_SKILLHUB_BASE_URL;
    else process.env.CATSCO_SKILLHUB_BASE_URL = originalEnv;
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    if (originalRuntimeRootEnv === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalRuntimeRootEnv;
    for (const [key, value] of Object.entries(originalCatsCoEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.splice(0);
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('preserves the actionable ambiguity error for same-name local Skills', async () => {
    let requestCount = 0;
    const app = express();
    app.use((_req, res) => {
      requestCount += 1;
      res.status(500).json({ error: 'unexpected request' });
    });
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.CATSCO_SKILLHUB_BASE_URL = `http://127.0.0.1:${address.port}`;

    for (const directory of ['first-review', 'second-review']) {
      const skillRoot = path.join(testRoot, 'skills', directory);
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
        '---',
        'name: review-pr',
        `description: ${directory} review Skill`,
        '---',
        '',
        '# Review PR',
        '',
      ].join('\n'));
    }

    await assert.rejects(
      new SkillHubService().shareLocalSkill({ skillName: 'review-pr' }),
      (error: any) => (
        error?.code === 'skillhub.local_skill_ambiguous'
        && error?.status === 409
        && /Select one by its local Skill ID/i.test(error.message)
      ),
    );
    assert.equal(requestCount, 0);
  });

  test('publication candidates cannot change any package file other than SKILL.md name whitespace', async () => {
    let requestCount = 0;
    const app = express();
    app.use(express.json());
    app.use((_req, res) => {
      requestCount++;
      res.status(500).json({ error: 'unexpected request' });
    });
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.CATSCO_SKILLHUB_BASE_URL = `http://127.0.0.1:${address.port}`;

    const skillRoot = path.join(testRoot, 'skills', 'candidate-test');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: candidate-test',
      'description: A local test Skill',
      '---',
      '',
      '# Instructions',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(skillRoot, 'README.md'), 'Original README\n');
    const candidate = collectBotSkillPackageFiles(skillRoot).map(file => ({
      path: file.path,
      contentBase64: file.path === 'README.md'
        ? Buffer.from('Changed README\n').toString('base64')
        : file.contentBase64,
    }));

    await assert.rejects(
      new SkillHubService().shareLocalSkill({ skillName: 'candidate-test' }, {
        localSkillPath: skillRoot,
        packageFiles: candidate,
      }),
      (error: any) => error?.code === 'skillhub.publication_candidate_invalid'
        && error?.status === 400,
    );
    assert.equal(requestCount, 0);
    assert.equal(fs.readFileSync(path.join(skillRoot, 'README.md'), 'utf8'), 'Original README\n');
  });

  test('shares a repaired Skill with a normalized manifest without rewriting the local name', async () => {
    let uploaded: any;
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubSessionRoutes(app);
    app.post('/api/skills/share', (req, res) => {
      uploaded = req.body;
      res.json({ submission: { id: 'submission-1', status: 'submitted' } });
    });
    server = app.listen(0);
    await new Promise<void>(resolve => server!.once('listening', () => resolve()));
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    const skillRoot = path.join(testRoot, 'skills', 'whitespace-name');
    fs.mkdirSync(skillRoot, { recursive: true });
    const originalText = '---\nname: " whitespace-name "\ndescription: A local test Skill\n---\n# Instructions\n';
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), originalText);
    const packageFiles = collectBotSkillPackageFiles(skillRoot).map(file => ({
      path: file.path,
      contentBase64: file.path === 'SKILL.md'
        ? Buffer.from(originalText.replace('name: " whitespace-name "', 'name: "whitespace-name"'), 'utf8').toString('base64')
        : file.contentBase64,
    }));

    await new SkillHubService().shareLocalSkill({ skillName: 'whitespace-name' }, {
      localSkillPath: skillRoot,
      packageFiles,
    });

    assert.equal(uploaded.manifest.name, 'whitespace-name');
    assert.equal(uploaded.manifest.id, 'whitespace-name');
    const uploadedEntry = uploaded.source.files.find((file: any) => file.path === 'SKILL.md');
    assert.match(Buffer.from(uploadedEntry.contentBase64, 'base64').toString('utf8'), /name: "whitespace-name"/);
    assert.equal(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'), originalText);
    const success = await new SkillHubService().shareLocalSkill({ skillName: 'whitespace-name' }, {
      localSkillPath: skillRoot,
      packageFiles,
    });
    assert.equal(success.skill.name, 'whitespace-name');
  });

  test('publishes a missing-name Skill under a normalized directory name without changing its source', async () => {
    const uploaded: any[] = [];
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubSessionRoutes(app);
    app.post('/api/skills/share', (req, res) => {
      uploaded.push(req.body);
      if (uploaded.length === 1) {
        return res.status(422).json({ error: { code: 'skillhub.publish_validation_failed', message: 'Rejected.', validation: {
          schemaVersion: '1', ruleVersion: 'skillhub-publish-v1.0.1', profile: 'skillhub-publish-v1',
          reportId: '00000000-0000-4000-8000-000000000103', outcome: 'rejected', coverage: 'complete',
          candidateHash: 'a'.repeat(64), limitsFingerprint: 'b'.repeat(64),
          issues: [{ code: 'metadata.name_missing', category: 'format', blocking: true, repairPolicy: 'automatic',
            location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' }, message: 'name missing' }],
          truncated: false, nextAction: 'review_report',
        } } });
      }
      return res.json({ submission: { id: 'submission-name-missing-repair', status: 'submitted' } });
    });
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.CATSCO_SKILLHUB_BASE_URL = `http://127.0.0.1:${address.port}`;

    const skillRoot = path.join(testRoot, 'skills', 'Missing Name Sample');
    fs.mkdirSync(skillRoot, { recursive: true });
    const sourceFile = path.join(skillRoot, 'SKILL.md');
    const originalText = '---\ndescription: Safe test fixture\n---\n# Original instructions\n';
    fs.writeFileSync(sourceFile, originalText);
    const realService = new SkillHubService();
    const tool = new ShareSkillHubSkillTool(() => ({ shareLocalSkill: realService.shareLocalSkill.bind(realService) }));

    const result = await tool.execute({ localSkillPath: skillRoot }, { sessionId: 'service-name-missing-repair' } as any);

    assert.equal(result.ok, true);
    assert.equal(uploaded.length, 2);
    assert.equal(uploaded[0].manifest.name, 'missing-name-sample');
    assert.equal(uploaded[1].manifest.name, 'missing-name-sample');
    const originalPackageText = Buffer.from(uploaded[0].source.files.find((file: any) => file.path === 'SKILL.md').contentBase64, 'base64').toString('utf8');
    const repairedPackageText = Buffer.from(uploaded[1].source.files.find((file: any) => file.path === 'SKILL.md').contentBase64, 'base64').toString('utf8');
    assert.equal(originalPackageText, originalText);
    assert.match(repairedPackageText, /name: "missing-name-sample"/);
    assert.match(repairedPackageText, /# Original instructions/);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), originalText);
  });

  test('records tracking metadata without moving an empty frontmatter block into the Skill body', async () => {
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubSessionRoutes(app);
    app.post('/api/skills/share', (_req, res) => res.json({
      skillHub: { author: 'u1', version: '1.0.0', uploadedAt: '2026-11-06T00:00:00.000Z' },
      submission: { id: 'submission-empty-frontmatter', status: 'submitted' },
    }));
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.CATSCO_SKILLHUB_BASE_URL = `http://127.0.0.1:${address.port}`;

    const skillRoot = path.join(testRoot, 'skills', 'empty-frontmatter');
    fs.mkdirSync(skillRoot, { recursive: true });
    const skillFile = path.join(skillRoot, 'SKILL.md');
    const originalBody = '# Title\n\n---\n\n## Section\nText\n';
    const originalText = `---\n---\n${originalBody}`;
    fs.writeFileSync(skillFile, originalText);

    await new SkillHubService().shareLocalSkill({}, { localSkillPath: skillRoot });

    const saved = fs.readFileSync(skillFile, 'utf8');
    assert.ok(saved.endsWith(originalBody));
    assert.equal(matter(saved).content, originalBody);
    assert.match(saved, /skillhub_author: "u1"/);
    assert.match(saved, /skillhub_version: "1\.0\.0"/);
  });

  test('returns the assigned upload version and ID even when registry latest still points at an older version', async () => {
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubSessionRoutes(app);
    app.post('/api/skills/share', (_req, res) => res.json({
      upload: { id: 'queued-upload-10', skillId: 'alice/version-receipt', version: '1.0.10' },
      skill: { skillId: 'alice/version-receipt', latestVersion: '1.0.9' }, contentHash: 'a'.repeat(64),
    }));
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.CATSCO_SKILLHUB_BASE_URL = `http://127.0.0.1:${address.port}`;
    const source = path.join(testRoot, 'skills', 'version-receipt');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: version-receipt\ndescription: Test receipt\n---\n# Test\n');
    const result = await new SkillHubService().shareLocalSkill({ skillName: 'version-receipt' });
    assert.equal(result.latestVersion, '1.0.10');
    assert.equal(result.uploadId, 'queued-upload-10');
    assert.equal(result.publicationStatus, 'submitted');
    assert.equal(result.skill.id, 'alice/version-receipt');
  });

  test('allows an absent name for publication preflight but still rejects explicitly invalid names', () => {
    const skillRoot = path.join(testRoot, 'skills', 'parser-name-validation');
    fs.mkdirSync(skillRoot, { recursive: true });
    const skillFile = path.join(skillRoot, 'SKILL.md');
    fs.writeFileSync(skillFile, '---\ndescription: Valid fixture\n---\n# Instructions\n');
    assert.equal(SkillParser.parse(skillFile, { allowMissingName: true }).metadata.name, '');

    fs.writeFileSync(skillFile, '---\nname: 12\ndescription: Valid fixture\n---\n# Instructions\n');
    assert.throws(() => SkillParser.parse(skillFile, { allowMissingName: true }), /Missing required fields/);
    fs.writeFileSync(skillFile, '---\nname: ""\ndescription: Valid fixture\n---\n# Instructions\n');
    assert.throws(() => SkillParser.parse(skillFile, { allowMissingName: true }), /Missing required fields/);

    fs.writeFileSync(skillFile, '---\nname: 12\ndescription: Valid fixture\n---\n# Instructions\n');
    assert.equal((SkillParser.parse(skillFile).metadata as any).name, 12);
    assert.throws(() => SkillParser.parse(skillFile, { allowMissingName: true }), /Missing required fields/);
  });

  for (const emptyDescription of ['', 'description:\n', 'description: "" # keep empty comment\n']) {
  test(`publishes a name-normalized candidate after confirming missing/empty description ${JSON.stringify(emptyDescription)}`, async () => {
    const uploaded: any[] = [];
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubSessionRoutes(app);
    app.post('/api/skills/share', (req, res) => {
      uploaded.push(req.body);
      const reportId = uploaded.length === 1
        ? '00000000-0000-4000-8000-000000000101'
        : '00000000-0000-4000-8000-000000000102';
      const issue = uploaded.length === 1
        ? { code: 'metadata.name_whitespace', category: 'format', repairPolicy: 'automatic', field: 'name', message: 'trim name' }
        : { code: 'metadata.description_missing', category: 'format', repairPolicy: 'confirmation_required', field: 'description', message: 'add description' };
      if (uploaded.length < 3) {
        return res.status(422).json({ error: { code: 'skillhub.publish_validation_failed', message: 'Rejected.', validation: {
          schemaVersion: '1', ruleVersion: 'skillhub-publish-v1.0.1', profile: 'skillhub-publish-v1', reportId,
          outcome: 'rejected', coverage: 'complete', candidateHash: 'a'.repeat(64), limitsFingerprint: 'b'.repeat(64),
          issues: [{ ...issue, blocking: true, location: { entryIndex: 0, relativePath: 'SKILL.md', field: issue.field } }],
          truncated: false, nextAction: 'review_report',
        } } });
      }
      return res.json({ submission: { id: 'submission-combined', status: 'submitted' } });
    });
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.CATSCO_SKILLHUB_BASE_URL = `http://127.0.0.1:${address.port}`;

    const skillRoot = path.join(testRoot, 'skills', 'format-and-description');
    fs.mkdirSync(skillRoot, { recursive: true });
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const originalText = `---\nname: " demo " # keep\n${emptyDescription}---\n# Original instructions\n`;
    fs.writeFileSync(skillPath, originalText);
    const realService = new SkillHubService();
    const tool = new ShareSkillHubSkillTool(() => ({ shareLocalSkill: realService.shareLocalSkill.bind(realService) }));
    const history: any[] = [{ role: 'user', content: '发布这个 skill' }];
    const sentMessages: string[] = [];
    const context: any = {
      sessionId: 'format-and-description-confirmation',
      conversationHistory: history,
      channel: { chatId: 'test-chat', reply: async (_chatId: string, text: string) => { sentMessages.push(text); } },
      runtimeServices: { aiService: { chat: async () => ({
        content: '{"description":"用于整理示例文档的一次性测试 Skill。"}',
      }) } },
    };

    const draft = await tool.execute({ localSkillPath: skillRoot }, context);
    assert.equal(draft.ok, true);
    assert.equal(draft.controlSignal, 'pause_turn');
    assert.equal(uploaded.length, 2);
    assert.match(sentMessages[0], /自动修正了 name/);
    assert.match(sentMessages[0], /发现「demo」/);
    assert.match(Buffer.from(uploaded[1].source.files[0].contentBase64, 'base64').toString('utf8'), /name: "demo" # keep/);

    history.push({ role: 'user', content: '确认使用这条说明并发布' });
    const published = await tool.execute({ confirmDescription: true,
      descriptionReportId: '00000000-0000-4000-8000-000000000102',
      confirmedDescription: '用于整理示例文档的一次性测试 Skill。' }, context);
    assert.equal(published.ok, true);
    assert.equal(uploaded.length, 3);
    const submittedEntry = uploaded[2].source.files.find((file: any) => file.path === 'SKILL.md');
    const submittedText = Buffer.from(submittedEntry.contentBase64, 'base64').toString('utf8');
    assert.match(submittedText, /name: "demo" # keep/);
    assert.match(submittedText, /description: "用于整理示例文档的一次性测试 Skill。"/);
    assert.match(submittedText, /# Original instructions/);
    assert.equal(fs.readFileSync(skillPath, 'utf8'), originalText);
  });
  }

  test('publishes an explicitly supplied Skill path outside the configured workspace without changing the source', async () => {
    let uploaded: any;
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubSessionRoutes(app);
    app.post('/api/skills/share', (req, res) => {
      uploaded = req.body;
      res.json({ submission: { id: 'submission-external' } });
    });
    server = app.listen(0);
    await new Promise<void>(resolve => server!.once('listening', () => resolve()));
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    const skillRoot = path.join(testRoot, 'old-release', 'data', 'skills', 'xiaoba-speaking-style');
    fs.mkdirSync(skillRoot, { recursive: true });
    const originalText = '---\nname: xiaoba-speaking-style\ndescription: A local test Skill\n---\n# Instructions\n';
    const sourceFile = path.join(skillRoot, 'SKILL.md');
    fs.writeFileSync(sourceFile, originalText);

    const result = await new SkillHubService().shareLocalSkill({}, {
      localSkillPath: skillRoot,
      writeLocalMetadata: false,
    });

    assert.equal(result.skill.name, 'xiaoba-speaking-style');
    assert.equal(uploaded.manifest.name, 'xiaoba-speaking-style');
    assert.equal(uploaded.source.files[0].path, 'SKILL.md');
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), originalText);
  });

  test('sends an explicit path with a missing description to Cloud validation and returns its confirmation report', async () => {
    let uploaded: any;
    let exchangeCount = 0;
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubSessionRoutes(app, () => { exchangeCount += 1; });
    app.post('/api/skills/share', (req, res) => {
      uploaded = req.body;
      res.status(422).json({
        error: {
          code: 'skillhub.publish_validation_failed',
          message: '发布预检未通过，请查看问题报告。',
          validation: {
            schemaVersion: '1',
            ruleVersion: 'skillhub-publish-v1.0.1',
            profile: 'skillhub-publish-v1',
            reportId: '00000000-0000-4000-8000-000000000001',
            outcome: 'rejected',
            coverage: 'complete',
            candidateHash: 'a'.repeat(64),
            limitsFingerprint: 'b'.repeat(64),
            issues: [{
              code: 'metadata.description_missing',
              category: 'format',
              blocking: true,
              location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
              message: '入口缺少 description；可生成草稿，但确认后才能写入发布副本。',
              repairPolicy: 'confirmation_required',
            }],
            truncated: false,
            nextAction: 'review_report',
          },
        },
      });
    });
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.CATSCO_SKILLHUB_BASE_URL = `http://127.0.0.1:${address.port}`;

    const skillRoot = path.join(testRoot, 'external', 'description-confirmation');
    fs.mkdirSync(skillRoot, { recursive: true });
    const originalText = [
      '---',
      'name: description-confirmation',
      '---',
      '',
      '# Instructions',
      'This fixture must not be published without a confirmed description.',
      '',
    ].join('\n');
    const skillFile = path.join(skillRoot, 'SKILL.md');
    fs.writeFileSync(skillFile, originalText);

    assert.throws(() => SkillParser.parse(skillFile), /Missing required fields/);
    await assert.rejects(
      new SkillHubService().shareLocalSkill({}, { localSkillPath: skillRoot, writeLocalMetadata: false }),
      (error: any) => error?.code === 'skillhub.publish_validation_failed'
        && error?.validation?.reportId === '00000000-0000-4000-8000-000000000001'
        && error?.validation?.issues?.[0]?.code === 'metadata.description_missing'
        && error?.validation?.issues?.[0]?.repairPolicy === 'confirmation_required',
    );

    assert.equal(uploaded.manifest.name, 'description-confirmation');
    assert.equal(exchangeCount, 1);
    assert.equal(Object.hasOwn(uploaded.manifest, 'description'), false);
    const submittedFile = uploaded.source.files.find((file: any) => file.path === 'SKILL.md');
    assert.equal(Buffer.from(submittedFile.contentBase64, 'base64').toString('utf8'), originalText);
    assert.equal(fs.readFileSync(skillFile, 'utf8'), originalText);
  });

  test('does not submit a Skill when no CatsCo login is available for SkillHub authentication', async () => {
    let requestCount = 0;
    const app = express();
    app.use(express.json());
    app.get('/api/auth/me', (_req, res) => {
      res.status(401).json({ error: 'unauthenticated' });
    });
    app.post('/api/skills/share', (_req, res) => {
      requestCount += 1;
      res.status(500).json({ error: 'unexpected request' });
    });
    app.use((_req, res) => res.status(500).json({ error: 'unexpected request' }));
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.CATSCO_SKILLHUB_BASE_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.CATSCO_USER_TOKEN;

    const skillRoot = path.join(testRoot, 'skills', 'no-catsco-login');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: no-catsco-login',
      'description: Must not be submitted without an account session',
      '---',
      '',
      '# Instructions',
      '',
    ].join('\n'));

    await assert.rejects(
      new SkillHubService().shareLocalSkill({ skillName: 'no-catsco-login' }),
      (error: any) => error?.code === 'skillhub.catsco_login_required' && error?.status === 401,
    );
    assert.equal(requestCount, 0);
  });

  test('rejects a whitespace-only explicit Skill path before scanning the current directory', async () => {
    await assert.rejects(
      new SkillHubService().shareLocalSkill({}, { localSkillPath: '   ' }),
      (error: any) => error?.code === 'skillhub.local_skill_path_invalid' && error?.status === 400,
    );
  });

  test('path-only lookup errors identify the supplied path without listing workspace Skills', async () => {
    const requestedPath = path.join(testRoot, 'missing-skill');
    await assert.rejects(
      new SkillHubService().shareLocalSkill({}, { localSkillPath: requestedPath }),
      (error: any) => error?.code === 'skillhub.local_skill_not_found'
        && error?.status === 404
        && error.message.includes(requestedPath)
        && !error.message.includes('Available skills:'),
    );
  });

  test('publishes a Skill whose explicit directory is the current working directory', async () => {
    const uploaded: any[] = [];
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubSessionRoutes(app);
    app.post('/api/skills/share', (req, res) => {
      uploaded.push(req.body);
      res.json({ submission: { id: `submission-cwd-${uploaded.length}` } });
    });
    server = app.listen(0);
    await new Promise<void>(resolve => server!.once('listening', () => resolve()));
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;
    fs.writeFileSync(path.join(testRoot, 'SKILL.md'), [
      '---',
      'name: cwd-skill',
      'description: Skill published from the current directory',
      '---',
      '',
      '# Instructions',
    ].join('\n'));

    const service = new SkillHubService();
    const absolute = await service.shareLocalSkill({ skillName: 'cwd-skill' }, { localSkillPath: testRoot });
    const dot = await service.shareLocalSkill({}, { localSkillPath: '.' });

    assert.equal(absolute.skill.name, 'cwd-skill');
    assert.equal(dot.skill.name, 'cwd-skill');
    assert.equal(uploaded.length, 2);
  });

  test('treats a null local path as omitted', async () => {
    await assert.rejects(
      new SkillHubService().shareLocalSkill({}, { localSkillPath: null as any }),
      (error: any) => error?.code === 'skillhub.skill_name_required',
    );
  });

  test('rejects a whitespace-only name before sending a publication request', async () => {
    let requestCount = 0;
    const app = express();
    app.use(express.json());
    app.use((_req, res) => {
      requestCount++;
      res.status(500).json({ error: 'unexpected request' });
    });
    server = app.listen(0);
    await new Promise<void>(resolve => server!.once('listening', () => resolve()));
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    const skillRoot = path.join(testRoot, 'skills', 'empty-name');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: "   "\ndescription: Invalid name\n---\n# Instructions\n');

    await assert.rejects(
      new SkillHubService().shareLocalSkill({ skillName: 'empty-name' }, { localSkillPath: skillRoot }),
      (error: any) => error?.code === 'skillhub.local_skill_invalid' && error?.status === 400,
    );
    assert.equal(requestCount, 0);
  });

  test('reports the supported directory-name limit when a missing name cannot be inferred', async () => {
    const skillRoot = path.join(testRoot, 'skills', 'a'.repeat(73));
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\ndescription: Valid fixture\n---\n# Instructions\n');

    await assert.rejects(
      new SkillHubService().shareLocalSkill({}, { localSkillPath: skillRoot }),
      (error: any) => error?.code === 'skillhub.local_skill_name_unrepairable'
        && /at most 72 characters/.test(error.message),
    );
  });

  test('does not list Skills with an explicitly invalid name as available', async () => {
    const invalidRoot = path.join(testRoot, 'skills', 'numeric-name');
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.writeFileSync(path.join(invalidRoot, 'SKILL.md'), '---\nname: 12\ndescription: Invalid fixture\n---\n# Instructions\n');

    await assert.rejects(
      new SkillHubService().shareLocalSkill({ skillName: 'missing-skill' }),
      (error: any) => error?.code === 'skillhub.local_skill_not_found'
        && !error.message.includes('Available skills: numeric-name'),
    );
  });

  test('logs in, persists session cookie, verifies package, and installs skill files', async () => {
    const fixture = createFixture();
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    const service = new SkillHubService();
    const auth = await service.login({ email: 'demo@example.com', password: 'passw0rd!!' });
    assert.equal(auth.authenticated, true);
    assert.equal(fs.existsSync(path.join(testRoot, 'data/skillhub/session.json')), true);

    const install = await new SkillHubService().install(fixture.entry.skillId);

    assert.equal(install.ok, true);
    assert.equal(install.skill.path, path.join(testRoot, 'skills', 'contract-review'));
    assert.equal(fs.existsSync(path.join(install.skill.path, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(install.skill.path, 'skill.json')), false);
    assert.equal(fs.existsSync(path.join(install.skill.path, 'REVIEW.json')), false);
    assert.equal(fs.existsSync(path.join(install.skill.path, 'SBOM.json')), false);
    const markerPath = path.join(install.skill.path, '.xiaoba-skillhub-install.json');
    assert.equal(fs.existsSync(markerPath), true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(marker.source, 'skillhub');
    assert.equal(marker.skillId, fixture.entry.skillId);
    assert.equal(marker.version, fixture.entry.latestVersion);
  });

  test('publication verification proves the exact signed version without installing it', async () => {
    const fixture = createFixture(true);
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;
    const files = publicationSourceFiles();
    assert.deepEqual(files.map(f => f.path).sort(), ['README.md', 'SKILL.md']);
    const service = new SkillHubService();
    assert.deepEqual(await service.verifyPublication(fixture.entry.skillId, '1.0.0', files, 5000), { status: 'published' });
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'contract-review')), false);
    const changed = files.map((f: any) => f.path === 'README.md' ? { ...f, contentBase64: Buffer.from('changed').toString('base64') } : f);
    assert.equal((await service.verifyPublication(fixture.entry.skillId, '1.0.0', changed, 5000)).status, 'verification_failed');
  });

  test('publication verification distinguishes not-ready, wrong-target and corrupted signed packages', async () => {
    const fixture = createFixture(true);
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;
    const files = publicationSourceFiles();
    const service = new SkillHubService();
    assert.equal((await service.verifyPublication('lin/not-ready', '1.0.0', files, 5000)).status, 'unverified');
    (fixture as any).allowMismatchedRequest = true;
    assert.equal((await service.verifyPublication('lin/wrong', '1.0.0', files, 5000)).status, 'verification_failed');
    fixture.packageBytes = Buffer.from(fixture.packageBytes.toString().replace('合同审查助手', '篡改后的 Skill'));
    assert.equal((await service.verifyPublication(fixture.entry.skillId, '1.0.0', files, 5000)).status, 'verification_failed');
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'contract-review')), false);
  });

  test('does not write files when package checksum verification fails', async () => {
    const fixture = createFixture();
    fixture.packageBytes = Buffer.from(fixture.packageBytes.toString('utf8').replace('合同审查助手', '篡改后的 Skill'), 'utf8');
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    await assert.rejects(
      () => new SkillHubService().install(fixture.entry.skillId),
      /checksum mismatch/i,
    );
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'contract-review')), false);
  });

  test('installs an explicit version when version detail omits latestVersion', async () => {
    const fixture = createFixture();
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    const install = await new SkillHubService().install(fixture.entry.skillId, '1.0.0');

    assert.equal(install.ok, true);
    assert.equal((fixture as any).downloadedVersion, '1.0.0');
    assert.equal(fs.existsSync(path.join(install.skill.path, 'SKILL.md')), true);
  });

  test('rejects registry entries that do not match the requested skill id', async () => {
    const fixture = createFixture();
    (fixture as any).allowMismatchedRequest = true;
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    await assert.rejects(
      () => new SkillHubService().install('lin/other-skill', '1.0.0'),
      (error: any) => error?.code === 'skillhub.registry_entry_mismatch',
    );
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'contract-review')), false);
  });

  test('shares a local page inside the single-file budget and refuses one past it', async () => {
    const skillRoot = path.join(testRoot, 'skills', 'big-page');
    fs.mkdirSync(path.join(skillRoot, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: big-page\ndescription: boundary\n---\n',
    );
    const artwork = path.join(skillRoot, 'assets', 'template.html');
    fs.writeFileSync(artwork, Buffer.alloc(3_470_090, 7));

    const bodies: any[] = [];
    const app = express();
    app.use(express.json({ limit: '32mb' }));
    app.post('/api/developer/manifest-drafts', (req, res) => {
      bodies.push(req.body);
      res.json({ ok: true });
    });
    server = app.listen(0);
    await new Promise<void>(resolve => server!.once('listening', () => resolve()));
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    await new SkillHubService().createManifestDraft({ localPath: skillRoot, name: 'big-page' });
    const files = bodies[0]?.source?.files || [];
    assert.equal(
      files.some((entry: any) => entry.path === 'assets/template.html'),
      true,
    );

    fs.writeFileSync(artwork, Buffer.alloc(5 * 1024 * 1024 + 1, 7));
    await assert.rejects(
      new SkillHubService().createManifestDraft({ localPath: skillRoot, name: 'big-page' }),
      (error: any) => error?.code === 'skillhub.local_skill_file_too_large',
    );
  });

  function publicationSourceFiles() {
    const source = path.join(testRoot, 'upload-source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: contract-review\ndescription: 审查合同条款并识别常见风险。\n---\n# 合同审查助手\n');
    fs.writeFileSync(path.join(source, 'README.md'), '# 合同审查助手\n');
    for (const name of ['skill.json', 'REVIEW.json', 'SBOM.json', '.xiaoba-skillhub-install.json']) {
      fs.writeFileSync(path.join(source, name), '{}');
    }
    return collectBotSkillPackageFiles(source);
  }

  async function startFixtureServer(fixture: ReturnType<typeof createFixture>): Promise<void> {
    const app = express();
    app.use(express.json());
    installCatsCoSkillHubExchangeRoute(app);
    app.post('/api/auth/login', (_req, res) => {
      res.setHeader('Set-Cookie', 'catsco_session=test-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
      res.json({ user: { id: 'usr_1', email: 'demo@example.com', displayName: 'Demo' }, roles: ['user'], permissions: [] });
    });
    app.get('/api/auth/me', (req, res) => {
      assert.match(req.header('cookie') || '', /catsco_session=test-session/);
      res.json({ user: { id: 'usr_1', email: 'demo@example.com', displayName: 'Demo' }, roles: ['user'], permissions: [] });
    });
    app.get('/api/trust/public-keys', (_req, res) => {
      res.json(fixture.trust);
    });
    app.get(/^\/api\/skills\/(.+)\/versions\/([^/]+)\/download$/, (req, res) => {
      (fixture as any).downloadedVersion = req.params[1];
      res.type('application/octet-stream').send(fixture.packageBytes);
    });
    app.get(/^\/api\/skills\/(.+)\/versions\/([^/]+)$/, (req, res) => {
      if (req.params[0] === 'lin/not-ready') return res.status(404).json({ error: 'not_ready' });
      if (!(fixture as any).allowMismatchedRequest) assert.equal(req.params[0], fixture.entry.skillId);
      res.json({
        version: {
          ...fixture.entry,
          latestVersion: undefined,
          version: req.params[1],
        },
      });
    });
    app.get(/^\/api\/skills\/(.+)$/, (req, res) => {
      if (!(fixture as any).allowMismatchedRequest) assert.equal(req.params[0], fixture.entry.skillId);
      res.json({ skill: fixture.entry, versions: [fixture.entry] });
    });
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

function installCatsCoSkillHubSessionRoutes(app: express.Express, onExchange?: () => void): void {
  installCatsCoSkillHubExchangeRoute(app, onExchange);
  app.get('/api/auth/me', (req, res) => {
    if (!String(req.header('cookie') || '').includes('skillhub_session=test-session')) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    return res.json({
      user: { id: 'usr_test', email: 'demo@example.com', displayName: 'Demo' },
      roles: ['user'],
      permissions: [],
    });
  });
}

function installCatsCoSkillHubExchangeRoute(app: express.Express, onExchange?: () => void): void {
  app.post('/api/auth/catsco-exchange', (req, res) => {
    assert.equal(req.body?.token, 'catsco-test-token');
    assert.equal(req.body?.user?.uid, 'usr_test');
    onExchange?.();
    res.setHeader('Set-Cookie', 'skillhub_session=test-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
    res.json({
      catsCo: { uid: 'usr_test' },
      user: { id: 'usr_test', email: 'demo@example.com', displayName: 'Demo' },
      roles: ['user'],
      permissions: [],
    });
  });
}

function createFixture(withPublicationMetadata = false) {
  const rootKeys = crypto.generateKeyPairSync('ed25519');
  const signingKeys = crypto.generateKeyPairSync('ed25519');
  const rootPublicKeyPem = rootKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const rootPrivateKeyPem = rootKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signingPublicKeyPem = signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signingPrivateKeyPem = signingKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const rootTrust: SkillHubTrustedRootKey = { keyId: 'root-test', algorithm: 'ed25519', publicKeyPem: rootPublicKeyPem };
  const signingFingerprint = fingerprint(signingPublicKeyPem);
  const certPayload = {
    schemaVersion: '1.0.0',
    subject: { keyId: 'signing-test', algorithm: 'ed25519' as const, publicKeyPem: signingPublicKeyPem, fingerprintSha256: signingFingerprint },
    issuer: { keyId: 'root-test', algorithm: 'ed25519' as const, publicKeyFingerprintSha256: fingerprint(rootPublicKeyPem) },
    usages: ['skillpkg.sign'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2036-01-01T00:00:00.000Z',
  };
  const certificate = {
    ...certPayload,
    signature: sign(certPayload, rootPrivateKeyPem, 'root-test'),
  };
  const payload = {
    packageSchemaVersion: '1.0.0',
    manifest: {
      id: 'lin/contract-review',
      name: 'contract-review',
      displayName: '合同审查助手',
      version: '1.0.0',
      description: '审查合同条款并识别常见风险。',
      entrypoints: { skillFile: 'SKILL.md' },
    },
    files: [
      file('SKILL.md', withPublicationMetadata ? applySkillHubLocalMetadata(
        '---\nname: contract-review\ndescription: 审查合同条款并识别常见风险。\n---\n\n# 合同审查助手\n',
        { author: 'lin', version: '1.0.0', uploadedAt: '2026-11-09T00:00:00.000Z' },
      ) : '---\nname: contract-review\ndescription: 审查合同条款并识别常见风险。\n---\n\n# 合同审查助手\n'),
      file('README.md', '# 合同审查助手\n'),
      file('skill.json', JSON.stringify({
        id: 'lin/contract-review',
        name: 'contract-review',
        version: '1.0.0',
        description: '审查合同条款并识别常见风险。',
      }, null, 2)),
      file('REVIEW.json', JSON.stringify({ riskLevel: 'low' }, null, 2)),
      file('SBOM.json', JSON.stringify({ files: [] }, null, 2)),
    ].filter(f => !withPublicationMetadata || !['skill.json', 'REVIEW.json', 'SBOM.json'].includes(f.path)),
  };
  const signature = sign(payload, signingPrivateKeyPem, 'signing-test');
  const packageObject = {
    payload,
    signature,
    checksum: {
      algorithm: 'sha256',
      payloadSha256: sha256(canonicalJson(payload)),
    },
  };
  const packageBytes = Buffer.from(`${canonicalJson(packageObject)}\n`, 'utf8');
  const entry = {
    skillId: payload.manifest.id,
    name: payload.manifest.name,
    displayName: payload.manifest.displayName,
    description: payload.manifest.description,
    latestVersion: payload.manifest.version,
    categories: ['法务'],
    tags: ['合同'],
    keywords: ['合同审查'],
    triggerExamples: ['帮我审查合同'],
    permissions: { filesystem: 'user_selected', network: 'none', shell: 'none', secrets: 'none' },
    runtime: { minAgentVersion: '1.0.0', platforms: ['win32', 'darwin', 'linux'] },
    riskLevel: 'low',
    packageUrl: '/ignored',
    checksumSha256: sha256(packageBytes),
    signature,
  };
  return {
    rootTrust,
    trust: {
      trustModel: 'root-signed-signing-keys' as const,
      root: { keyId: 'root-test', algorithm: 'ed25519' as const, fingerprintSha256: fingerprint(rootPublicKeyPem) },
      keys: [{ keyId: 'signing-test', algorithm: 'ed25519' as const, publicKeyPem: signingPublicKeyPem, fingerprintSha256: signingFingerprint, certificate }],
    },
    entry,
    packageBytes,
  };
}

function file(filePath: string, text: string) {
  const buffer = Buffer.from(text, 'utf8');
  return { path: filePath, size: buffer.length, sha256: sha256(buffer), contentBase64: buffer.toString('base64') };
}

function sign(payload: unknown, privateKeyPem: string, keyId: string) {
  return {
    algorithm: 'ed25519' as const,
    keyId,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString('base64'),
    signedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fingerprint(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: any): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: any): any {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}
