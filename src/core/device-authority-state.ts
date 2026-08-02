import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ExecutionScope,
  ScopedDeviceGrantSnapshot,
  ScopedDeviceSelection,
} from '../types/session-identity';
import type {
  DeviceAuthorityLease,
  DeviceAuthorityReplacement,
  DeviceAuthorityView,
  TargetRoutes,
  ToolExecutionContext,
} from '../types/tool';
import { deviceGrantSnapshotCanonicalValue } from './device-grants';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';

interface DeviceAuthorityWatermark {
  schema: 'xiaoba.device_authority_watermark.v1';
  scopeHash: string;
  revision: number;
  authorityDigest: string;
  revoked: boolean;
}

export class DeviceAuthorityState implements DeviceAuthorityLease {
  private current: DeviceAuthorityView = { generation: 0 };
  private currentMessageSeq = 0;
  private currentSelectionDigest?: string;
  private watermark?: DeviceAuthorityWatermark;
  private integrityFailure = false;
  private requiresNewerRevisionAfterRestart = false;
  private readonly scopeHash: string;
  private readonly watermarkPath?: string;
  private readonly pendingPath?: string;
  private readonly establishedPath?: string;
  private readonly failedPath?: string;

  constructor(
    private readonly scope: ExecutionScope,
    options: { watermarkDirectory?: string | null } = {},
  ) {
    this.scopeHash = hashText(scopeCanonicalValue(scope));
    const directory = options.watermarkDirectory === null
      ? undefined
      : options.watermarkDirectory || defaultWatermarkDirectory();
    this.watermarkPath = directory
      ? path.join(directory, `${this.scopeHash}.json`)
      : undefined;
    this.pendingPath = this.watermarkPath ? `${this.watermarkPath}.pending` : undefined;
    this.establishedPath = this.watermarkPath ? `${this.watermarkPath}.established` : undefined;
    this.failedPath = this.watermarkPath ? `${this.watermarkPath}.failed` : undefined;
    if (options.watermarkDirectory !== null && !directory) this.integrityFailure = true;
    this.watermark = this.readWatermark();
    this.currentMessageSeq = this.watermark?.revision ?? 0;
    this.requiresNewerRevisionAfterRestart = Boolean(this.watermark && !this.watermark.revoked);
  }

  getCurrent(): DeviceAuthorityView {
    if (!this.integrityFailure && this.hasPersistentIntegrityEvidence()) {
      this.integrityFailure = true;
      if (
        this.current.deviceGrantSnapshot
        || this.current.deviceGrants
        || this.current.deviceSelection
        || this.current.targetRoutes
      ) {
        this.current = { generation: this.current.generation + 1 };
        this.currentSelectionDigest = undefined;
      }
    }
    return cloneView(this.current);
  }

  /**
   * Persists a fail-closed revision floor when canonical authority arrives
   * before an AgentSession exists. A future session must observe a strictly
   * newer complete snapshot before it can authorize the scope again.
   */
  persistRevokedFloor(revisionInput: number): boolean {
    const revision = normalizeRevision(revisionInput);
    if (revision === undefined || this.integrityFailure) return false;
    this.revokeAtSequence(revision, 'connector_deferred_floor');
    return !this.integrityFailure
      && Boolean(this.watermark?.revoked)
      && (this.watermark?.revision ?? 0) >= revision;
  }

  matchesExecutionScope(scope: ExecutionScope): boolean {
    return sameExecutionScope(this.scope, scope);
  }

