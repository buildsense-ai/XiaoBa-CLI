import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { AgentSession, AgentServices } from './agent-session';

export interface Reminder {
  id: string;
  type: string;
  description: string;
  target_task?: string;
  trigger_at: string;
  repeat: string;
  repeat_interval_hours?: number | null;
  action: string;
  created: string;
  last_triggered: string | null;
  active: boolean;
}

export interface RemindersFile {
  reminders: Reminder[];
  next_id: number;
  updated: string;
}

const DEFAULT_REMINDERS_PATH = path.join(process.cwd(), 'skills/coo/data/reminders.json');
const CHECK_INTERVAL = 60_000;

export interface SchedulerOptions {
  remindersPath?: string;
  checkInterval?: number;
  getNow?: () => Date;
}

/**
 * Reminder Scheduler
 * 定期扫描 reminders.json，到期的 reminder 通过 COO session 执行
 */
export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private session: AgentSession | null = null;
  private remindersPath: string;
  private checkInterval: number;
  private getNow: () => Date;

  constructor(
    private agentServices: AgentServices,
    options?: SchedulerOptions,
  ) {
    this.remindersPath = options?.remindersPath ?? DEFAULT_REMINDERS_PATH;
    this.checkInterval = options?.checkInterval ?? CHECK_INTERVAL;
    this.getNow = options?.getNow ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    Logger.info('[Scheduler] 启动 reminder 扫描器');
    this.timer = setInterval(() => this.check(), this.checkInterval);
    this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    Logger.info('[Scheduler] 已停止');
  }

  /** 暴露给测试用 */
  async checkOnce(): Promise<void> {
    return this.check();
  }

  private getOrCreateSession(): AgentSession {
    if (!this.session) {
      this.session = new AgentSession('scheduler:coo', this.agentServices);
    }
    return this.session;
  }

  private async check(): Promise<void> {
    let data: RemindersFile;
    try {
      const raw = fs.readFileSync(this.remindersPath, 'utf-8');
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const now = this.getNow();
    const fired: Reminder[] = [];

    for (const r of data.reminders) {
      if (!r.active) continue;
      if (new Date(r.trigger_at) > now) continue;
      fired.push(r);
    }

    if (fired.length === 0) return;

    const session = this.getOrCreateSession();
    if (session.isBusy()) {
      Logger.info('[Scheduler] COO session 忙，跳过本轮');
      return;
    }

    for (const r of fired) {
      Logger.info(`[Scheduler] 触发 reminder ${r.id}: ${r.description}`);
      const prompt = `[reminder_triggered] id=${r.id}\n${r.action}`;
      try {
        await session.handleMessage(prompt);
      } catch (err: any) {
        Logger.error(`[Scheduler] reminder ${r.id} 执行失败: ${err.message}`);
      }
      this.updateReminderAfterFire(r, now);
    }
  }

  private updateReminderAfterFire(r: Reminder, now: Date): void {
    try {
      const raw = fs.readFileSync(this.remindersPath, 'utf-8');
      const data: RemindersFile = JSON.parse(raw);
      const target = data.reminders.find(x => x.id === r.id);
      if (!target) return;

      target.last_triggered = now.toISOString();

      if (target.repeat === 'once') {
        target.active = false;
      } else {
        const next = calcNextTrigger(target);
        if (next) target.trigger_at = next;
      }

      data.updated = now.toISOString().slice(0, 10);
      fs.writeFileSync(this.remindersPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
      Logger.error(`[Scheduler] 更新 reminder ${r.id} 失败: ${err.message}`);
    }
  }
}

/** 计算下次触发时间，导出供测试 */
export function calcNextTrigger(r: Pick<Reminder, 'trigger_at' | 'repeat' | 'repeat_interval_hours'>): string | null {
  const base = new Date(r.trigger_at);
  switch (r.repeat) {
    case 'daily':
      base.setDate(base.getDate() + 1);
      return base.toISOString();
    case 'weekly':
      base.setDate(base.getDate() + 7);
      return base.toISOString();
    case 'every_N_hours':
      if (r.repeat_interval_hours) {
        base.setTime(base.getTime() + r.repeat_interval_hours * 3600_000);
        return base.toISOString();
      }
      return null;
    default:
      return null;
  }
}
