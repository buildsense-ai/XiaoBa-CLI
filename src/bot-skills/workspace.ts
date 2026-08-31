import * as fs from 'fs';
import * as path from 'path';
import { renameBotSkillWorkspaceSync } from './workspace-fs';

interface BotSkillWorkspaceState {
  schema: 'xiaoba.bot-skill-workspace.v1';
  activeBotId?: string;
  switchingTo?: string;
  switchPhase?: 'prepared' | 'previous_parked';
}

export interface BotSkillWorkspaceActivation {
  botId: string;
  path: string;
  existed: boolean;
  adoptedLegacyWorkspace: boolean;
  previousBotId?: string;
}

const WORKSPACE_SCHEMA = 'xiaoba.bot-skill-workspace.v1';

export class BotSkillWorkspaceService {
  private readonly runtimeRoot: string;
  private readonly activeRoot: string;
  private readonly parkedRoot: string;
  private readonly statePath: string;

  constructor(runtimeRoot: string, activeRoot = path.join(runtimeRoot, 'skills')) {
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.activeRoot = path.resolve(activeRoot);
    if (
      process.platform === 'win32'
      && path.parse(this.runtimeRoot).root.toLowerCase() !== path.parse(this.activeRoot).root.toLowerCase()
    ) {
      throw new Error('Bot Skill workspace override must be on the same volume as the runtime data.');
    }
    this.parkedRoot = path.join(this.runtimeRoot, 'data', 'bot-skills', 'workspaces');
    this.statePath = path.join(this.runtimeRoot, 'data', 'bot-skills', 'active.json');
  }