  replace(input: DeviceAuthorityReplacement): DeviceAuthorityView {
    const snapshot = input.deviceGrantSnapshot;
    if (this.integrityFailure) return this.clearCurrent('watermark_integrity_failure');
    if (!input.executionScope || !sameExecutionScope(this.scope, input.executionScope)) {
      return this.clearCurrent('scope_mismatch');
    }
    // An omitted canonical field is not an authority update. Explicit empty or
    // invalid snapshots are represented by a present snapshot with no grants.
    if (!snapshot) return this.replaceSelectionOnly(input);
    if (!snapshotMatchesScope(snapshot, this.scope)) return this.clearCurrent('snapshot_scope_mismatch');

    const revision = normalizeRevision(snapshot.revision);
    const watermark = this.watermark;
    if (revision === undefined) {
      Logger.warning('[DeviceAuthority] canonical snapshot has no trusted revision; authority cleared');
      if (watermark) {
        this.persistWatermark({
          schema: 'xiaoba.device_authority_watermark.v1',
          scopeHash: this.scopeHash,
          revision: watermark.revision,
          authorityDigest: revokedAuthorityDigest(watermark.revision),
          revoked: true,
        });
      }
      return this.clearCurrent('unversioned_snapshot');
    }
    const authorityDigest = hashText(deviceAuthorityReplacementCanonicalValue(
      snapshot,
      input.deviceSelection,
      input.targetRoutes,
    ));
    if (revision < this.currentMessageSeq) {
      Logger.warning(
        `[DeviceAuthority] ignored snapshot revision=${revision} behind live sequence=${this.currentMessageSeq}`,
      );
      return this.getCurrent();
    }
    if (
      revision === this.currentMessageSeq
      && watermark
      && this.currentMessageSeq > watermark.revision
    ) {
      Logger.warning(
        `[DeviceAuthority] full snapshot conflicts with selection-delta floor=${this.currentMessageSeq}`,
      );
      return this.revokeAtSequence(revision, 'same_revision_delta_snapshot_conflict');
    }
    if (watermark && revision !== undefined && revision < watermark.revision) {
      Logger.warning(
        `[DeviceAuthority] ignored stale snapshot revision=${revision} current=${watermark.revision}`,
      );
      return this.current.deviceGrantSnapshot
        ? this.getCurrent()
        : this.clearCurrent('stale_after_restart');
    }
    if (
      watermark
      && this.requiresNewerRevisionAfterRestart
      && revision !== undefined
      && revision <= watermark.revision
    ) {
      Logger.warning(
        `[DeviceAuthority] restart requires a newer snapshot revision than ${watermark.revision}`,
      );
      return this.clearCurrent('restart_requires_newer_revision');
    }
    if (
      watermark
      && revision === watermark.revision
      && authorityDigest !== watermark.authorityDigest
    ) {
      Logger.warning(
        `[DeviceAuthority] conflicting snapshot revision=${revision}; authority cleared`,
      );
      this.persistWatermark({
        schema: 'xiaoba.device_authority_watermark.v1',
        scopeHash: this.scopeHash,
        revision,
        authorityDigest: revokedAuthorityDigest(revision),
        revoked: true,
      });
      return this.clearCurrent('same_revision_conflict');
    }
    if (watermark?.revoked && revision === watermark.revision) {
      return this.clearCurrent('same_revision_revoked');
    }

    const nextSnapshot = cloneSnapshot(snapshot);
    const next: DeviceAuthorityView = {
      generation: this.current.generation + 1,
      deviceGrants: nextSnapshot.grants.length > 0
        ? nextSnapshot.grants.map(cloneGrant)
        : undefined,
      deviceGrantSnapshot: nextSnapshot,
      deviceSelection: snapshot.grants.length > 0 ? cloneSelection(input.deviceSelection) : undefined,
      targetRoutes: snapshot.grants.length > 0 ? cloneTargetRoutes(input.targetRoutes) : undefined,
    };
    if (revision !== undefined && (!watermark || revision >= watermark.revision)) {
      if (!this.persistWatermark({
        schema: 'xiaoba.device_authority_watermark.v1',
        scopeHash: this.scopeHash,
        revision,
        authorityDigest,
        revoked: snapshot.grants.length === 0,
      })) return this.clearCurrent('watermark_persist_failed');
    }
    this.current = next;
    this.currentMessageSeq = Math.max(
      revision,
      normalizeRevision(input.executionScope.channelSeq) ?? 0,
    );
    this.currentSelectionDigest = selectionDeltaCanonicalValue(
      next.deviceSelection,
      next.targetRoutes,
    );
    return this.getCurrent();
  }

