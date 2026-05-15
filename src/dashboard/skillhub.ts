import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Router } from 'express';
import { PathResolver } from '../utils/path-resolver';

export type SkillHubSourceType = 'local' | 'zip' | 'github' | 'draft';
export type SkillHubSubmissionStatus =
  | 'draft'
  | 'uploaded'
  | 'manifest_generated'
  | 'scanning'
  | 'changes_requested'
  | 'review_pending'
  | 'approved'
  | 'packaging'
  | 'published'
  | 'rejected'
  | 'failed';

export type SkillHubFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface SkillHubManifest {
  schemaVersion: string;
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  category: string;
  tags: string[];
  keywords: string[];
  triggerExamples: string[];
  permissions: string[];
  publisher: {
    id: string;
    name: string;
    verified: boolean;
  };
  source?: {
    type: SkillHubSourceType;
    githubUrl?: string;
    commitSha?: string;
    localPath?: string;
  };
}

export interface SkillHubFinding {
  id: string;
  severity: SkillHubFindingSeverity;
  category: string;
  message: string;
  filePath?: string;
  resolution: 'open' | 'accepted' | 'fixed' | 'false_positive';
}

export interface SkillHubSubmission {
  id: string;
  skillId: string;
  slug: string;
  status: SkillHubSubmissionStatus;
  source: {
    type: SkillHubSourceType;
    localPath?: string;
    githubUrl?: string;
    branch?: string;
    commitSha?: string;
  };
  manifest: SkillHubManifest;
  findings: SkillHubFinding[];
  timeline: Array<{ status: SkillHubSubmissionStatus; message: string; at: string }>;
  packageArtifact?: SkillHubPackageArtifact;
  createdAt: string;
  updatedAt: string;
}

export interface SkillHubPackageArtifact {
  fileName: string;
  packageUrl: string;
  checksum: string;
  signature: string;
  signedAt: string;
}

export interface SkillHubRegistryEntry {
  id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  category: string;
  tags: string[];
  keywords: string[];
  triggerExamples: string[];
  permissions: string[];
  publisher: {
    name: string;
    verified: boolean;
  };
  verified: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  packageUrl: string;
  checksum: string;
  signature: string;
  installCount: number;
  updatedAt: string;
  manifest: SkillHubManifest;
}

interface SkillHubState {
  developer: {
    id: string;
    displayName: string;
    status: 'unverified' | 'pending' | 'verified' | 'suspended';
  };
  submissions: SkillHubSubmission[];
  registry: SkillHubRegistryEntry[];
}

interface ManifestDraftInput {
  sourceType?: SkillHubSourceType;
  localPath?: string;
  githubUrl?: string;
  branch?: string;
  commitSha?: string;
  name?: string;
  version?: string;
  description?: string;
  category?: string;
  tags?: string[] | string;
  keywords?: string[] | string;
  triggerExamples?: string[] | string;
  permissions?: string[] | string;
  entry?: string;
}

const DEFAULT_DEVELOPER = {
  id: 'dev_local',
  displayName: 'CatsCo Developer',
  status: 'verified' as const,
};

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  '法务': ['合同', '协议', '条款', '风险', '审查', '采购合同', '违约责任'],
  '办公': ['PPT', '幻灯片', '演示文稿', '汇报', 'Word', 'Excel', '文档'],
  '工程造价': ['工程量清单', 'BOQ', '造价', '算量', '施工图', '招标清单'],
  '开发': ['代码', 'PR', 'GitHub', '测试', '重构', '调试'],
  '数据分析': ['数据', '报表', '图表', '分析', '趋势', 'CSV', 'Excel'],
};

