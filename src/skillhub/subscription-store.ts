import * as fs from 'fs';
import * as path from 'path';
import { loadSkillHubConfig } from './config';
import type { UserSkillSubscription } from './types';

const SUBSCRIPTION_SCHEMA = 'xiaoba.skillhub.subscriptions.v2';
const LEGACY_SUBSCRIPTION_SCHEMA = 'xiaoba.skillhub.subscriptions.v1';

interface SubscriptionStateFile {
  schema: typeof SUBSCRIPTION_SCHEMA;
  users: Record<string, Record<string, UserSkillSubscription>>;
}

interface LegacySubscriptionStateFile {
  schema: typeof LEGACY_SUBSCRIPTION_SCHEMA;
  agents: Record<string, Record<string, UserSkillSubscription>>;
}

export interface UserSkillSubscriptionStore {
  list(userId: string): UserSkillSubscription[];
  get(userId: string, skillId: string): UserSkillSubscription | undefined;
  set(userId: string, subscription: UserSkillSubscription): void;
  remove(userId: string, skillId: string): boolean;
}

export class LocalUserSkillSubscriptionStore implements UserSkillSubscriptionStore {
  constructor(
    private readonly filePath = path.join(loadSkillHubConfig().dataDir, 'subscriptions.json'),
  ) {}

  list(userId: string): UserSkillSubscription[] {
    const key = requiredKey(userId, 'userId');
    return Object.values(this.read(key).users[key] || {})
      .sort((left, right) => left.skillId.localeCompare(right.skillId));
  }

  get(userId: string, skillId: string): UserSkillSubscription | undefined {
    const userKey = requiredKey(userId, 'userId');
    const skillKey = requiredKey(skillId, 'skillId');
    return this.read(userKey).users[userKey]?.[skillKey];
  }

  set(userId: string, subscription: UserSkillSubscription): void {
    const userKey = requiredKey(userId, 'userId');
    const skillKey = requiredKey(subscription.skillId, 'skillId');
    const state = this.read(userKey);
    state.users[userKey] = state.users[userKey] || {};
    state.users[userKey][skillKey] = { ...subscription, skillId: skillKey };
    this.write(state);
  }

  remove(userId: string, skillId: string): boolean {
    const userKey = requiredKey(userId, 'userId');
    const skillKey = requiredKey(skillId, 'skillId');
    const state = this.read(userKey);
    if (!state.users[userKey]?.[skillKey]) return false;
    delete state.users[userKey][skillKey];
    if (Object.keys(state.users[userKey]).length === 0) delete state.users[userKey];
    this.write(state);
    return true;
  }

  private read(userId: string): SubscriptionStateFile {
    if (!fs.existsSync(this.filePath)) return emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      if (isCurrentState(parsed)) return parsed;
      if (isLegacyState(parsed)) {
        const migrated = migrateLegacyState(parsed, userId);
        this.write(migrated);
        return migrated;
      }
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  private write(state: SubscriptionStateFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}

function emptyState(): SubscriptionStateFile {
  return { schema: SUBSCRIPTION_SCHEMA, users: {} };
}

function isCurrentState(value: unknown): value is SubscriptionStateFile {
  const state = value as Partial<SubscriptionStateFile> | null;
  return state?.schema === SUBSCRIPTION_SCHEMA && Boolean(state.users) && typeof state.users === 'object';
}

function isLegacyState(value: unknown): value is LegacySubscriptionStateFile {
  const state = value as Partial<LegacySubscriptionStateFile> | null;
  return state?.schema === LEGACY_SUBSCRIPTION_SCHEMA && Boolean(state.agents) && typeof state.agents === 'object';
}

function migrateLegacyState(legacy: LegacySubscriptionStateFile, userId: string): SubscriptionStateFile {
  const subscriptions: Record<string, UserSkillSubscription> = {};
  for (const bucket of Object.values(legacy.agents)) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const subscription of Object.values(bucket)) {
      const skillId = String(subscription?.skillId || '').trim();
      if (!skillId) continue;
      const current = subscriptions[skillId];
      if (!current || timestamp(subscription.updatedAt) >= timestamp(current.updatedAt)) {
        subscriptions[skillId] = { ...subscription, skillId };
      }
    }
  }
  return {
    schema: SUBSCRIPTION_SCHEMA,
    users: Object.keys(subscriptions).length ? { [userId]: subscriptions } : {},
  };
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function requiredKey(value: string, field: string): string {
  const key = String(value || '').trim();
  if (!key) throw new Error(`${field} required`);
  return key;
}