  private replaceSelectionOnly(input: DeviceAuthorityReplacement): DeviceAuthorityView {
    const selection = input.deviceSelection;
    if (!selection && !input.targetRoutes) return this.getCurrent();
    const sequence = normalizeRevision(input.executionScope?.channelSeq);
    if (sequence === undefined) {
      const floor = this.watermark?.revision ?? this.currentMessageSeq;
      return floor > 0
        ? this.revokeAtSequence(floor, 'unversioned_selection_delta')
        : this.getCurrent();
    }
    if (sequence < this.currentMessageSeq) return this.getCurrent();
    if (!selection || !selectionMatchesScope(selection, this.scope)) {
      return this.revokeAtSequence(sequence, 'invalid_selection_delta');
    }
    if (!this.current.deviceGrantSnapshot || !this.current.deviceGrants?.length) {
      return this.revokeAtSequence(sequence, 'selection_without_grants');
    }

    const normalizedSelection = narrowSelectionToCurrentGrants(
      selection,
      this.current.deviceGrants,
      this.scope,
    );
    const nextRoutes = input.targetRoutes
      ? cloneTargetRoutes(input.targetRoutes)
      : cloneTargetRoutes(this.current.targetRoutes);
    const digest = selectionDeltaCanonicalValue(normalizedSelection, nextRoutes);
    if (sequence === this.currentMessageSeq) {
      if (digest === this.currentSelectionDigest) return this.getCurrent();
      return this.revokeAtSequence(sequence, 'same_revision_selection_conflict');
    }

    const effectiveAuthorityDigest = hashText(deviceAuthorityFragmentCanonicalValue(
      this.current.deviceGrantSnapshot,
      normalizedSelection,
      nextRoutes,
    ));
    if (!this.persistWatermark({
      schema: 'xiaoba.device_authority_watermark.v1',
      scopeHash: this.scopeHash,
      revision: sequence,
      authorityDigest: effectiveAuthorityDigest,
      revoked: false,
    })) return this.clearCurrent('selection_watermark_persist_failed');

    this.current = {
      generation: this.current.generation + 1,
      deviceGrants: this.current.deviceGrants.map(cloneGrant),
      deviceGrantSnapshot: cloneSnapshot(this.current.deviceGrantSnapshot),
      deviceSelection: normalizedSelection,
      targetRoutes: nextRoutes,
    };
    this.currentMessageSeq = sequence;
    this.currentSelectionDigest = digest;
    return this.getCurrent();
  }

  private revokeAtSequence(sequence: number, _reason: string): DeviceAuthorityView {
    const floor = Math.max(sequence, this.watermark?.revision ?? 0, this.currentMessageSeq);
    this.persistWatermark({
      schema: 'xiaoba.device_authority_watermark.v1',
      scopeHash: this.scopeHash,
      revision: floor,
      authorityDigest: revokedAuthorityDigest(floor),
      revoked: true,
    });
    this.currentMessageSeq = floor;
    this.currentSelectionDigest = undefined;
    return this.clearCurrent('revision_conflict');
  }

  private clearCurrent(_reason: string): DeviceAuthorityView {
    if (
      this.current.deviceGrantSnapshot
      || this.current.deviceGrants
      || this.current.deviceSelection
      || this.current.targetRoutes
    ) {
      this.current = { generation: this.current.generation + 1 };
      this.currentSelectionDigest = undefined;
    }
    return this.getCurrent();
  }

