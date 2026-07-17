import { SkillHubService } from './service';
import {
  LocalUserSkillSubscriptionStore,
  type UserSkillSubscriptionStore,
} from './subscription-store';
import { listInstalledSkillHubSkills } from './install-marker';
import type {
  SkillHubInstallResult,
  SkillHubSubscriptionScope,
  UserSkillSubscription,
} from './types';

export interface SkillHubSubscriptionGateway {
  resolveSubscriptionScope(): Promise<SkillHubSubscriptionScope>;
  install(
    skillId: string,
    version?: string,
    options?: { userId?: string; allowUpdate?: boolean },
  ): Promise<SkillHubInstallResult>;
  uninstall(input: { userId?: string; skillId: string; installName: string }): { removed: boolean; path: string };
  claimInstalledSkillOwnership?(input: { userId: string; skillId: string; installName: string }): boolean;
}

export interface SkillHubSubscriptionListResult {
  scope: 'user' | 'runtime';
  userId?: string;
  subscriptions: UserSkillSubscription[];
}

export interface SkillHubSubscribeResult {
  scope: 'user' | 'runtime';
  userId?: string;
  action: SkillHubInstallResult['skill']['action'];
  subscription: UserSkillSubscription;
}

export interface SkillHubUnsubscribeResult {
  scope: 'user' | 'runtime';
  userId?: string;
  skillId: string;
  removed: boolean;
  subscriptionFound: boolean;
}

export class SkillHubSubscriptionService {
  constructor(
    private readonly gateway: SkillHubSubscriptionGateway = new SkillHubService(),
    private readonly store: UserSkillSubscriptionStore = new LocalUserSkillSubscriptionStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<SkillHubSubscriptionListResult> {
    const scope = await this.gateway.resolveSubscriptionScope();
    if (scope.kind === 'runtime') {
      return {
        ...scopeResult(scope),
        subscriptions: runtimeSubscriptions(),
      };
    }

    const userId = scope.userId;
    const subscriptions = this.store.list(userId);
    for (const subscription of subscriptions) {
      this.gateway.claimInstalledSkillOwnership?.({
        userId,
        skillId: subscription.skillId,
        installName: subscription.installName,
      });
    }
    return { ...scopeResult(scope), subscriptions };
  }

  async subscribe(skillId: string): Promise<SkillHubSubscribeResult> {
    const scope = await this.gateway.resolveSubscriptionScope();
    const normalizedSkillId = required(skillId, 'skillId');
    const existing = scope.kind === 'user'
      ? this.store.get(scope.userId, normalizedSkillId)
      : runtimeSubscriptions().find(item => item.skillId === normalizedSkillId);
    const installed = await this.gateway.install(normalizedSkillId, undefined, {
      allowUpdate: true,
      ...(scope.kind === 'user' ? { userId: scope.userId } : {}),
    });
    const timestamp = this.now().toISOString();
    const subscription: UserSkillSubscription = {
      skillId: installed.skill.skillId,
      name: installed.skill.name,
      installName: installed.skill.installName,
      versionPolicy: 'latest',
      resolvedVersion: installed.skill.version,
      subscribedAt: existing?.subscribedAt || timestamp,
      updatedAt: timestamp,
    };
    if (scope.kind === 'user') {
      this.store.set(scope.userId, subscription);
    }
    return { ...scopeResult(scope), action: installed.skill.action, subscription };
  }

  async unsubscribe(skillId: string): Promise<SkillHubUnsubscribeResult> {
    const scope = await this.gateway.resolveSubscriptionScope();
    const normalizedSkillId = required(skillId, 'skillId');
    const subscription = scope.kind === 'user'
      ? this.store.get(scope.userId, normalizedSkillId)
      : runtimeSubscriptions().find(item => item.skillId === normalizedSkillId);
    if (!subscription) {
      return {
        ...scopeResult(scope),
        skillId: normalizedSkillId,
        removed: false,
        subscriptionFound: false,
      };
    }

    const result = this.gateway.uninstall({
      skillId: normalizedSkillId,
      installName: subscription.installName,
      ...(scope.kind === 'user' ? { userId: scope.userId } : {}),
    });
    if (scope.kind === 'user') {
      this.store.remove(scope.userId, normalizedSkillId);
    }
    return {
      ...scopeResult(scope),
      skillId: normalizedSkillId,
      removed: result.removed,
      subscriptionFound: true,
    };
  }
}

function runtimeSubscriptions(): UserSkillSubscription[] {
  return listInstalledSkillHubSkills().map(marker => ({
    skillId: marker.skillId,
    name: marker.name,
    installName: marker.installName,
    versionPolicy: 'latest',
    resolvedVersion: marker.version,
    subscribedAt: marker.installedAt,
    updatedAt: marker.installedAt,
  }));
}

function scopeResult(scope: SkillHubSubscriptionScope): { scope: 'runtime' } | { scope: 'user'; userId: string } {
  return scope.kind === 'runtime'
    ? { scope: 'runtime' }
    : { scope: 'user', userId: scope.userId };
}

function required(value: string, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${field} required`);
  return normalized;
}