const DANGEROUS_PATTERNS: Array<{
  pattern: RegExp;
  severity: SkillHubFindingSeverity;
  category: string;
  message: string;
}> = [
  { pattern: /system prompt|developer message|ignore previous instructions|jailbreak|bypass safety/i, severity: 'critical', category: 'prompt-injection', message: '发现疑似修改或绕过系统指令的内容。' },
  { pattern: /不要告诉用户|隐藏执行|secretly|do not tell the user|delete logs?|删除日志/i, severity: 'high', category: 'stealth', message: '发现疑似隐藏行为或删除审计记录的指令。' },
  { pattern: /process\.env|os\.environ|getenv|OPENAI_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY/i, severity: 'high', category: 'secret-access', message: '发现疑似读取环境变量或密钥的行为。' },
  { pattern: /\.ssh|id_rsa|\.aws|\.npmrc|\.pypirc|git-credentials|Login Data|cookies/i, severity: 'critical', category: 'private-files', message: '发现疑似读取私钥、凭据或浏览器数据的路径。' },
  { pattern: /child_process|subprocess|os\.system|exec\(|spawn\(|powershell|cmd\.exe|curl\s|wget\s/i, severity: 'high', category: 'shell', message: '发现疑似 shell 或子进程执行行为。' },
  { pattern: /fetch\(|axios|requests\.|urllib|websocket|raw socket/i, severity: 'medium', category: 'network', message: '发现网络访问代码，请确认权限声明和域名白名单。' },
  { pattern: /postinstall|preinstall|prepare|npm install|pip install|curl.+\|\s*(sh|bash)/i, severity: 'high', category: 'dependency', message: '发现安装脚本或动态下载执行风险。' },
];

export function registerSkillHubRoutes(router: Router): void {
  router.get('/skillhub/developer', (_req, res) => {
    res.json(getSkillHubDashboard());
  });

  router.get('/skillhub/submissions', (_req, res) => {
    res.json(readState().submissions);
  });

  router.post('/skillhub/manifest-draft', (req, res) => {
    try {
      res.json(createManifestDraft(req.body || {}));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/skillhub/submissions', (req, res) => {
    try {
      const submission = createSubmission(req.body || {});
      res.status(201).json(submission);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/skillhub/submissions/:id/approve', (req, res) => {
    try {
      res.json(approveSubmission(req.params.id));
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  });

  router.get('/skillhub/registry/search', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(searchRegistry(query));
  });

  router.post('/skillhub/registry/:id/install', (req, res) => {
    try {
      res.json(installRegistrySkill(req.params.id));
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  });
}

export function getSkillHubDashboard(): any {
  const state = readState();
  const counts = state.submissions.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return {
    developer: state.developer,
    counts: {
      drafts: counts.draft || 0,
      reviewPending: counts.review_pending || 0,
      changesRequested: counts.changes_requested || 0,
      published: state.registry.filter(item => item.publisher.name === state.developer.displayName).length,
    },
    submissions: state.submissions,
    registry: state.registry,
  };
}

export function createManifestDraft(input: ManifestDraftInput): any {
  const sourceSummary = summarizeSource(input);
  const name = cleanText(input.name) || inferName(input) || '未命名 Skill';
  const category = cleanText(input.category) || inferCategory(input) || '办公';
  const description = cleanText(input.description) || `${name} 用于处理 ${category} 场景中的专业任务。`;
  const tags = uniqueWords([
    ...splitList(input.tags),
    category,
    ...sourceSummary.detectedTags,
  ]).slice(0, 8);
  const keywords = uniqueWords([
    ...splitList(input.keywords),
    ...tags,
    ...CATEGORY_KEYWORDS[category] || [],
    ...extractSearchTerms(name),
    ...extractSearchTerms(description),
  ]).slice(0, 14);
  const triggerExamples = normalizeTriggerExamples(input.triggerExamples, name, category, keywords);
  const permissions = normalizePermissions(input.permissions, sourceSummary);
  const slug = slugify(name);
  const manifest: SkillHubManifest = {
    schemaVersion: '1.0',
    id: `com.catsco.skills.${slug}`,
    name,
    version: cleanText(input.version) || '0.1.0',
    description,
    entry: cleanText(input.entry) || 'SKILL.md',
    category,
    tags,
    keywords,
    triggerExamples,
    permissions,
    publisher: {
      id: DEFAULT_DEVELOPER.id,
      name: DEFAULT_DEVELOPER.displayName,
      verified: true,
    },
    source: {
      type: input.sourceType || 'draft',
      localPath: cleanText(input.localPath),
      githubUrl: cleanText(input.githubUrl),
      commitSha: cleanText(input.commitSha),
    },
  };

  return {
    manifest,
    sourceSummary,
    suggestions: buildAgentSuggestions(manifest, sourceSummary),
    validation: validateManifest(manifest),
  };
}

export function createSubmission(input: ManifestDraftInput & { manifest?: SkillHubManifest }): SkillHubSubmission {
  const draft = input.manifest ? { manifest: input.manifest, sourceSummary: summarizeSource(input) } : createManifestDraft(input);
  const manifest = normalizeManifest(draft.manifest);
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(validation.errors.join('；'));
  }

  const now = new Date().toISOString();
  const findings = scanSkillSubmission(input, manifest);
  const hasBlockingFinding = findings.some(finding => finding.severity === 'critical' || finding.severity === 'high');
  const status: SkillHubSubmissionStatus = hasBlockingFinding ? 'changes_requested' : 'review_pending';
  const submission: SkillHubSubmission = {
    id: `sub_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    skillId: manifest.id,
    slug: slugify(manifest.name),
    status,
    source: {
      type: input.sourceType || manifest.source?.type || 'draft',
      localPath: cleanText(input.localPath || manifest.source?.localPath),
      githubUrl: cleanText(input.githubUrl || manifest.source?.githubUrl),
      branch: cleanText(input.branch),
      commitSha: cleanText(input.commitSha || manifest.source?.commitSha),
    },
    manifest,
    findings,
    timeline: [
      { status: 'uploaded', message: '已接收上传内容。', at: now },
      { status: 'manifest_generated', message: '已生成并校验 skill.json。', at: now },
      { status: 'scanning', message: '已完成基础安全扫描。', at: now },
      {
        status,
        message: hasBlockingFinding
          ? '发现高风险问题，需要修改后重新提交。'
          : '已进入等待人工审核状态。',
        at: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  const state = readState();
  state.submissions.unshift(submission);
  writeState(state);
  return submission;
}

export function approveSubmission(id: string): SkillHubSubmission {
  const state = readState();
  const submission = state.submissions.find(item => item.id === id);
  if (!submission) {
    const error: any = new Error('Submission not found');
    error.status = 404;
    throw error;
  }
  if (submission.status === 'changes_requested' || submission.status === 'rejected') {
    throw new Error('该提交仍有阻塞问题，不能上架。');
  }

  const now = new Date().toISOString();
  const artifact = packageSubmission(submission);
  submission.status = 'published';
  submission.packageArtifact = artifact;
  submission.updatedAt = now;
  submission.timeline.push({ status: 'approved', message: '人工审核已通过。', at: now });
  submission.timeline.push({ status: 'packaging', message: '已生成 .skillpkg 元数据和签名。', at: now });
  submission.timeline.push({ status: 'published', message: '已写入 SkillHub Registry。', at: now });

  const existingIndex = state.registry.findIndex(item => item.id === submission.skillId);
  const registryEntry = toRegistryEntry(submission, artifact);
  if (existingIndex >= 0) {
    state.registry[existingIndex] = registryEntry;
  } else {
    state.registry.unshift(registryEntry);
  }
  writeState(state);
  return submission;
}

export function searchRegistry(query: string): SkillHubRegistryEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  const registry = readState().registry;
  if (!normalizedQuery) return registry;

  return registry
    .map(item => ({ item, score: registrySearchScore(item, normalizedQuery) }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(result => result.item);
}

export function installRegistrySkill(id: string): any {
  const entry = readState().registry.find(item => item.id === id || item.slug === id);
  if (!entry) {
    const error: any = new Error('Skill not found in registry');
    error.status = 404;
    throw error;
  }

  const skillsRoot = PathResolver.getSkillsPath();
  const skillDir = path.join(skillsRoot, entry.slug);
  const skillFile = path.join(skillDir, entry.manifest.entry || 'SKILL.md');
  if (fs.existsSync(skillDir)) {
    const error: any = new Error('该 Skill 已安装。');
    error.status = 409;
    throw error;
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(entry.manifest, null, 2), 'utf-8');
  fs.writeFileSync(skillFile, buildSkillMarkdown(entry), 'utf-8');

  const state = readState();
  const installed = state.registry.find(item => item.id === entry.id);
  if (installed) installed.installCount += 1;
  writeState(state);

  return {
    ok: true,
    installed: {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      path: skillDir,
    },
  };
}

function readState(): SkillHubState {
  ensureState();
  return JSON.parse(fs.readFileSync(skillHubStateFile(), 'utf-8')) as SkillHubState;
}

function writeState(state: SkillHubState): void {
  fs.mkdirSync(skillHubDataDir(), { recursive: true });
  fs.writeFileSync(skillHubStateFile(), JSON.stringify(state, null, 2), 'utf-8');
}

function ensureState(): void {
  if (fs.existsSync(skillHubStateFile())) return;
  fs.mkdirSync(skillHubDataDir(), { recursive: true });
  fs.mkdirSync(skillHubPackagesDir(), { recursive: true });
  writeState({
    developer: DEFAULT_DEVELOPER,
    submissions: [],
    registry: seedRegistry(),
  });
}

function seedRegistry(): SkillHubRegistryEntry[] {
  const now = new Date().toISOString();
  return [
    seedEntry('contract-review', '合同审查助手', '审查合同条款，识别付款、违约、交付、保密等风险。', '法务', ['合同', '法务', '审查'], ['合同审查', '采购合同', '协议风险', '条款风险'], ['帮我审查这份合同', '看看这个采购合同有没有风险', '帮我找出协议里的不合理条款'], ['filesystem.read.user_selected'], now),
    seedEntry('boq-generator', '工程量清单生成', '根据施工图、工程资料和 BOQ 模板生成工程量清单草稿。', '工程造价', ['工程造价', 'BOQ', '施工图'], ['工程量清单', '图纸算量', '造价预算', '招标清单'], ['根据这个图纸文件夹生成工程量清单', '帮我做 BOQ', '把施工图整理成招标清单'], ['filesystem.read.workspace', 'filesystem.write.workspace'], now),
    seedEntry('ppt-report', 'PPT 汇报助手', '把文档、会议纪要或数据摘要整理成结构化汇报和幻灯片大纲。', '办公', ['PPT', '汇报', '办公'], ['PPT', '幻灯片', '演示文稿', '汇报材料'], ['帮我根据这份材料生成 PPT 大纲', '把会议纪要整理成汇报页', '做一个项目进展汇报'], ['filesystem.read.user_selected', 'filesystem.write.workspace'], now),
  ];
}

function seedEntry(
  slug: string,
  name: string,
  description: string,
  category: string,
  tags: string[],
  keywords: string[],
  triggerExamples: string[],
  permissions: string[],
  now: string,
): SkillHubRegistryEntry {
  const manifest: SkillHubManifest = {
    schemaVersion: '1.0',
    id: `com.catsco.skills.${slug}`,
    name,
    version: '0.1.0',
    description,
    entry: 'SKILL.md',
    category,
    tags,
    keywords,
    triggerExamples,
    permissions,
    publisher: { id: 'catsco', name: 'CatsCo', verified: true },
  };
  const checksum = checksumJson(manifest);
  return {
    id: manifest.id,
    slug,
    name,
    version: manifest.version,
    description,
    category,
    tags,
    keywords,
    triggerExamples,
    permissions,
    publisher: { name: 'CatsCo', verified: true },
    verified: true,
    riskLevel: permissions.some(permission => permission.includes('write')) ? 'medium' : 'low',
    packageUrl: `skillhub://packages/${slug}-0.1.0.skillpkg`,
    checksum,
    signature: signDigest(checksum),
    installCount: 0,
    updatedAt: now,
    manifest,
  };
}

function summarizeSource(input: ManifestDraftInput): any {
  const sourceType = input.sourceType || 'draft';
  const localPath = cleanText(input.localPath);
  const githubUrl = cleanText(input.githubUrl);
  const sourceFiles = localPath ? readSourceFiles(localPath) : [];
  const joined = [
    cleanText(input.name),
    cleanText(input.description),
    sourceFiles.map(file => file.content).join('\n'),
  ].join('\n');

  return {
    sourceType,
    localPath,
    githubUrl,
    fixedCommit: Boolean(cleanText(input.commitSha)),
    entryDetected: sourceFiles.some(file => path.basename(file.filePath).toLowerCase() === 'skill.md'),
    fileCount: sourceFiles.length,
    detectedTags: inferTagsFromText(joined),
    riskyMatches: DANGEROUS_PATTERNS.filter(rule => rule.pattern.test(joined)).map(rule => rule.category),
  };
}

function readSourceFiles(localPath: string): Array<{ filePath: string; content: string }> {
  try {
    const resolved = path.resolve(localPath);
    if (!fs.existsSync(resolved)) return [];
    const stat = fs.statSync(resolved);
    const files = stat.isDirectory() ? walkTextFiles(resolved, 50) : [resolved];
    return files.map(filePath => ({
      filePath,
      content: fs.readFileSync(filePath, 'utf-8').slice(0, 200_000),
    }));
  } catch {
    return [];
  }
}

function walkTextFiles(root: string, limit: number): string[] {
  const results: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'release', '__pycache__']);
  const visit = (dir: string): void => {
    if (results.length >= limit) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= limit) return;
      if (skip.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (/\.(md|json|ts|js|py|txt|yml|yaml)$/i.test(entry.name)) {
        const size = fs.statSync(fullPath).size;
        if (size <= 512_000) results.push(fullPath);
      }
    }
  };
  visit(root);
  return results;
}

function scanSkillSubmission(input: ManifestDraftInput, manifest: SkillHubManifest): SkillHubFinding[] {
  const findings: SkillHubFinding[] = [];
  const sourceFiles = input.localPath ? readSourceFiles(input.localPath) : [];
  const scanTargets = [
    { filePath: 'skill.json', content: JSON.stringify(manifest) },
    ...sourceFiles,
  ];

  if ((input.sourceType === 'github' || manifest.source?.type === 'github') && !cleanText(input.commitSha || manifest.source?.commitSha)) {
    findings.push(createFinding('medium', 'source', 'GitHub 来源需要固定 commit SHA，不能直接引用 main/latest。', 'source'));
  }
  if (manifest.permissions.includes('network.any')) {
    findings.push(createFinding('high', 'permission', 'MVP 不允许申请任意网络访问，请改为声明具体域名。', 'skill.json'));
  }
  if (manifest.permissions.includes('shell.exec')) {
    findings.push(createFinding('high', 'permission', 'MVP 不允许任意 shell 执行。', 'skill.json'));
  }

  for (const target of scanTargets) {
    for (const rule of DANGEROUS_PATTERNS) {
      if (rule.pattern.test(target.content)) {
        findings.push(createFinding(rule.severity, rule.category, rule.message, target.filePath));
      }
    }
  }

  return dedupeFindings(findings);
}

function createFinding(
  severity: SkillHubFindingSeverity,
  category: string,
  message: string,
  filePath?: string,
): SkillHubFinding {
  return {
    id: `finding_${crypto.randomBytes(4).toString('hex')}`,
    severity,
    category,
    message,
    filePath,
    resolution: 'open',
  };
}

function dedupeFindings(findings: SkillHubFinding[]): SkillHubFinding[] {
  const seen = new Set<string>();
  return findings.filter(finding => {
    const key = `${finding.severity}:${finding.category}:${finding.filePath}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function packageSubmission(submission: SkillHubSubmission): SkillHubPackageArtifact {
  fs.mkdirSync(skillHubPackagesDir(), { recursive: true });
  const fileName = `${submission.slug}-${submission.manifest.version}.skillpkg.json`;
  const artifactPath = path.join(skillHubPackagesDir(), fileName);
  const payload = {
    packageFormatVersion: '1.0',
    submissionId: submission.id,
    manifest: submission.manifest,
    review: {
      findings: submission.findings,
      publishedAt: new Date().toISOString(),
    },
  };
  const checksum = checksumJson(payload);
  fs.writeFileSync(artifactPath, JSON.stringify(payload, null, 2), 'utf-8');
  return {
    fileName,
    packageUrl: `skillhub://packages/${fileName}`,
    checksum,
    signature: signDigest(checksum),
    signedAt: new Date().toISOString(),
  };
}

function skillHubDataDir(): string {
  return path.join(process.cwd(), 'data', 'skillhub');
}

function skillHubStateFile(): string {
  return path.join(skillHubDataDir(), 'state.json');
}

function skillHubPackagesDir(): string {
  return path.join(skillHubDataDir(), 'packages');
}

function toRegistryEntry(submission: SkillHubSubmission, artifact: SkillHubPackageArtifact): SkillHubRegistryEntry {
  return {
    id: submission.skillId,
    slug: submission.slug,
    name: submission.manifest.name,
    version: submission.manifest.version,
    description: submission.manifest.description,
    category: submission.manifest.category,
    tags: submission.manifest.tags,
    keywords: submission.manifest.keywords,
    triggerExamples: submission.manifest.triggerExamples,
    permissions: submission.manifest.permissions,
    publisher: {
      name: submission.manifest.publisher.name,
      verified: submission.manifest.publisher.verified,
    },
    verified: true,
    riskLevel: submission.findings.some(finding => finding.severity === 'medium') ? 'medium' : 'low',
    packageUrl: artifact.packageUrl,
    checksum: artifact.checksum,
    signature: artifact.signature,
    installCount: 0,
    updatedAt: new Date().toISOString(),
    manifest: submission.manifest,
  };
}

function buildSkillMarkdown(entry: SkillHubRegistryEntry): string {
  return [
    '---',
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    '---',
    '',
    `# ${entry.name}`,
    '',
    entry.description,
    '',
    '## 适用场景',
    '',
    ...entry.triggerExamples.map(example => `- ${example}`),
    '',
    '## 使用边界',
    '',
    `权限：${entry.permissions.join(', ') || '无特殊权限'}`,
    '',
    '请只在用户明确提供的材料和授权范围内使用本 Skill。',
    '',
  ].join('\n');
}

function normalizeManifest(manifest: SkillHubManifest): SkillHubManifest {
  return {
    ...manifest,
    schemaVersion: manifest.schemaVersion || '1.0',
    id: cleanText(manifest.id) || `com.catsco.skills.${slugify(manifest.name)}`,
    name: cleanText(manifest.name) || '未命名 Skill',
    version: cleanText(manifest.version) || '0.1.0',
    description: cleanText(manifest.description) || '暂无描述。',
    entry: cleanText(manifest.entry) || 'SKILL.md',
    category: cleanText(manifest.category) || '办公',
    tags: uniqueWords(manifest.tags || []),
    keywords: uniqueWords(manifest.keywords || []),
    triggerExamples: uniqueWords(manifest.triggerExamples || []),
    permissions: uniqueWords(manifest.permissions || []),
    publisher: manifest.publisher || {
      id: DEFAULT_DEVELOPER.id,
      name: DEFAULT_DEVELOPER.displayName,
      verified: true,
    },
  };
}

function validateManifest(manifest: SkillHubManifest): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!manifest.name) errors.push('缺少 Skill 名称');
  if (!manifest.description) errors.push('缺少简介');
  if (!manifest.entry) errors.push('缺少入口文件');
  if (!/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.test(manifest.version)) errors.push('版本号需要符合 SemVer，例如 0.1.0');
  if (!/^com\.catsco\.skills\.[a-z0-9][a-z0-9-]*$/.test(manifest.id)) errors.push('Skill ID 需要使用 com.catsco.skills.slug 格式');
  if (!manifest.triggerExamples || manifest.triggerExamples.length < 3) errors.push('至少需要 3 条自然语言触发示例');
  return { valid: errors.length === 0, errors };
}

function buildAgentSuggestions(manifest: SkillHubManifest, sourceSummary: any): any[] {
  const suggestions: any[] = [
    {
      id: 'keywords',
      title: '补全搜索关键词',
      confidence: 'high',
      detail: `建议使用：${manifest.keywords.slice(0, 8).join('、')}`,
      field: 'keywords',
      value: manifest.keywords,
    },
    {
      id: 'triggerExamples',
      title: '生成自然语言触发示例',
      confidence: 'medium',
      detail: manifest.triggerExamples.join('；'),
      field: 'triggerExamples',
      value: manifest.triggerExamples,
    },
  ];
  if (!sourceSummary.fixedCommit && sourceSummary.sourceType === 'github') {
    suggestions.push({
      id: 'githubCommit',
      title: '固定 GitHub commit',
      confidence: 'high',
      detail: '提交审核前需要填写 commit SHA，避免 main/latest 后续变化影响已审核版本。',
      field: 'commitSha',
      value: '',
    });
  }
  if (sourceSummary.riskyMatches.length > 0) {
    suggestions.push({
      id: 'risk',
      title: '需要处理风险信号',
      confidence: 'high',
      detail: `自动扫描发现：${sourceSummary.riskyMatches.join('、')}`,
      field: 'security',
      value: sourceSummary.riskyMatches,
    });
  }
  return suggestions;
}

function normalizeTriggerExamples(input: string[] | string | undefined, name: string, category: string, keywords: string[]): string[] {
  const existing = splitList(input);
  const primary = keywords[0] || category || name;
  return uniqueWords([
    ...existing,
    `帮我处理${primary}相关任务`,
    `根据我提供的材料使用${name}`,
    `检查这份材料里和${primary}有关的问题`,
  ]).slice(0, 6);
}

function normalizePermissions(input: string[] | string | undefined, sourceSummary: any): string[] {
  const permissions = splitList(input);
  if (permissions.length > 0) return uniqueWords(permissions);
  if (sourceSummary.riskyMatches.includes('network')) return ['network.review_required'];
  return ['filesystem.read.user_selected'];
}

function inferName(input: ManifestDraftInput): string {
  const localPath = cleanText(input.localPath);
  if (localPath) return titleFromSlug(path.basename(localPath).replace(/\.(zip|skillpkg)$/i, ''));
  const githubUrl = cleanText(input.githubUrl);
  if (githubUrl) {
    const parts = githubUrl.replace(/\.git$/i, '').split('/').filter(Boolean);
    return titleFromSlug(parts[parts.length - 1] || '');
  }
  return '';
}

function inferCategory(input: ManifestDraftInput): string {
  const text = [
    cleanText(input.name),
    cleanText(input.description),
    splitList(input.tags).join(' '),
    splitList(input.keywords).join(' '),
  ].join(' ');
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()))) return category;
  }
  return '';
}