  private readWatermark(): DeviceAuthorityWatermark | undefined {
    if (!this.watermarkPath) return undefined;
    if (
      (this.pendingPath && fs.existsSync(this.pendingPath))
      || (this.failedPath && fs.existsSync(this.failedPath))
    ) {
      this.integrityFailure = true;
      Logger.warning('[DeviceAuthority] incomplete watermark transaction; authority disabled for scope');
      return undefined;
    }
    if (this.establishedPath) {
      const watermarkExists = fs.existsSync(this.watermarkPath);
      const establishedExists = fs.existsSync(this.establishedPath);
      if (watermarkExists !== establishedExists) {
        this.integrityFailure = true;
        Logger.warning('[DeviceAuthority] watermark establishment is incomplete; authority disabled for scope');
        return undefined;
      }
      if (establishedExists) {
        try {
          if (fs.readFileSync(this.establishedPath, 'utf8').trim() !== this.scopeHash) {
            this.integrityFailure = true;
            Logger.warning('[DeviceAuthority] dirty watermark transaction; authority disabled for scope');
            return undefined;
          }
        } catch (error: any) {
          this.integrityFailure = true;
          Logger.warning(`[DeviceAuthority] failed to read establishment marker: ${error?.message || error}`);
          return undefined;
        }
      }
    }
    return this.readWatermarkFile();
  }