  activate(botId: string): BotSkillWorkspaceActivation {
    const targetBotId = normalizeBotId(botId);
    this.recoverInterruptedSwitch();
    const state = this.readState();
    if (!state.activeBotId) {
      const parked = this.parkedPath(targetBotId);
      if (fs.existsSync(this.activeRoot)) {
        this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: targetBotId });
        return {
          botId: targetBotId,
          path: this.activeRoot,
          existed: true,
          adoptedLegacyWorkspace: true,
        };
      }
      if (fs.existsSync(parked)) {
        fs.mkdirSync(path.dirname(this.activeRoot), { recursive: true });
        renameBotSkillWorkspaceSync(parked, this.activeRoot);
        this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: targetBotId });
        return {
          botId: targetBotId,
          path: this.activeRoot,
          existed: true,
          adoptedLegacyWorkspace: false,
        };
      }
      this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: targetBotId });
      return {
        botId: targetBotId,
        path: this.activeRoot,
        existed: false,
        adoptedLegacyWorkspace: false,
      };
    }
    if (state.activeBotId === targetBotId) {
      return {
        botId: targetBotId,
        path: this.activeRoot,
        existed: fs.existsSync(this.activeRoot),
        adoptedLegacyWorkspace: false,
      };
    }

    const previousBotId = normalizeBotId(state.activeBotId);
    const previousParked = this.parkedPath(previousBotId);
    const targetParked = this.parkedPath(targetBotId);
    if (fs.existsSync(previousParked)) {
      throw new Error(`Parked Bot Skill workspace already exists: ${previousParked}`);
    }
    this.writeState({
      ...state,
      schema: WORKSPACE_SCHEMA,
      switchingTo: targetBotId,
      switchPhase: 'prepared',
    });
    let previousParkedNow = false;
    try {
      fs.mkdirSync(this.parkedRoot, { recursive: true });
      if (fs.existsSync(this.activeRoot)) {
        renameBotSkillWorkspaceSync(this.activeRoot, previousParked);
        previousParkedNow = true;
      }
      this.writeState({
        schema: WORKSPACE_SCHEMA,
        activeBotId: previousBotId,
        switchingTo: targetBotId,
        switchPhase: 'previous_parked',
      });
      const targetExisted = fs.existsSync(targetParked);
      if (targetExisted) {
        renameBotSkillWorkspaceSync(targetParked, this.activeRoot);
      }
      this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: targetBotId });
      return {
        botId: targetBotId,
        path: this.activeRoot,
        existed: targetExisted,
        adoptedLegacyWorkspace: false,
        previousBotId,
      };
    } catch (error) {
      if (!fs.existsSync(this.activeRoot) && previousParkedNow && fs.existsSync(previousParked)) {
        renameBotSkillWorkspaceSync(previousParked, this.activeRoot);
      }
      this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: previousBotId });
      throw error;
    }
  }

  rollback(activation: BotSkillWorkspaceActivation): void {
    if (!activation.previousBotId) return;
    const state = this.readState();
    if (state.activeBotId !== activation.botId) return;
    const targetParked = this.parkedPath(activation.botId);
    const previousParked = this.parkedPath(activation.previousBotId);
    if (fs.existsSync(targetParked)) {
      throw new Error(`Cannot rollback Bot Skill workspace because target parking already exists: ${targetParked}`);
    }
    if (fs.existsSync(this.activeRoot)) {
      fs.mkdirSync(this.parkedRoot, { recursive: true });
      renameBotSkillWorkspaceSync(this.activeRoot, targetParked);
    }
    if (!fs.existsSync(previousParked)) {
      throw new Error(`Cannot rollback Bot Skill workspace because previous workspace is missing: ${previousParked}`);
    }
    renameBotSkillWorkspaceSync(previousParked, this.activeRoot);
    this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: activation.previousBotId });
  }

  recoverInterruptedSwitch(): void {
    const state = this.readState();
    if (!state.activeBotId || !state.switchingTo) return;
    const previousBotId = normalizeBotId(state.activeBotId);
    const targetBotId = normalizeBotId(state.switchingTo);
    const previousParked = this.parkedPath(previousBotId);
    const targetParked = this.parkedPath(targetBotId);

    if (state.switchPhase === 'prepared') {
      if (fs.existsSync(this.activeRoot)) {
        this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: previousBotId });
        return;
      }
      if (fs.existsSync(previousParked)) {
        renameBotSkillWorkspaceSync(previousParked, this.activeRoot);
        this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: previousBotId });
        return;
      }
      throw new Error('Prepared Bot Skill workspace switch cannot be recovered safely');
    }
    if (state.switchPhase !== 'previous_parked') {
      throw new Error('Bot Skill workspace switch journal is invalid');
    }
    if (fs.existsSync(this.activeRoot)) {
      this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: targetBotId });
      return;
    }
    if (fs.existsSync(targetParked)) {
      renameBotSkillWorkspaceSync(targetParked, this.activeRoot);
      this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: targetBotId });
      return;
    }
    if (fs.existsSync(previousParked)) {
      renameBotSkillWorkspaceSync(previousParked, this.activeRoot);
      this.writeState({ schema: WORKSPACE_SCHEMA, activeBotId: previousBotId });
      return;
    }
    throw new Error('Interrupted Bot Skill workspace switch cannot be recovered safely');
  }

  getActivePath(): string {
    return this.activeRoot;
  }

  getActiveBotId(): string | undefined {
    return this.readState().activeBotId;
  }

  private parkedPath(botId: string): string {
    return path.join(this.parkedRoot, normalizeBotId(botId));
  }

  private readState(): BotSkillWorkspaceState {
    if (!fs.existsSync(this.statePath)) return { schema: WORKSPACE_SCHEMA };
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as BotSkillWorkspaceState;
      if (
        value?.schema !== WORKSPACE_SCHEMA
        || (value.activeBotId !== undefined && !isValidBotId(value.activeBotId))
        || (value.switchingTo !== undefined && !isValidBotId(value.switchingTo))
        || (
          value.switchingTo !== undefined
          && value.switchPhase !== 'prepared'
          && value.switchPhase !== 'previous_parked'
        )
        || (value.switchingTo === undefined && value.switchPhase !== undefined)
      ) {
        throw new Error('Bot Skill workspace state is invalid');
      }
      return value;
    } catch (error) {
      if (error instanceof Error && error.message === 'Bot Skill workspace state is invalid') {
        throw error;
      }
      throw new Error('Bot Skill workspace state cannot be read safely');
    }
  }

  private writeState(state: BotSkillWorkspaceState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.statePath);
  }
}

function normalizeBotId(botId: string): string {
  const value = String(botId || '').trim();
  if (!isValidBotId(value)) throw new Error('Invalid Bot ID for Skill workspace');
  return value;
}

function isValidBotId(botId: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(String(botId || '').trim());
}