function inferTagsFromText(text: string): string[] {
  const tags: string[] = [];
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()))) tags.push(category);
  }
  return tags;
}

function extractSearchTerms(text: string): string[] {
  return text
    .split(/[,\s，。；;、/|]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2 && item.length <= 24);
}

function splitList(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return cleanText(value).split(/[,\n，、;；]+/).map(item => item.trim()).filter(Boolean);
}

function uniqueWords(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    results.push(cleaned);
  }
  return results;
}

function cleanText(value: unknown): string {
  return String(value || '').trim();
}

function slugify(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii;
  const chineseHints: Array<[RegExp, string]> = [
    [/合同|法务|协议/, 'contract-review'],
    [/工程量|BOQ|造价|算量|施工图/i, 'boq-generator'],
    [/PPT|幻灯片|汇报|演示/i, 'ppt-report'],
    [/文档|摘要|Word/i, 'document-helper'],
    [/数据|报表|分析/i, 'data-analysis'],
  ];
  const matched = chineseHints.find(([pattern]) => pattern.test(value));
  if (matched) return matched[1];
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 10);
}

function titleFromSlug(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function checksumJson(value: unknown): string {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function signDigest(digest: string): string {
  return 'ed25519-local:' + crypto.createHash('sha256').update(`catsco-local:${digest}`).digest('hex');
}

function registrySearchScore(item: SkillHubRegistryEntry, query: string): number {
  const fields = [
    item.name,
    item.description,
    item.category,
    ...item.tags,
    ...item.keywords,
    ...item.triggerExamples,
  ].map(value => value.toLowerCase());
  let score = 0;
  for (const field of fields) {
    if (field === query) score += 20;
    if (field.includes(query)) score += 8;
    if (field.length >= 2 && field.length <= 18 && query.includes(field)) score += 5;
  }
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (fields.some(field => field.includes(token))) score += 3;
  }
  return score;
}