  private readWatermarkFile(): DeviceAuthorityWatermark | undefined {
    if (!this.watermarkPath) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.watermarkPath, 'utf8')) as Partial<DeviceAuthorityWatermark>;
      if (
        parsed.schema !== 'xiaoba.device_authority_watermark.v1'
        || parsed.scopeHash !== this.scopeHash
        || !normalizeRevision(parsed.revision)
        || typeof parsed.authorityDigest !== 'string'
        || typeof parsed.revoked !== 'boolean'
      ) {
        this.integrityFailure = true;
        Logger.warning('[DeviceAuthority] invalid watermark; authority disabled for scope');
        return undefined;
      }
      return parsed as DeviceAuthorityWatermark;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.integrityFailure = true;
        Logger.warning(`[DeviceAuthority] failed to read watermark: ${error?.message || error}`);
      }
      return undefined;
    }
  }

  private persistWatermark(watermark: DeviceAuthorityWatermark): boolean {
    if (this.watermark && watermark.revision < this.watermark.revision) {
      Logger.warning(
        `[DeviceAuthority] refused watermark rollback ${this.watermark.revision}->${watermark.revision}`,
      );
      return false;
    }
    if (!this.watermarkPath || !this.pendingPath || !this.establishedPath || !this.failedPath) {
      this.watermark = watermark;
      this.requiresNewerRevisionAfterRestart = false;
      return true;
    }
    if (fs.existsSync(this.failedPath)) {
      this.integrityFailure = true;
      return false;
    }
    let temporaryPath: string | undefined;
    let pendingFd: number | undefined;
    try {
      const directory = path.dirname(this.watermarkPath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        pendingFd = this.openPendingTransaction();
      } catch (error: any) {
        this.recordPreTransactionFailure(error);
        throw error;
      }
      try {
        fs.writeFileSync(pendingFd, `${this.scopeHash}\n`, 'utf8');
        fs.fsyncSync(pendingFd);
      } finally {
        fs.closeSync(pendingFd);
        pendingFd = undefined;
      }
      fsyncDirectory(directory);

      const transactionId = hashText(`${this.scopeHash}:${randomUUID()}`);
      this.writeEstablishedMarker(`dirty:${transactionId}`);

      const diskWatermark = this.readWatermarkFile();
      if (this.integrityFailure) throw new Error('invalid persisted authority watermark');
      let effective = watermark;
      let candidateAccepted = true;
      if (diskWatermark && diskWatermark.revision > watermark.revision) {
        effective = diskWatermark;
        candidateAccepted = false;
      } else if (
        diskWatermark
        && diskWatermark.revision === watermark.revision
        && (
          diskWatermark.authorityDigest !== watermark.authorityDigest
          || diskWatermark.revoked !== watermark.revoked
        )
      ) {
        effective = {
          schema: 'xiaoba.device_authority_watermark.v1',
          scopeHash: this.scopeHash,
          revision: watermark.revision,
          authorityDigest: revokedAuthorityDigest(watermark.revision),
          revoked: true,
        };
        candidateAccepted = watermark.revoked
          && watermark.authorityDigest === effective.authorityDigest;
      }

      temporaryPath = path.join(directory, `.${this.scopeHash}.${randomUUID()}.tmp`);
      const temporaryFd = fs.openSync(temporaryPath, 'wx', 0o600);
      try {
        fs.writeFileSync(temporaryFd, `${JSON.stringify(effective)}\n`, 'utf8');
        fs.fsyncSync(temporaryFd);
      } finally {
        fs.closeSync(temporaryFd);
      }
      fs.renameSync(temporaryPath, this.watermarkPath);
      temporaryPath = undefined;
      try { fs.chmodSync(this.watermarkPath, 0o600); } catch { /* best effort */ }
      fsyncDirectory(directory);
      this.writeEstablishedMarker(this.scopeHash);
      fs.unlinkSync(this.pendingPath);
      fsyncDirectory(directory);
      this.watermark = effective;
      this.requiresNewerRevisionAfterRestart = false;
      return candidateAccepted;
    } catch (error: any) {
      this.integrityFailure = true;
      if (pendingFd !== undefined) {
        try { fs.closeSync(pendingFd); } catch { /* best effort; marker remains */ }
      }
      if (temporaryPath) {
        try { fs.unlinkSync(temporaryPath); } catch { /* transaction marker remains fail-closed */ }
      }
      Logger.warning(`[DeviceAuthority] failed to persist watermark: ${error?.message || error}`);
      return false;
    }
  }

  private recordPreTransactionFailure(error: any): void {
    if (!this.failedPath || !this.establishedPath) return;
    if (error?.code === 'EEXIST') {
      try {
        const fd = fs.openSync(this.failedPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, `${this.scopeHash}\n`, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fsyncDirectory(path.dirname(this.failedPath));
        return;
      } catch { /* fall through to the existing marker */ }
    }
    try {
      if (fs.existsSync(this.establishedPath)) {
        this.writeEstablishedMarker(`dirty:${hashText(`${this.scopeHash}:${randomUUID()}`)}`);
      }
    } catch { /* the local state still fails closed */ }
  }

  private openPendingTransaction(): number {
    if (!this.pendingPath) throw new Error('authority pending path is unavailable');
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    let lastError: any;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        return fs.openSync(this.pendingPath, 'wx', 0o600);
      } catch (error: any) {
        lastError = error;
        if (error?.code !== 'EEXIST' || attempt === 199) throw error;
        Atomics.wait(waitCell, 0, 0, 5);
      }
    }
    throw lastError || new Error('failed to acquire authority watermark transaction');
  }

  private hasPersistentIntegrityEvidence(): boolean {
    if (!this.watermarkPath || !this.pendingPath || !this.establishedPath || !this.failedPath) {
      return false;
    }
    if (fs.existsSync(this.pendingPath) || fs.existsSync(this.failedPath)) return true;
    const watermarkExists = fs.existsSync(this.watermarkPath);
    const establishedExists = fs.existsSync(this.establishedPath);
    if (watermarkExists !== establishedExists) return true;
    if (!establishedExists) return false;
    try {
      if (fs.readFileSync(this.establishedPath, 'utf8').trim() !== this.scopeHash) return true;
      const diskWatermark = this.readWatermarkFile();
      if (!diskWatermark || !this.watermark) return diskWatermark !== this.watermark;
      return diskWatermark.revision !== this.watermark.revision
        || diskWatermark.authorityDigest !== this.watermark.authorityDigest
        || diskWatermark.revoked !== this.watermark.revoked;
    } catch {
      return true;
    }
  }

  private writeEstablishedMarker(value: string): void {
    if (!this.establishedPath) return;
    const fd = fs.openSync(this.establishedPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${value}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(this.establishedPath, 0o600); } catch { /* best effort */ }
    fsyncDirectory(path.dirname(this.establishedPath));
  }
}

export function materializeCurrentDeviceAuthority<T extends Partial<ToolExecutionContext>>(context: T): T {
  const current = context.deviceAuthority?.getCurrent();
  if (!current) return context;
  return {
    ...context,
    deviceGrants: current.deviceGrants,
    deviceGrantSnapshot: current.deviceGrantSnapshot,
    deviceSelection: current.deviceSelection,
    targetRoutes: current.targetRoutes,
  };
}

