import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession, AgentServices } from '../src/core/agent-session';
import { SkillManager } from '../src/skills/skill-manager';
import { ToolManager } from '../src/tools/tool-manager';
import { Skill } from '../src/types/skill';
import { buildSkillActivationSignal } from '../src/skills/skill-activation-protocol';

function buildSkill(name: string, allowedTools: string[]): Skill {
  return {
    metadata: {
      name,
      description: `${name} description`,
      autoInvocable: true,
      userInvocable: true,
      toolPolicy: {
        allowedTools,
      },
    },
    content: `# ${name}\nUse this workflow`,
    filePath: `skills/${name}/SKILL.md`,
  };
}

test('agent session auto-activates mentioned skill and applies tool policy', async () => {
  const usedToolSets: string[][] = [];

  const aiService = {
    async chat(_messages: any[], tools?: any[]) {
      usedToolSets.push((tools || []).map((item: any) => item.name));
      return { content: 'ok' };
    },
    async chatStream(_messages: any[], tools?: any[]) {
      usedToolSets.push((tools || []).map((item: any) => item.name));
      return { content: 'ok' };
    },
  } as any;

  const skillManager = new SkillManager();
  (skillManager as any).skills = new Map<string, Skill>([
    ['paper-analysis', buildSkill('paper-analysis', ['read_file'])],
  ]);

  const services: AgentServices = {
    aiService,
    toolManager: new ToolManager(process.cwd()),
    skillManager,
    memoryService: null,
  };

  const session = new AgentSession('cli', services);
  await session.handleMessage('please do paper-analysis for this document');

  assert.equal(usedToolSets.length > 0, true);
  const firstCallToolNames = usedToolSets[0];

  // allowed-tools 生效：只保留 read_file + essential skill
  assert.equal(firstCallToolNames.includes('read_file'), true);
  assert.equal(firstCallToolNames.includes('skill'), true);
  assert.equal(firstCallToolNames.includes('execute_bash'), false);

  const hasSkillSystem = session.getMessages().some(
    (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[skill:paper-analysis]')
  );
  assert.equal(hasSkillSystem, true);
});

test('agent session slash skill command uses same activation protocol and tool policy', async () => {
  const usedToolSets: string[][] = [];

  const aiService = {
    async chat(_messages: any[], tools?: any[]) {
      usedToolSets.push((tools || []).map((item: any) => item.name));
      return { content: 'ok' };
    },
    async chatStream(_messages: any[], tools?: any[]) {
      usedToolSets.push((tools || []).map((item: any) => item.name));
      return { content: 'ok' };
    },
  } as any;

  const skillManager = new SkillManager();
  const skill = buildSkill('paper-analysis', ['read_file']);
  (skillManager as any).skills = new Map<string, Skill>([
    ['paper-analysis', skill],
  ]);

  const services: AgentServices = {
    aiService,
    toolManager: new ToolManager(process.cwd()),
    skillManager,
    memoryService: null,
  };

  const session = new AgentSession('cli', services);
  const result = await session.handleCommand('paper-analysis', ['dataset.md']);

  assert.equal(result.handled, true);
  assert.equal(result.reply, 'ok');
  assert.equal(usedToolSets.length > 0, true);

  const firstCallToolNames = usedToolSets[0];
  assert.equal(firstCallToolNames.includes('read_file'), true);
  assert.equal(firstCallToolNames.includes('skill'), true);
  assert.equal(firstCallToolNames.includes('execute_bash'), false);

  const expectedSignal = buildSkillActivationSignal(skill, {
    skillName: 'paper-analysis',
    arguments: ['dataset.md'],
    rawArguments: 'dataset.md',
    userMessage: '/paper-analysis dataset.md',
  });
  const expectedSystemPrompt = `[skill:${expectedSignal.skillName}]\n${expectedSignal.prompt}`;

  const skillSystemMessages = session.getMessages().filter(
    (msg) => msg.role === 'system' && msg.content?.startsWith('[skill:paper-analysis]')
  );
  assert.equal(skillSystemMessages.length, 1);
  assert.equal(skillSystemMessages[0]?.content, expectedSystemPrompt);
});

test('agent session does not auto-activate skill for attachment-only event prompt', async () => {
  const usedToolSets: string[][] = [];

  const aiService = {
    async chat(_messages: any[], tools?: any[]) {
      usedToolSets.push((tools || []).map((item: any) => item.name));
      return { content: 'ok' };
    },
    async chatStream(_messages: any[], tools?: any[]) {
      usedToolSets.push((tools || []).map((item: any) => item.name));
      return { content: 'ok' };
    },
  } as any;

  const skillManager = new SkillManager();
  (skillManager as any).skills = new Map<string, Skill>([
    ['paper-analysis', buildSkill('paper-analysis', ['read_file'])],
  ]);

  const services: AgentServices = {
    aiService,
    toolManager: new ToolManager(process.cwd()),
    skillManager,
    memoryService: null,
  };

  const session = new AgentSession('cli', services);
  await session.handleMessage([
    '[用户仅上传了附件，暂未给出明确任务]',
    '请你先判断最合理的下一步，不要默认进入任何特定 skill（例如 paper-analysis）。',
    '[用户已上传附件]',
    '[附件1] unknown_document.pdf (file)',
    '[附件路径] E:\\files\\unknown_document.pdf',
  ].join('\n'));

  assert.equal(usedToolSets.length > 0, true);
  const firstCallToolNames = usedToolSets[0];

  // 未自动激活 skill 时，工具集保持完整（包含 execute_bash）
  assert.equal(firstCallToolNames.includes('execute_bash'), true);

  const hasSkillSystem = session.getMessages().some(
    (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[skill:')
  );
  assert.equal(hasSkillSystem, false);
});