export function deviceAuthorityScopeKey(scope: ExecutionScope): string {
  return hashText(scopeCanonicalValue(scope));
}

function defaultWatermarkDirectory(): string | undefined {
  try {
    return path.join(PathResolver.getRuntimeDataRoot(), 'state', 'device-authority-watermarks');
  } catch (error: any) {
    Logger.warning(`[DeviceAuthority] durable watermark disabled: ${error?.message || error}`);
    return undefined;
  }
}

function scopeCanonicalValue(scope: ExecutionScope): string {
  return JSON.stringify([
    scope.source,
    scope.sessionKey,
    scope.topicId,
    scope.topicType,
    scope.actorUserId,
    scope.agentId || '',
    scope.agentBodyId || '',
  ]);
}

function sameExecutionScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return scopeCanonicalValue(left) === scopeCanonicalValue(right)
    && left.identityTrust === 'server_canonical'
    && right.identityTrust === 'server_canonical'
    && left.isTrusted
    && right.isTrusted;
}

function snapshotMatchesScope(snapshot: ScopedDeviceGrantSnapshot, scope: ExecutionScope): boolean {
  return snapshot.identityTrust === 'server_canonical'
    && scope.identityTrust === 'server_canonical'
    && scope.isTrusted
    && snapshot.source === scope.source
    && snapshot.sessionKey === scope.sessionKey
    && snapshot.topicId === scope.topicId
    && snapshot.topicType === scope.topicType
    && snapshot.actorUserId === scope.actorUserId
    && snapshot.agentId === scope.agentId
    && snapshot.agentBodyId === scope.agentBodyId;
}

export function deviceAuthorityReplacementCanonicalValue(
  snapshot: ScopedDeviceGrantSnapshot,
  selection: ScopedDeviceSelection | undefined,
  targetRoutes: TargetRoutes | undefined,
): string {
  return deviceAuthorityFragmentCanonicalValue(snapshot, selection, targetRoutes);
}

export function deviceAuthorityFragmentCanonicalValue(
  snapshot: ScopedDeviceGrantSnapshot | undefined,
  selection: ScopedDeviceSelection | undefined,
  targetRoutes: TargetRoutes | undefined,
): string {
  return JSON.stringify([
    snapshot ? deviceGrantSnapshotCanonicalValue(snapshot) : null,
    selectionCanonicalValue(selection),
    targetRoutesCanonicalValue(targetRoutes),
  ]);
}

function selectionCanonicalValue(selection: ScopedDeviceSelection | undefined): unknown {
  if (!selection) return null;
  return [
    selection.source,
    selection.status,
    selection.sessionKey,
    selection.topicId,
    selection.topicType,
    selection.actorUserId,
    selection.agentId || '',
    selection.identityTrust,
    selection.selectedDeviceId || '',
    selection.selectedDeviceDisplayName || '',
    selection.selectedDeviceBodyId || '',
    selection.selectedDeviceInstallationId || '',
    selection.selectedDeviceOperations === undefined
      ? null
      : [...selection.selectedDeviceOperations].sort(),
  ];
}

function selectionDeltaCanonicalValue(
  selection: ScopedDeviceSelection | undefined,
  targetRoutes: TargetRoutes | undefined,
): string {
  return JSON.stringify([
    selectionCanonicalValue(selection),
    targetRoutesCanonicalValue(targetRoutes),
  ]);
}

function selectionMatchesScope(selection: ScopedDeviceSelection, scope: ExecutionScope): boolean {
  return selection.identityTrust === 'server_canonical'
    && selection.source === scope.source
    && selection.sessionKey === scope.sessionKey
    && selection.topicId === scope.topicId
    && selection.topicType === scope.topicType
    && selection.actorUserId === scope.actorUserId
    && selection.agentId === scope.agentId;
}

function narrowSelectionToCurrentGrants(
  selection: ScopedDeviceSelection,
  grants: NonNullable<DeviceAuthorityView['deviceGrants']>,
  scope: ExecutionScope,
): ScopedDeviceSelection {
  if (selection.status !== 'selected' || !selection.selectedDeviceId) {
    return cloneSelection(selection)!;
  }
  const selectedGrants = grants.filter(grant => (
    grant.ownerUserId === scope.actorUserId
    && grant.deviceId === selection.selectedDeviceId
    && grant.status === 'active'
    && grant.identityTrust === 'server_canonical'
    && grant.expiresAt > Date.now()
  ));
  if (selectedGrants.length === 0) return unavailableSelection(scope);
  const allowedOperations = new Set(selectedGrants.flatMap(grant => grant.operations));
  const selectedDeviceOperations = selection.selectedDeviceOperations === undefined
    ? undefined
    : selection.selectedDeviceOperations.filter(operation => allowedOperations.has(operation));
  return cloneSelection({
    ...selection,
    selectedDeviceOperations,
  })!;
}

function unavailableSelection(scope: ExecutionScope): ScopedDeviceSelection {
  return {
    kind: 'user_device_selection',
    source: scope.source,
    status: 'unavailable',
    selectionSource: 'device_authority_fail_closed',
    sessionKey: scope.sessionKey,
    topicId: scope.topicId,
    topicType: scope.topicType,
    actorUserId: scope.actorUserId,
    agentId: scope.agentId,
    identityTrust: 'server_canonical',
    identitySource: 'device_authority_state',
    selectedDeviceOperations: [],
  };
}

function targetRoutesCanonicalValue(targetRoutes: TargetRoutes | undefined): unknown {
  return (targetRoutes?.routes || [])
    .map(route => [
      route.userId,
      route.userName || '',
      route.ownerUserId,
      route.deviceId,
      route.label,
      route.os,
      route.status,
      route.targetAlias || '',
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function cloneView(view: DeviceAuthorityView): DeviceAuthorityView {
  return {
    generation: view.generation,
    deviceGrants: view.deviceGrants?.map(cloneGrant),
    deviceGrantSnapshot: view.deviceGrantSnapshot ? cloneSnapshot(view.deviceGrantSnapshot) : undefined,
    deviceSelection: cloneSelection(view.deviceSelection),
    targetRoutes: cloneTargetRoutes(view.targetRoutes),
  };
}

function cloneGrant(grant: ScopedDeviceGrantSnapshot['grants'][number]): ScopedDeviceGrantSnapshot['grants'][number] {
  return { ...grant, operations: [...grant.operations] };
}

function cloneSnapshot(snapshot: ScopedDeviceGrantSnapshot): ScopedDeviceGrantSnapshot {
  return { ...snapshot, grants: snapshot.grants.map(cloneGrant) };
}

function cloneSelection(selection: ScopedDeviceSelection | undefined): ScopedDeviceSelection | undefined {
  if (!selection) return undefined;
  return {
    ...selection,
    selectedDeviceOperations: selection.selectedDeviceOperations
      ? [...selection.selectedDeviceOperations]
      : undefined,
    candidates: selection.candidates?.map(candidate => ({
      ...candidate,
      operations: candidate.operations ? [...candidate.operations] : undefined,
    })),
  };
}

function cloneTargetRoutes(targetRoutes: TargetRoutes | undefined): TargetRoutes | undefined {
  if (!targetRoutes) return undefined;
  const routes = targetRoutes.routes.map(route => ({ ...route }));
  const routeByKey = new Map(routes.map(route => [routeKey(route.ownerUserId, route.deviceId), route]));
  const cloneIndex = (source: Map<string, import('../types/tool').TargetRoute[]>) => new Map(
    [...source.entries()].map(([key, values]) => [
      key,
      values.map(value => routeByKey.get(routeKey(value.ownerUserId, value.deviceId)) || { ...value }),
    ]),
  );
  return {
    routes,
    byName: cloneIndex(targetRoutes.byName),
    byUserId: cloneIndex(targetRoutes.byUserId),
  };
}

function routeKey(ownerUserId: string, deviceId: string): string {
  return `${ownerUserId}\0${deviceId}`;
}

function normalizeRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function revokedAuthorityDigest(revision: number): string {
  return hashText(`revoked\0${revision}`);
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
