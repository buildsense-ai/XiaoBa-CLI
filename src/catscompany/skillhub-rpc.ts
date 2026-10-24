import matter from 'gray-matter';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  createCatsCoLocalConfigService,
  isActiveDeviceConnectorMode,
} from './local-config';
import type { CatsThinToolRpcMessage } from './client';
import {
  BotSkillWorkspaceChangingError,
  finalizeCurrentBotPublicSkillNow,
  pushCurrentBotSkillWorkspaceToCloudNow,
  scheduleCurrentBotSkillRevocationSync,
  withCurrentBotSkillWorkspaceWrite,
} from '../bot-skills/runtime';
import {
  readBotSkillLocalMarker,
  BotSkillWorkspaceScanLimitError,
  isEphemeralSkillDirectory,
  scanBotSkillWorkspace,
} from '../bot-skills/local-manifest';
import { trashBotSkill } from '../bot-skills/deleted-skill-trash';
import {
  clearPendingBotSkillRevocation,
  recordPendingBotSkillRevocation,
} from '../bot-skills/revocation';
import { readSkillHubLocalMetadata } from '../skillhub/local-skill-metadata';
import {
  shareLocalSkillForCatsCo,
  validateSkillHubShareMetadata,
} from '../skillhub/local-share';
import { PathResolver } from '../utils/path-resolver';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/logger';
import {
  PUBLICATION_SOURCE_PROBE, PublicationSourceError, publicationSourceProbeEnabled,
  describePublicationSource, discoverPublicationSources, findPublicationSource, type PublicationSourceBinding,
} from '../skillhub/publication-source';
import {
  PUBLICATION_CAPTURE, PUBLICATION_REPAIR_SOURCE, PublicationCaptureStore, publicationCaptureEnabled,
  publicationRepairSourceEnabled, type PublicationCaptureReceipt,
} from '../skillhub/publication-capture';
import {
  PUBLICATION_UPLOAD, PublicationCandidateUploader, PublicationUploadError,
  publicationUploadEnabled, publicationUploadConfig, type PublicationUploadGrant,
} from '../skillhub/publication-upload';
import {
  CatsCoBotSwitchGuardError,
  verifyCatsCoBotSwitchBinding,
} from './bot-switch-guard';

export const SKILLHUB_THIN_RPC_TOOLS = {
  workspace: 'skillhub.localWorkspace.get',
  applyDefinition: 'skillhub.localWorkspace.applyDefinition',
  syncWorkspace: 'skillhub.localWorkspace.syncToAgent',
  share: 'skillhub.localSkill.share',
  finalize: 'skillhub.localSkill.finalize',
  delete: 'skillhub.localSkill.delete',
  switchBot: 'skillhub.localBot.switch',
  knowledgeList: 'knowledge.document.list',
  knowledgeRead: 'knowledge.document.read',
} as const;

// Capability marker, not an invokable tool. Web clients require this marker
// before requesting a workspace so Runtimes that predate transport-safe
// pagination cannot accidentally send the legacy 200-item response.
export const SKILLHUB_WORKSPACE_PAGINATION_CAPABILITY = 'skillhub.localWorkspace.pagination.v1' as const;

const DEFAULT_WORKSPACE_PAGE_SIZE = 200;
const MAX_WORKSPACE_PAGE_SIZE = 200;
const MAX_WORKSPACE_OFFSET = 1_000_000;
const MAX_WORKSPACE_SKILLS = 10_000;
const MAX_WORKSPACE_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_WORKSPACE_SNAPSHOT_BYTES = 16 * 1024 * 1024;
// CatsCo currently accepts WebSocket messages up to 64 KiB. Leave room for
// the thin-tool envelope, request metadata, and JSON escaping around this
// result instead of relying on an item count to predict the wire size.
const MAX_WORKSPACE_PAGE_RESPONSE_BYTES = 48 * 1024;
const MAX_WORKSPACE_SNAPSHOTS = 4;
const WORKSPACE_SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_REJECTED_FINGERPRINT_FILES = 10_000;
const MAX_REJECTED_FINGERPRINT_BYTES = 32 * 1024 * 1024;
const REJECTED_FINGERPRINT_LARGE_FILE_BYTES = 2 * 1024 * 1024;
const REJECTED_FINGERPRINT_SAMPLE_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_RELATIVE_PATH_LENGTH = 500;
const MAX_COMPLETED_REQUESTS = 256;
const BOT_UID_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

interface SkillHubWorkspaceValidationFailure {
  localSkillId: string;
  name: string;
  installName: string;
  path: string;
  error: Error;
}

interface SkillHubWorkspaceSnapshot {
  botUid: string;
  activeBotUid?: string;
  skillsRoot: string;
  skillsPath: string;
  revision: string;
  skills: Array<Record<string, unknown>>;
  createdAtMs: number;
}

interface RejectedFingerprintBudget {
  files: number;
  bytes: number;
}

export class SkillHubThinRpcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SkillHubThinRpcError';
  }
}

export interface SkillHubThinRpcHandlerOptions {
  runtimeRoot?: string;
  scheduleBotSwitch?: (botUid: string, expectedCurrentBotUid: string) => void;
  /** 运行中客户端当前生效的 HTTP 基地址（跟随 cc/cn 故障切换）。 */
  getHttpBaseUrl?: () => string | undefined;
  verifyBotSwitchBinding?: typeof verifyCatsCoBotSwitchBinding;
  finalizeCurrentBotSkill?: typeof finalizeCurrentBotPublicSkillNow;
  pushCurrentBotSkillWorkspace?: typeof pushCurrentBotSkillWorkspaceToCloudNow;
  /** Schedules a Cloud-only CAS for owner-revoked references; never uploads workspace files. */
  scheduleCurrentBotSkillRevocationSync?: () => void;
  /** Applies the canonical BotDefinition Skill references to this Runtime's active workspace. */
  applyCurrentBotDefinition?: (botUid: string) => Promise<Record<string, unknown>>;
  /** Prevents replacing the active workspace while a message turn is running. */
  isRuntimeIdle?: () => boolean;
  /** Waits for an in-flight turn to finish before replacing the active workspace. */
  waitForRuntimeIdle?: (timeoutMs: number, checkOperational?: () => void) => Promise<boolean>;
  isShuttingDown?: () => boolean;
  enabled?: boolean;
  allowBotSwitch?: boolean;
  publicationProbeEnabled?: boolean;
  publicationCaptureEnabled?: boolean;
  publicationRepairSourceEnabled?: boolean;
  publicationUploadEnabled?: boolean;
  /** Internal dependency injection only, never a serialized option. */
  publicationUploader?: Pick<PublicationCandidateUploader, 'upload'>;
  now?: () => Date;
}

export class SkillHubThinRpcHandler {
  private readonly runtimeRoot: string;
  private readonly scheduleBotSwitch: (botUid: string, expectedCurrentBotUid: string) => void;
  private readonly getHttpBaseUrl?: () => string | undefined;
  private readonly verifyBotSwitchBinding: typeof verifyCatsCoBotSwitchBinding;
  private readonly finalizeCurrentBotSkill: typeof finalizeCurrentBotPublicSkillNow;
  private readonly pushCurrentBotSkillWorkspace: typeof pushCurrentBotSkillWorkspaceToCloudNow;
  private readonly scheduleCurrentBotSkillRevocationSync: () => void;
  private readonly applyCurrentBotDefinition?: (botUid: string) => Promise<Record<string, unknown>>;
  private readonly isRuntimeIdle: () => boolean;
  private readonly waitForRuntimeIdle?: (timeoutMs: number, checkOperational?: () => void) => Promise<boolean>;
  private readonly hasRuntimeIdleFence: boolean;
  private readonly isShuttingDown: () => boolean;
  private readonly enabled: boolean;
  private readonly allowBotSwitch: boolean;
  private readonly publicationProbeEnabled: boolean;
  private publicationProbes = 0;
  private readonly publicationCaptureStore: PublicationCaptureStore;
  private readonly publicationCaptureEnabled: boolean;
  private readonly publicationRepairSourceEnabled: boolean;
  private publicationCaptures = 0;
  private readonly publicationUploadEnabled: boolean;
  private readonly publicationUploader: Pick<PublicationCandidateUploader, 'upload'>;
  private publicationUploads = 0;
  private readonly now: () => Date;
  private readonly completed = new Map<string, {
    fingerprint: string;
    operation: Promise<Record<string, unknown>>;
  }>();
  private readonly workspaceSnapshots = new Map<string, SkillHubWorkspaceSnapshot>();

  constructor(options: SkillHubThinRpcHandlerOptions = {}) {
    this.runtimeRoot = path.resolve(options.runtimeRoot ?? PathResolver.getRuntimeDataRoot());
    this.isShuttingDown = options.isShuttingDown ?? (() => false);
    this.scheduleBotSwitch = options.scheduleBotSwitch
      ?? ((botUid, expectedCurrentBotUid) => scheduleDashboardBotSwitch(
        botUid,
        expectedCurrentBotUid,
        this.isShuttingDown,
      ));
    this.getHttpBaseUrl = options.getHttpBaseUrl;
    this.verifyBotSwitchBinding = options.verifyBotSwitchBinding ?? verifyCatsCoBotSwitchBinding;
    this.finalizeCurrentBotSkill = options.finalizeCurrentBotSkill
      ?? finalizeCurrentBotPublicSkillNow;
    this.pushCurrentBotSkillWorkspace = options.pushCurrentBotSkillWorkspace
      ?? pushCurrentBotSkillWorkspaceToCloudNow;
    this.scheduleCurrentBotSkillRevocationSync = options.scheduleCurrentBotSkillRevocationSync
      ?? scheduleCurrentBotSkillRevocationSync;
    this.applyCurrentBotDefinition = options.applyCurrentBotDefinition;
    this.isRuntimeIdle = options.isRuntimeIdle ?? (() => true);
    this.waitForRuntimeIdle = options.waitForRuntimeIdle;
    this.hasRuntimeIdleFence = Boolean(options.isRuntimeIdle || options.waitForRuntimeIdle);
    this.enabled = options.enabled !== false;
    this.allowBotSwitch = options.allowBotSwitch !== false;
    this.publicationProbeEnabled = options.publicationProbeEnabled ?? publicationSourceProbeEnabled();
    this.publicationCaptureEnabled = this.publicationProbeEnabled &&
      (options.publicationCaptureEnabled ?? publicationCaptureEnabled());
    this.publicationCaptureStore = new PublicationCaptureStore({
      runtimeRoot: this.runtimeRoot, enabled: this.enabled && this.publicationCaptureEnabled,
    });
    this.publicationRepairSourceEnabled = this.publicationCaptureEnabled &&
      (options.publicationRepairSourceEnabled ?? publicationRepairSourceEnabled());
    this.publicationUploadEnabled = this.publicationCaptureEnabled &&
      (options.publicationUploadEnabled ?? publicationUploadEnabled());
    this.publicationUploader = options.publicationUploader ?? new PublicationCandidateUploader({
      runtimeRoot: this.runtimeRoot, enabled: this.enabled && this.publicationUploadEnabled, ...publicationUploadConfig(),
    }, { timeoutMs: 45_000 });
    this.now = options.now ?? (() => new Date());
  }

  supports(toolName: string): boolean {
    if (toolName === PUBLICATION_SOURCE_PROBE) return this.enabled && this.publicationProbeEnabled;
    if (toolName === PUBLICATION_CAPTURE) return this.enabled && this.publicationCaptureEnabled;
    if (toolName === PUBLICATION_REPAIR_SOURCE) return this.enabled && this.publicationRepairSourceEnabled;
    if (toolName === PUBLICATION_UPLOAD) return this.enabled && this.publicationUploadEnabled;
    return this.enabled
      && Object.values(SKILLHUB_THIN_RPC_TOOLS).includes(toolName as any)
      && (toolName !== SKILLHUB_THIN_RPC_TOOLS.switchBot || this.allowBotSwitch);
  }

  async execute(request: CatsThinToolRpcMessage): Promise<Record<string, unknown>> {
    // Reserved probes always recheck content; never reuse cached receipts.
    if (request.tool_name === PUBLICATION_SOURCE_PROBE) return this.probePublicationSource(request);
    // Retained candidates have their own durable identity. Never cache a receipt
    // by request ID or skip current scope/deadline checks on replay.
    if (request.tool_name === PUBLICATION_CAPTURE) return this.capturePublicationSource(request);
    // A retained receipt is not proof of the current on-disk source. This
    // reserved, read-only operation always rechecks it, including on replay.
    if (request.tool_name === PUBLICATION_REPAIR_SOURCE) return this.capturePublicationSource(request, true);
    // Never retain bearer grants in the generic request-id cache.
    if (request.tool_name === PUBLICATION_UPLOAD) return this.uploadPublicationCandidate(request);
    this.assertOperational(request);
    if (String(request.tool_name || '').startsWith('knowledge.')) return this.executeOnce(request);
    const requestID = String(request.request_id || '').trim();
    if (!requestID) throw new SkillHubThinRpcError('INVALID_REQUEST', 'request_id is required.');
    const fingerprint = requestFingerprint(request);
    const existing = this.completed.get(requestID);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new SkillHubThinRpcError(
          'REQUEST_ID_CONFLICT',
          'request_id was already used for a different SkillHub operation.',
        );
      }
      const payload = recordValue(request.payload);
      const botUid = requiredText(payload.bot_uid, 'bot_uid', 160);
      if (!BOT_UID_PATTERN.test(botUid)) {
        throw new SkillHubThinRpcError('INVALID_BOT_UID', 'bot_uid is invalid.');
      }
      this.assertRequestScope(
        request,
        botUid,
        request.tool_name !== SKILLHUB_THIN_RPC_TOOLS.switchBot,
      );
      return existing.operation;
    }
    const operation = this.executeOnce(request).catch((error) => {
      if (error instanceof BotSkillWorkspaceChangingError) {
        throw new SkillHubThinRpcError(error.code, error.message);
      }
      throw error;
    });
    this.completed.set(requestID, { fingerprint, operation });
    while (this.completed.size > MAX_COMPLETED_REQUESTS) {
      this.completed.delete(this.completed.keys().next().value as string);
    }
    return operation;
  }

  private async executeOnce(request: CatsThinToolRpcMessage): Promise<Record<string, unknown>> {
    this.assertOperational(request);
    if (!this.supports(String(request.tool_name || ''))) {
      throw new SkillHubThinRpcError('TOOL_NOT_FOUND', 'Unsupported SkillHub device operation.');
    }
    const payload = recordValue(request.payload);
    const botUid = requiredText(payload.bot_uid, 'bot_uid', 160);
    if (!BOT_UID_PATTERN.test(botUid)) {
      throw new SkillHubThinRpcError('INVALID_BOT_UID', 'bot_uid is invalid.');
    }
    const scope = this.assertRequestScope(request, botUid, request.tool_name !== SKILLHUB_THIN_RPC_TOOLS.switchBot);

    if (request.tool_name === SKILLHUB_THIN_RPC_TOOLS.switchBot) {
      const expectedCurrentBotUid = await this.preflightBotSwitch(botUid);
      this.assertOperational(request);
      this.assertRequestScope(request, botUid, false);
      const currentBotUid = String(
        createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot }).load().currentBot?.uid || '',
      ).trim();
      if (currentBotUid !== expectedCurrentBotUid) {
        throw new SkillHubThinRpcError(
          'BOT_SWITCH_STALE',
          'The active local Bot changed while the SkillHub switch was being verified.',
        );
      }
      this.scheduleBotSwitch(botUid, expectedCurrentBotUid);
      return {
        schema: 'xiaoba.skillhub.bot_switch.v1',
        bot_uid: botUid,
        switching: true,
      };
    }

    switch (request.tool_name) {
      case SKILLHUB_THIN_RPC_TOOLS.workspace:
        return this.readWorkspace(botUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.applyDefinition:
        return this.applyDefinition(botUid, request);
      case SKILLHUB_THIN_RPC_TOOLS.syncWorkspace:
        return this.syncWorkspaceToAgent(botUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.share:
        return this.shareSkill(botUid, scope.ownerUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.finalize:
        return this.finalizeSkill(botUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.delete:
        return this.deleteSkill(botUid, payload, request);
      case SKILLHUB_THIN_RPC_TOOLS.knowledgeList:
        return this.readKnowledge(request, botUid, payload);
      case SKILLHUB_THIN_RPC_TOOLS.knowledgeRead:
        return this.readKnowledge(request, botUid, payload);
      default:
        throw new SkillHubThinRpcError('TOOL_NOT_FOUND', 'Unsupported SkillHub device operation.');
    }
  }

  private knowledgeRequests = 0;

  private publicationBinding(botUid: string): PublicationSourceBinding {
    const config = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot }).load();
    const binding = {
      botUid: String(config.currentBot?.uid || ''),
      ownerUid: String(config.currentBot?.boundByUserUid || ''),
      bodyId: String(config.device?.bodyId || ''),
      installationId: String(config.device?.installationId || ''),
    };
    if (isActiveDeviceConnectorMode(config) || binding.botUid !== botUid ||
      !/^[1-9][0-9]{0,18}$/.test(binding.botUid) || !/^[1-9][0-9]{0,18}$/.test(binding.ownerUid) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.bodyId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.installationId)) {
      throw new PublicationSourceError('publication.runtime_unsupported');
    }
    return binding;
  }

  private async probePublicationSource(request: CatsThinToolRpcMessage): Promise<Record<string, unknown>> {
    if (!this.enabled || !this.publicationProbeEnabled) throw new SkillHubThinRpcError('publication.runtime_unsupported', 'Publication source probing is disabled.');
    if (this.publicationProbes >= 2) throw new SkillHubThinRpcError('publication.runtime_unavailable', 'Publication source probing is busy.');
    this.publicationProbes++;
    try {
      this.assertOperational(request);
      const payload = request.payload;
      if (request.type !== 'request' || request.result !== undefined || request.error !== undefined ||
        !/^(pubprobe|pubdelivery)_[A-Za-z0-9_-]{16,64}$/.test(request.request_id) ||
        !Number.isSafeInteger(request.expires_at) || Number(request.expires_at) > Date.now() + 31_000 ||
        !payload || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'bot_uid,local_skill_id,workspace_generation' ||
        typeof payload.bot_uid !== 'string' || !/^[1-9][0-9]{0,18}$/.test(payload.bot_uid) ||
        typeof payload.local_skill_id !== 'string' || !/^pubsrc-[a-f0-9]{48}$/.test(payload.local_skill_id) ||
        typeof payload.workspace_generation !== 'string' || !/^[a-f0-9]{64}$/.test(payload.workspace_generation)) {
        throw new SkillHubThinRpcError('INVALID_REQUEST', 'Invalid publication source request.');
      }
      const botUid = payload.bot_uid;
      const sourceId = payload.local_skill_id;
      const generation = payload.workspace_generation;
      this.assertRequestScope(request, botUid, true);
      const binding = this.publicationBinding(botUid);
      const deadline = Math.min(Number(request.expires_at), Date.now() + 3_000);
      const check = () => {
        this.assertOperational(request);
        if (Date.now() >= deadline) throw new PublicationSourceError('publication.runtime_unavailable');
      };
      const checkBinding = () => {
        check();
        this.assertRequestScope(request, botUid, true);
        if (request.target_owner_user_id !== `usr${binding.ownerUid}`) {
          throw new SkillHubThinRpcError('OWNER_MISMATCH', 'Invalid publication owner.');
        }
        if (request.target_device_id !== binding.installationId ||
          (request.device_id !== undefined && request.device_id !== binding.installationId)) {
          throw new SkillHubThinRpcError('DEVICE_MISMATCH', 'Invalid publication device.');
        }
        if (JSON.stringify(this.publicationBinding(botUid)) !== JSON.stringify(binding)) {
          throw new PublicationSourceError('publication.source_changed');
        }
      };
      checkBinding();
      const result = await withCurrentBotSkillWorkspaceWrite(context => {
        checkBinding();
        if (context.deviceConnectorMode) throw new PublicationSourceError('publication.runtime_unsupported');
        this.assertActiveWorkspace(botUid, context.botId, context.activeBotId, false);
        const source = findPublicationSource(context.skillsRoot, sourceId, check);
        const descriptor = describePublicationSource(context.skillsRoot, source, binding, check);
        if (descriptor.workspace_generation !== generation) throw new PublicationSourceError('publication.source_changed');
        checkBinding();
        return { schema_version: 1, ...descriptor };
      }, { runtimeRoot: this.runtimeRoot, lockWaitMs: Math.min(1_000, Math.max(0, deadline - Date.now())) });
      checkBinding();
      return result;
    } catch (error) {
      const requestCodes = new Set(['INVALID_REQUEST', 'OWNER_MISMATCH', 'DEVICE_MISMATCH', 'REQUEST_EXPIRED', 'BOT_NOT_ACTIVE']);
      const code = error instanceof PublicationSourceError ? error.code
        : error instanceof BotSkillWorkspaceChangingError ? 'BOT_NOT_ACTIVE'
        : error instanceof SkillHubThinRpcError && requestCodes.has(error.code) ? error.code
        : 'publication.runtime_unavailable';
      throw new SkillHubThinRpcError(code, 'The publication source could not be verified. No upload was started.');
    } finally { this.publicationProbes--; }
  }

  private async capturePublicationSource(request: CatsThinToolRpcMessage, verifyRepairSource = false): Promise<Record<string, unknown>> {
    if (!this.enabled || !this.publicationCaptureEnabled || (verifyRepairSource && !this.publicationRepairSourceEnabled)) {
      throw new SkillHubThinRpcError('publication.runtime_unsupported', verifyRepairSource
        ? 'Publication repair source verification is disabled.' : 'Publication capture is disabled.');
    }
    if (this.publicationCaptures >= 2) {
      throw new SkillHubThinRpcError('publication.runtime_unavailable', 'Publication capture is busy.');
    }
    this.publicationCaptures++;
    try {
      this.assertOperational(request);
      const payload = request.payload;
      const requestIdPattern = verifyRepairSource ? /^pubrepairsource_[A-Za-z0-9_-]{16,64}$/ : /^pubcapture_[A-Za-z0-9_-]{16,64}$/;
      const payloadKeys = verifyRepairSource ? 'bot_uid,entry_id,expected_capture,local_skill_id,workspace_generation'
        : 'bot_uid,entry_id,local_skill_id,workspace_generation';
      if (request.type !== 'request' || request.result !== undefined || request.error !== undefined ||
        typeof request.request_id !== 'string' || !requestIdPattern.test(request.request_id) ||
        !Number.isSafeInteger(request.expires_at) || Number(request.expires_at) > Date.now() + 31_000 ||
        !payload || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== payloadKeys ||
        typeof payload.entry_id !== 'string' || !/^pubentry_[a-f0-9]{32}$/.test(payload.entry_id) ||
        typeof payload.bot_uid !== 'string' || !/^[1-9][0-9]{0,18}$/.test(payload.bot_uid) ||
        // CatsCo carries opaque selectors; this runtime only owns descriptors
        // produced by publication-source.ts, not legacy localSkillId UUIDs.
        typeof payload.local_skill_id !== 'string' || !/^pubsrc-[a-f0-9]{48}$/.test(payload.local_skill_id) ||
        typeof payload.workspace_generation !== 'string' || !/^[a-f0-9]{64}$/.test(payload.workspace_generation)) {
        throw new SkillHubThinRpcError('INVALID_REQUEST', 'Invalid publication capture request.');
      }
      // Snapshot the expected receipt before a possible workspace-lock wait.
      // The store performs the exact receipt schema/value and binding checks.
      const expected = (verifyRepairSource && payload.expected_capture && typeof payload.expected_capture === 'object'
        ? { ...payload.expected_capture } : payload.expected_capture) as PublicationCaptureReceipt;
      request = { ...request, payload: { ...payload, ...(verifyRepairSource ? { expected_capture: expected } : {}) } };
      const botUid = payload.bot_uid;
      this.assertRequestScope(request, botUid, true);
      const binding = this.publicationBinding(botUid);
      const deadline = Math.min(Number(request.expires_at), Date.now() + 10_000);
      const check = () => {
        this.assertOperational(request);
        if (Date.now() >= deadline) throw new PublicationSourceError('publication.runtime_unavailable');
        this.assertRequestScope(request, botUid, true);
        if (request.target_owner_user_id !== `usr${binding.ownerUid}`) {
          throw new SkillHubThinRpcError('OWNER_MISMATCH', 'Invalid publication owner.');
        }
        if (request.target_device_id !== binding.installationId || request.device_id !== binding.installationId) {
          throw new SkillHubThinRpcError('DEVICE_MISMATCH', 'Invalid publication device.');
        }
        if (JSON.stringify(this.publicationBinding(botUid)) !== JSON.stringify(binding)) {
          throw new PublicationSourceError('publication.capture_conflict');
        }
      };
      check();
      const input = {
        entryId: payload.entry_id, binding,
        source: { local_skill_id: payload.local_skill_id, workspace_generation: payload.workspace_generation },
      };
      const receipt = verifyRepairSource
        ? (await this.publicationCaptureStore.readRepairCandidate(input, expected, check)).receipt
        : await this.publicationCaptureStore.capture(input, check);
      check();
      // Only six scalar receipt fields (plus the explicit verification marker
      // in repair mode) cross the socket. No bytes, paths, tokens or grants.
      return { ...receipt, ...(verifyRepairSource ? { sourceVerified: true } : {}) };
    } catch (error) {
      const requestCodes = new Set(['INVALID_REQUEST', 'OWNER_MISMATCH', 'DEVICE_MISMATCH', 'REQUEST_EXPIRED', 'BOT_NOT_ACTIVE']);
      const code = error instanceof PublicationSourceError ? error.code
        : error instanceof SkillHubThinRpcError && requestCodes.has(error.code) ? error.code
        : 'publication.runtime_unavailable';
      throw new SkillHubThinRpcError(code, verifyRepairSource
        ? 'The publication repair source could not be verified. No files were changed.'
        : 'The publication candidate could not be captured. No upload was started.');
    } finally { this.publicationCaptures--; }
  }

  private async uploadPublicationCandidate(request: CatsThinToolRpcMessage): Promise<Record<string, unknown>> {
    if (!this.enabled || !this.publicationUploadEnabled) {
      throw new SkillHubThinRpcError('publication.runtime_unsupported', 'Publication upload is disabled.');
    }
    if (this.publicationUploads >= 2) {
      throw new SkillHubThinRpcError('publication.upload_busy', 'Publication upload is busy.');
    }
    this.publicationUploads++;
    let guard: NodeJS.Timeout | undefined;
    const abort = new AbortController();
    try {
      this.assertOperational(request);
      const payload = request.payload;
      if (request.type !== 'request' || request.result !== undefined || request.error !== undefined ||
        typeof request.request_id !== 'string' || !/^pubuploadrpc_[A-Za-z0-9_-]{16,64}$/.test(request.request_id) ||
        !Number.isSafeInteger(request.expires_at) || Number(request.expires_at) > Date.now() + 61_000 ||
        !payload || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'bot_uid,entry_id,grant,local_skill_id,workspace_generation' ||
        typeof payload.entry_id !== 'string' || !/^pubentry_[a-f0-9]{32}$/.test(payload.entry_id) ||
        typeof payload.bot_uid !== 'string' || !/^[1-9][0-9]{0,18}$/.test(payload.bot_uid) ||
        typeof payload.local_skill_id !== 'string' || !/^pubsrc-[a-f0-9]{48}$/.test(payload.local_skill_id) ||
        typeof payload.workspace_generation !== 'string' || !/^[a-f0-9]{64}$/.test(payload.workspace_generation) ||
        !payload.grant || typeof payload.grant !== 'object' || Array.isArray(payload.grant)) {
        throw new SkillHubThinRpcError('INVALID_REQUEST', 'Invalid publication upload request.');
      }
      // The uploader performs exact grant-schema and byte-binding validation.
      // Clone nested binding before any asynchronous work; never store/cache it.
      const raw = payload.grant as PublicationUploadGrant;
      const grant = { ...raw, binding: raw.binding && { ...raw.binding } };
      request = { ...request, payload: { ...payload, grant } };
      const botUid = payload.bot_uid;
      const binding = this.publicationBinding(botUid);
      const deadline = Math.min(Number(request.expires_at), Date.now() + 45_000);
      const check = () => {
        this.assertOperational(request);
        if (Date.now() >= deadline) throw new PublicationUploadError('inactive');
        this.assertRequestScope(request, botUid, true);
        if (request.target_owner_user_id !== `usr${binding.ownerUid}`) {
          throw new SkillHubThinRpcError('OWNER_MISMATCH', 'Invalid publication owner.');
        }
        if (request.target_device_id !== binding.installationId || request.device_id !== binding.installationId) {
          throw new SkillHubThinRpcError('DEVICE_MISMATCH', 'Invalid publication device.');
        }
        if (JSON.stringify(this.publicationBinding(botUid)) !== JSON.stringify(binding)) {
          throw new PublicationUploadError('inactive');
        }
      };
      check();
      // Shutdown/owner/body switches abort stalled network I/O, not just the
      // eventual response. At most two bounded operations own these timers.
      guard = setInterval(() => { try { check(); } catch { abort.abort(); } }, 250);
      guard.unref();
      const result = await this.publicationUploader.upload({
        entryId: payload.entry_id, binding,
        source: { local_skill_id: payload.local_skill_id, workspace_generation: payload.workspace_generation },
      }, grant, check, abort.signal);
      check();
      if (!result.accepted || result.association.entryRequestId !== payload.entry_id) {
        throw new PublicationUploadError('protocol');
      }
      // An untrusted runtime ACK is not CatsCo's authenticated Cloud receipt.
      // Do not return the bearer, package data, URLs or Cloud task metadata.
      return { schemaVersion: 1, entryId: payload.entry_id, authorityEpoch: grant.authorityEpoch, accepted: true };
    } catch (error) {
      const requestCodes = new Set(['INVALID_REQUEST', 'OWNER_MISMATCH', 'DEVICE_MISMATCH', 'REQUEST_EXPIRED', 'BOT_NOT_ACTIVE']);
      const code = error instanceof PublicationUploadError ? error.code
        : error instanceof SkillHubThinRpcError && requestCodes.has(error.code) ? error.code
        : 'publication.upload_unavailable';
      throw new SkillHubThinRpcError(code, 'Publication upload could not be confirmed. No publication success is implied.');
    } finally {
      if (guard) clearInterval(guard);
      abort.abort();
      this.publicationUploads--;
    }
  }

  private async applyDefinition(
    botUid: string,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    this.assertOperational(request);
    this.assertRequestScope(request, botUid, true);
    if (!this.applyCurrentBotDefinition) {
      throw new SkillHubThinRpcError(
        'RUNTIME_UNSUPPORTED',
        'This XiaoBa Runtime cannot apply BotDefinition Skills without restarting.',
      );
    }
    if (!this.hasRuntimeIdleFence) {
      throw new SkillHubThinRpcError(
        'RUNTIME_UNSUPPORTED',
        'This XiaoBa Runtime cannot safely apply Skills while turns may be running.',
      );
    }
    const remainingLifetime = Number(request.expires_at) - Date.now();
    const waitTimeoutMs = Math.max(0, Math.min(110_000, remainingLifetime - 1_000));
    const idle = this.waitForRuntimeIdle
      ? await this.waitForRuntimeIdle(waitTimeoutMs, () => this.assertOperational(request))
      : this.isRuntimeIdle();
    if (!idle) {
      throw new SkillHubThinRpcError(
        'RUNTIME_BUSY',
        'The XiaoBa Runtime stayed busy; retry after it becomes idle.',
      );
    }
    // The wait can consume most of the device request lifetime. Re-check
    // shutdown and expiry immediately before mutating the active workspace.
    this.assertOperational(request);
    const result = await this.applyCurrentBotDefinition(botUid);
    this.assertOperational(request);
    const applyStatus = String(result?.apply_status ?? result?.applyStatus ?? '');
    const applied = applyStatus === 'applied'
      || applyStatus === 'already_applied'
      || applyStatus === 'degraded';
    return {
      schema: 'xiaoba.skillhub.local_workspace.apply_definition.v1',
      bot_uid: botUid,
      ...result,
      applied,
    };
  }

  private async readKnowledge(request: CatsThinToolRpcMessage, botUid: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.knowledgeRequests >= 2) throw new SkillHubThinRpcError('WIKI_BUSY', '知识库正在读取，请稍后重试。');
    this.knowledgeRequests++;
    try {
      const { stdout } = await promisify(execFile)(
        process.env.XIAOBA_NODE_EXECUTABLE?.trim() || process.execPath,
        [path.resolve(__dirname, '../../skills/xiaoba-knowledge/scripts/wiki.cjs'),
          path.join(this.runtimeRoot, 'knowledge'), String(request.tool_name), JSON.stringify(payload)],
        { timeout: 10000, maxBuffer: 48 * 1024, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      );
      this.assertOperational(request);
      this.assertRequestScope(request, botUid, true);
      const result = JSON.parse(stdout);
      if (result.ok !== true) throw new SkillHubThinRpcError(result.code || 'KNOWLEDGE_UNAVAILABLE', '知识库暂时无法读取，请刷新或通过 Agent 检查索引。');
      return { ...result, bot_uid: botUid };
    } catch (error) {
      if (error instanceof SkillHubThinRpcError) throw error;
      throw new SkillHubThinRpcError('KNOWLEDGE_UNAVAILABLE', '知识库读取超时或不可用，请稍后重试。');
    } finally { this.knowledgeRequests--; }
  }

  private async preflightBotSwitch(botUid: string): Promise<string> {
    const config = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot }).load();
    const expectedCurrentBotUid = String(config.currentBot?.uid || '').trim();
    // Prefer the endpoint the running client actually selected; the persisted
    // local config can lag behind a cc/cn failover.
    const runningHttpBaseUrl = this.getHttpBaseUrl?.();
    try {
      await this.verifyBotSwitchBinding({
        httpBaseUrl: runningHttpBaseUrl || config.endpoints?.httpBaseUrl,
        token: config.account?.token,
        botUid,
        localBodyId: config.device?.bodyId,
      });
    } catch (error) {
      if (error instanceof CatsCoBotSwitchGuardError) {
        throw new SkillHubThinRpcError(error.code, error.message);
      }
      throw new SkillHubThinRpcError(
        'BOT_BINDING_UNVERIFIED',
        'CatsCo could not verify the target Bot Runtime binding.',
      );
    }
    return expectedCurrentBotUid;
  }

  private async readWorkspace(
    botUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const pageOffset = optionalInteger(payload.offset, 'offset', 0, 0, MAX_WORKSPACE_OFFSET);
    const pageLimit = optionalInteger(
      payload.limit,
      'limit',
      DEFAULT_WORKSPACE_PAGE_SIZE,
      1,
      MAX_WORKSPACE_PAGE_SIZE,
    );
    const expectedRevision = optionalContentHash(payload.workspace_revision, 'workspace_revision');
    return withCurrentBotSkillWorkspaceWrite((context) => {
      this.assertOperational(request);
      this.assertRequestScope(request, botUid, true);
      this.assertActiveWorkspace(botUid, context.botId, context.activeBotId, context.deviceConnectorMode);
      const nowMs = this.now().getTime();
      this.pruneWorkspaceSnapshots(nowMs);
      const snapshot = expectedRevision
        ? this.readCachedWorkspaceSnapshot(expectedRevision, botUid, context.skillsRoot)
        : this.createWorkspaceSnapshot(botUid, context.activeBotId, context.skillsRoot, nowMs);
      if (pageOffset > snapshot.skills.length) {
        throw new SkillHubThinRpcError('INVALID_REQUEST', 'offset is outside the workspace snapshot.');
      }
      const pageSkills: Array<Record<string, unknown>> = [];
      const pageEnd = Math.min(snapshot.skills.length, pageOffset + pageLimit);
      for (let index = pageOffset; index < pageEnd; index += 1) {
        // Preserve legacy page boundaries. Optional observations use only the
        // remaining wire budget after all legacy entries have been selected.
        const candidate = [...pageSkills, legacyWorkspaceSkill(snapshot.skills[index])];
        const candidateResponse = buildWorkspacePageResponse(snapshot, pageOffset, pageLimit, candidate);
        if (Buffer.byteLength(JSON.stringify(candidateResponse), 'utf8') > MAX_WORKSPACE_PAGE_RESPONSE_BYTES) {
          if (pageSkills.length === 0) {
            throw new SkillHubThinRpcError(
              'WORKSPACE_ENTRY_TOO_LARGE',
              'A local Skill has too much listing metadata to send safely.',
            );
          }
          break;
        }
        pageSkills.push(legacyWorkspaceSkill(snapshot.skills[index]));
      }
      for (let index = 0; index < pageSkills.length; index++) {
        const legacy = pageSkills[index];
        if (legacy === snapshot.skills[pageOffset + index]) continue;
        pageSkills[index] = snapshot.skills[pageOffset + index];
        if (Buffer.byteLength(JSON.stringify(buildWorkspacePageResponse(snapshot, pageOffset, pageLimit, pageSkills)), 'utf8') > MAX_WORKSPACE_PAGE_RESPONSE_BYTES) {
          pageSkills[index] = legacy;
        }
      }
      return buildWorkspacePageResponse(snapshot, pageOffset, pageLimit, pageSkills);
    }, { runtimeRoot: this.runtimeRoot });
  }

  private createWorkspaceSnapshot(
    botUid: string,
    activeBotUid: string | undefined,
    skillsRoot: string,
    nowMs: number,
  ): SkillHubWorkspaceSnapshot {
    const rejected: SkillHubWorkspaceValidationFailure[] = [];
    const entries = scanSkillHubWorkspace(skillsRoot, {
      onValidationFailure: failure => rejected.push(failure),
      maxSkillEntries: MAX_WORKSPACE_SKILLS,
      maxTotalPackageBytes: MAX_WORKSPACE_PACKAGE_BYTES,
      retainPackageContents: false,
      writeMarkers: false,
    }).filter((entry) => {
      const error = validateSkillHubShareMetadata(entry.path);
      if (!error) return true;
      rejected.push({
        localSkillId: entry.localSkillId,
        name: entry.name,
        installName: entry.installName,
        path: entry.path,
        error,
      });
      return false;
    });
    const listed = [
      ...entries.map(entry => ({ kind: 'valid' as const, entry })),
      ...rejected.map(entry => ({ kind: 'rejected' as const, entry })),
    ].sort((left, right) => compareText(left.entry.localSkillId, right.entry.localSkillId));
    if (listed.length > MAX_WORKSPACE_SKILLS) throw workspaceTooLargeError();
    const rejectedFingerprintBudget: RejectedFingerprintBudget = { files: 0, bytes: 0 };
    const skills = listed.map((item) => {
      if (item.kind === 'valid') {
        const { entry } = item;
        const presentation = readLocalSkillPresentation(entry.path);
        return {
          local_skill_id: limitText(entry.localSkillId, MAX_NAME_LENGTH),
          name: limitText(entry.name, MAX_NAME_LENGTH),
          description: limitText(presentation.description, MAX_DESCRIPTION_LENGTH),
          relative_path: limitText(entry.installName, MAX_RELATIVE_PATH_LENGTH),
          source: 'user',
          can_share: !entry.reference || isPrivateSkillReference(entry.reference.skillId),
          skill_hub: {
            ...(presentation.metadata || {}),
            ...(entry.reference ? { reference: entry.reference } : {}),
          },
        };
      }
      const { entry } = item;
      const presentation = readLocalSkillPresentation(entry.path);
      return {
        local_skill_id: limitText(entry.localSkillId, MAX_NAME_LENGTH),
        name: limitText(entry.name, MAX_NAME_LENGTH),
        description: limitText(presentation.description, MAX_DESCRIPTION_LENGTH),
        relative_path: limitText(entry.installName, MAX_RELATIVE_PATH_LENGTH),
        source: 'user',
        can_share: false,
        share_error: limitText(entry.error.message, MAX_DESCRIPTION_LENGTH),
        skill_hub: presentation.metadata || {},
      };
    });
    // Validate the original snapshot before adding optional observations.
    let snapshotBytes = Buffer.byteLength(stableSerialize(skills), 'utf8');
    if (snapshotBytes > MAX_WORKSPACE_SNAPSHOT_BYTES) throw workspaceTooLargeError();
    if (this.publicationProbeEnabled) {
      // New selectors are separate from legacy IDs, revisions and can_share.
      const deadline = Date.now() + 1_000;
      const check = () => {
        if (Date.now() >= deadline || this.isShuttingDown()) throw new PublicationSourceError('publication.runtime_unavailable');
      };
      let binding: PublicationSourceBinding | undefined;
      let sources: Set<string> | undefined;
      let discoveryError: unknown;
      try {
        binding = this.publicationBinding(botUid);
        // Exactly the same global discovery budget as the probe, once per
        // listing. Never offer selectors that this workspace cannot resolve.
        sources = new Set(discoverPublicationSources(skillsRoot, check).values());
      } catch (error) { discoveryError = error; }
      for (let index = 0; index < listed.length; index++) {
        const target = skills[index] as Record<string, unknown>;
        const legacyBytes = Buffer.byteLength(stableSerialize(target), 'utf8');
        try {
          if (discoveryError) throw discoveryError;
          if (!sources?.has(path.resolve(listed[index].entry.path))) throw new PublicationSourceError('publication.source_missing');
          target.publication_source = describePublicationSource(skillsRoot, listed[index].entry.path,
            binding!, check);
        } catch (error) {
          target.publication_source_error = error instanceof PublicationSourceError ? error.code : 'publication.runtime_unavailable';
        }
        const extraBytes = Buffer.byteLength(stableSerialize(target), 'utf8') - legacyBytes;
        if (snapshotBytes + extraBytes > MAX_WORKSPACE_SNAPSHOT_BYTES) {
          delete target.publication_source;
          delete target.publication_source_error;
        } else { snapshotBytes += extraBytes; }
      }
    }
    const revision = createHash('sha256')
      .update(stableSerialize(listed.map((item, index) => ({
        // Optional publication observations must not change the legacy
        // pagination/sync revision, including when their scan budget expires.
        skill: legacyWorkspaceSkill(skills[index]),
        package_content_hash: item.kind === 'valid'
          ? item.entry.contentHash
          : fingerprintRejectedSkillPackage(item.entry.path, rejectedFingerprintBudget),
      }))))
      .digest('hex');
    const snapshot: SkillHubWorkspaceSnapshot = {
      botUid,
      activeBotUid,
      skillsRoot: path.resolve(skillsRoot),
      skillsPath: fs.realpathSync(skillsRoot),
      revision,
      skills,
      createdAtMs: nowMs,
    };
    this.workspaceSnapshots.delete(revision);
    this.workspaceSnapshots.set(revision, snapshot);
    this.pruneWorkspaceSnapshots(nowMs);
    return snapshot;
  }

  private readCachedWorkspaceSnapshot(
    revision: string,
    botUid: string,
    skillsRoot: string,
  ): SkillHubWorkspaceSnapshot {
    const snapshot = this.workspaceSnapshots.get(revision);
    if (
      !snapshot
      || snapshot.botUid !== botUid
      || snapshot.skillsRoot !== path.resolve(skillsRoot)
    ) {
      throw new SkillHubThinRpcError(
        'WORKSPACE_CHANGED',
        'The local Skill workspace snapshot is no longer available. Restart the listing.',
      );
    }
    return snapshot;
  }

  private pruneWorkspaceSnapshots(nowMs: number): void {
    for (const [revision, snapshot] of this.workspaceSnapshots) {
      if (nowMs - snapshot.createdAtMs > WORKSPACE_SNAPSHOT_TTL_MS) {
        this.workspaceSnapshots.delete(revision);
      }
    }
    while (this.workspaceSnapshots.size > MAX_WORKSPACE_SNAPSHOTS) {
      this.workspaceSnapshots.delete(this.workspaceSnapshots.keys().next().value as string);
    }
  }

  private async shareSkill(
    botUid: string,
    ownerUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const localSkillId = requiredText(payload.local_skill_id, 'local_skill_id', MAX_NAME_LENGTH);
    const skillName = requiredText(payload.skill_name, 'skill_name', MAX_NAME_LENGTH);
    await withCurrentBotSkillWorkspaceWrite((context) => {
      this.assertActiveWorkspace(botUid, context.botId, context.activeBotId, context.deviceConnectorMode);
      const rejected: SkillHubWorkspaceValidationFailure[] = [];
      const entry = scanSkillHubWorkspace(context.skillsRoot, {
        onValidationFailure: failure => rejected.push(failure),
      }).find((candidate) => (
        candidate.localSkillId === localSkillId && candidate.name === skillName
      ));
      if (!entry) {
        const invalid = rejected.find(candidate => (
          candidate.localSkillId === localSkillId && candidate.name === skillName
        ));
        if (invalid) {
          throw new SkillHubThinRpcError('LOCAL_SKILL_INVALID', invalid.error.message);
        }
        throw new SkillHubThinRpcError('LOCAL_SKILL_NOT_FOUND', 'The selected local Skill no longer exists.');
      }
      const validationError = validateSkillHubShareMetadata(entry.path);
      if (validationError) {
        throw new SkillHubThinRpcError('LOCAL_SKILL_INVALID', validationError.message);
      }
    }, { runtimeRoot: this.runtimeRoot });

    const configService = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot });
    const result = await shareLocalSkillForCatsCo({
      skillName,
      expectedLocalSkillId: localSkillId,
      expectedBotUid: botUid,
      expectedUserUid: ownerUid,
      confirmVersionPublish: payload.confirm_publish === true,
    }, {
      writeLocalMetadata: false,
      runtimeRoot: this.runtimeRoot,
      getCatsCoAuth: () => {
        const auth = configService.getAuthState();
        return {
          token: String(auth.token || ''),
          baseUrl: auth.httpBaseUrl,
          user: {
            uid: auth.uid,
            username: auth.username,
            displayName: auth.displayName,
          },
        };
      },
      validateScope: (context) => {
        this.assertOperational(request);
        this.assertRequestScope(request, botUid, true);
        this.assertActiveWorkspace(botUid, context.botId, context.activeBotId, context.deviceConnectorMode);
      },
    });
    return {
      schema: 'xiaoba.skillhub.local_share.v1',
      bot_uid: botUid,
      skill: {
        id: String(result?.skill?.id || ''),
        name: skillName,
      },
      latest_version: String(result?.latestVersion || ''),
      content_hash: String(result?.contentHash || '').toLowerCase(),
      skill_hub: result?.skillHub ? {
        author: String(result.skillHub.author || ''),
        version: String(result.skillHub.version || ''),
        uploaded_at: String(result.skillHub.uploadedAt || ''),
      } : {},
      requires_confirmation: Boolean(result?.requiresConfirmation),
    };
  }

  private async syncWorkspaceToAgent(
    botUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const expectedRevision = requiredContentHash(payload.workspace_revision, 'workspace_revision');
    let workspaceSkillCount = 0;
    let result;
    try {
      result = await this.pushCurrentBotSkillWorkspace(botUid, {
        runtimeRoot: this.runtimeRoot,
        validateScope: () => {
          this.assertOperational(request);
          this.assertRequestScope(request, botUid, true);
        },
        validateWorkspace: (context) => {
          this.assertActiveWorkspace(botUid, context.botId, context.activeBotId, context.deviceConnectorMode);
          const snapshot = this.createWorkspaceSnapshot(
            botUid,
            context.activeBotId,
            context.skillsRoot,
            this.now().getTime(),
          );
          if (snapshot.revision !== expectedRevision) {
            throw new SkillHubThinRpcError(
              'WORKSPACE_CHANGED',
              'The local Skill workspace changed after it was reviewed. Refresh and confirm again.',
            );
          }
          const invalid = snapshot.skills.find(skill => Boolean(skill.share_error));
          if (invalid) {
            throw new SkillHubThinRpcError(
              'LOCAL_SKILL_INVALID',
              'The local Skill workspace contains an invalid Skill. Fix it before syncing.',
            );
          }
          workspaceSkillCount = snapshot.skills.length;
          if (workspaceSkillCount === 0) {
            throw new SkillHubThinRpcError(
              'EMPTY_WORKSPACE',
              'The local Skill workspace is empty and cannot replace the current Agent abilities.',
            );
          }
        },
      });
    } catch (error: any) {
      if (error instanceof SkillHubThinRpcError) throw error;
      throw new SkillHubThinRpcError(
        String(error?.code || 'SKILLHUB_WORKSPACE_SYNC_FAILED'),
        error?.message || 'The Runtime workspace could not be synced to the current Agent.',
      );
    }
    const privateSkills = result.skills.filter(reference => isPrivateSkillReference(reference.skillId)).length;
    return {
      schema: 'xiaoba.skillhub.workspace_sync.v1',
      bot_uid: botUid,
      workspace_revision: expectedRevision,
      workspace_skills: workspaceSkillCount,
      synced_skills: result.skills.length,
      private_skills: privateSkills,
      public_skills: result.skills.length - privateSkills,
      cloud_revision: result.cloudRevision,
      direction: result.direction,
      apply_status: result.applyStatus,
    };
  }

  private async finalizeSkill(
    botUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const localSkillId = requiredText(payload.local_skill_id, 'local_skill_id', MAX_NAME_LENGTH);
    const skillName = requiredText(payload.skill_name, 'skill_name', MAX_NAME_LENGTH);
    const skillId = requiredText(payload.skill_id, 'skill_id', MAX_RELATIVE_PATH_LENGTH);
    const version = requiredText(payload.version, 'version', MAX_NAME_LENGTH);
    const contentHash = requiredText(payload.content_hash, 'content_hash', 64).toLowerCase();
    if (!CONTENT_HASH_PATTERN.test(contentHash)) {
      throw new SkillHubThinRpcError('INVALID_CONTENT_HASH', 'content_hash is invalid.');
    }
    let result;
    try {
      result = await this.finalizeCurrentBotSkill(botUid, {
        localSkillId,
        skillName,
        reference: {
          source: 'skillhub',
          skillId,
          version,
          contentHash,
        },
      }, {
        runtimeRoot: this.runtimeRoot,
        publicationWaitMs: Math.max(
          0,
          Math.min(45_000, Number(request.expires_at || 0) - Date.now() - 1_000),
        ),
        validateScope: () => {
          this.assertOperational(request);
          this.assertRequestScope(request, botUid, true);
        },
      });
    } catch (error: any) {
      if (error instanceof SkillHubThinRpcError) throw error;
      throw new SkillHubThinRpcError(
        String(error?.code || 'SKILLHUB_FINALIZE_FAILED'),
        error?.message || 'The public Skill could not be finalized.',
      );
    }
    if (result.botId !== botUid) {
      throw new SkillHubThinRpcError(
        'BOT_NOT_ACTIVE',
        'The selected Bot workspace changed before finalization completed.',
      );
    }
    const matched = result?.skills?.some((reference) => (
      reference.skillId === skillId
      && reference.version === version
      && reference.contentHash === contentHash
    ));
    if (!matched) {
      throw new SkillHubThinRpcError(
        'BOT_DEFINITION_NOT_READY',
        'The public Skill reference is not present in the current BotDefinition yet.',
      );
    }
    return {
      schema: 'xiaoba.skillhub.local_finalize.v1',
      bot_uid: botUid,
      skill_id: skillId,
      version,
      content_hash: contentHash,
      direction: result?.direction || 'none',
    };
  }

  private async deleteSkill(
    botUid: string,
    payload: Record<string, unknown>,
    request: CatsThinToolRpcMessage,
  ): Promise<Record<string, unknown>> {
    const localSkillId = requiredText(payload.local_skill_id, 'local_skill_id', MAX_NAME_LENGTH);
    const removed = await withCurrentBotSkillWorkspaceWrite((context) => {
      this.assertOperational(request);
      const scope = this.assertRequestScope(request, botUid, true);
      this.assertActiveWorkspace(botUid, context.botId, context.activeBotId, context.deviceConnectorMode);

      const rejected: SkillHubWorkspaceValidationFailure[] = [];
      const entries = scanSkillHubWorkspace(context.skillsRoot, {
        onValidationFailure: failure => rejected.push(failure),
      });
      const candidates = [
        ...entries.map(entry => ({
          localSkillId: entry.localSkillId,
          name: entry.name,
          installName: entry.installName,
          path: entry.path,
        })),
        ...rejected.map(entry => ({
          localSkillId: entry.localSkillId,
          name: entry.name,
          installName: entry.installName,
          path: entry.path,
        })),
      ];
      const entry = candidates.find(candidate => candidate.localSkillId === localSkillId);
      if (!entry) {
        throw new SkillHubThinRpcError(
          'LOCAL_SKILL_NOT_FOUND',
          'The selected local Skill no longer exists.',
        );
      }

      const root = fs.realpathSync(context.skillsRoot);
      const entryStat = fs.lstatSync(entry.path);
      if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
        throw new SkillHubThinRpcError(
          'LOCAL_SKILL_UNSAFE',
          'The selected local Skill is not a safe directory.',
        );
      }
      const realEntry = fs.realpathSync(entry.path);
      const relative = path.relative(root, realEntry);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new SkillHubThinRpcError(
          'LOCAL_SKILL_UNSAFE',
          'The selected local Skill is outside the active Skill workspace.',
        );
      }
      const nested = candidates.find(candidate => (
        candidate.localSkillId !== localSkillId
        && path.resolve(candidate.path).startsWith(`${path.resolve(entry.path)}${path.sep}`)
      ));
      if (nested) {
        throw new SkillHubThinRpcError(
          'LOCAL_SKILL_CONTAINS_SKILLS',
          'The selected local Skill contains another Skill directory and cannot be deleted safely.',
        );
      }

      const reference = readBotSkillLocalMarker(realEntry)?.reference;
      if (reference) {
        try {
          recordPendingBotSkillRevocation(botUid, reference, this.runtimeRoot);
        } catch (error: any) {
          // The deny-list accelerates convergence, but must never turn an
          // owner-confirmed local delete into a failed delete. Trash remains
          // the recoverable evidence if durable revocation recording fails.
          Logger.warning(`Skill revoke state could not be recorded; continuing deletion: ${error?.message || error}`);
        }
      }
      let backup: ReturnType<typeof trashBotSkill>;
      try {
        backup = trashBotSkill({
          runtimeRoot: this.runtimeRoot,
          botId: botUid,
          sourcePath: realEntry,
          localSkillId,
          name: entry.name,
          installName: entry.installName,
          deletedByOwnerUid: scope.ownerUid,
          now: this.now,
        });
      } catch (error) {
        if (reference) {
          try {
            clearPendingBotSkillRevocation(botUid, reference, this.runtimeRoot);
          } catch (rollbackError: any) {
            Logger.warning(`Skill revoke rollback failed after delete failure: ${rollbackError?.message || rollbackError}`);
          }
        }
        throw error;
      }
      return {
        localSkillId,
        name: entry.name,
        relativePath: entry.installName,
        ...(reference ? { reference } : {}),
        ...backup,
      };
    }, { runtimeRoot: this.runtimeRoot });

    // Do not upload the entire local workspace for an uninstall: only CAS the
    // exact revoked BotDefinition reference. The durable deny-list keeps old
    // turn snapshots blocked until that Cloud write is confirmed.
    this.scheduleCurrentBotSkillRevocationSync();

    return {
      schema: 'xiaoba.skillhub.local_delete.v1',
      bot_uid: botUid,
      local_skill_id: removed.localSkillId,
      name: removed.name,
      relative_path: removed.relativePath,
      deleted: true,
      backup_id: removed.backupId,
      deleted_at: removed.deletedAt,
      backup_expires_at: removed.expiresAt,
    };
  }

  private assertOperational(request: CatsThinToolRpcMessage): void {
    if (this.isShuttingDown()) {
      throw new SkillHubThinRpcError(
        'SHUTTING_DOWN',
        'The XiaoBa device is shutting down. Retry the SkillHub operation after it reconnects.',
      );
    }
    this.assertFreshRequest(request);
  }

  private assertFreshRequest(request: CatsThinToolRpcMessage): void {
    const expiresAt = Number(request.expires_at || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new SkillHubThinRpcError('REQUEST_EXPIRED', 'The SkillHub device request has expired.');
    }
  }

  private assertRequestScope(
    request: CatsThinToolRpcMessage,
    botUid: string,
    requireActiveBot: boolean,
  ): { ownerUid: string; deviceId: string } {
    const config = createCatsCoLocalConfigService({ runtimeRoot: this.runtimeRoot }).load();
    const ownerUid = String(config.currentBot?.boundByUserUid || config.account?.uid || '').trim();
    if (!ownerUid || normalizeUid(request.target_owner_user_id) !== normalizeUid(ownerUid)) {
      throw new SkillHubThinRpcError('OWNER_MISMATCH', 'The local CatsCo account does not match this request.');
    }
    // Device registration uses installationId first and falls back to bodyId
    // (see CatsCompanyAdapter). Keep deviceId last for legacy local configs.
    const deviceId = String(
      config.device?.installationId || config.device?.bodyId || config.device?.deviceId || '',
    ).trim();
    const requestDeviceId = String(request.target_device_id || request.device_id || '').trim();
    if (!deviceId || requestDeviceId !== deviceId) {
      throw new SkillHubThinRpcError('DEVICE_MISMATCH', 'The request targets a different XiaoBa device.');
    }
    const deviceConnectorMode = isActiveDeviceConnectorMode(config);
    if (requireActiveBot && !deviceConnectorMode && String(config.currentBot?.uid || '').trim() !== botUid) {
      throw new SkillHubThinRpcError('BOT_NOT_ACTIVE', 'The selected Bot is not active on this XiaoBa device.');
    }
    return { ownerUid, deviceId };
  }

  private assertActiveWorkspace(
    botUid: string,
    configuredBotUid?: string,
    activeBotUid?: string,
    deviceConnectorMode = false,
  ): void {
    if (!deviceConnectorMode && (configuredBotUid !== botUid || activeBotUid !== botUid)) {
      throw new SkillHubThinRpcError('BOT_NOT_ACTIVE', 'The selected Bot workspace is not active on this device.');
    }
  }
}

function legacyWorkspaceSkill(skill: Record<string, unknown>): Record<string, unknown> {
  if (!('publication_source' in skill) && !('publication_source_error' in skill)) return skill;
  const { publication_source: _source, publication_source_error: _error, ...legacy } = skill;
  return legacy;
}

function buildWorkspacePageResponse(
  snapshot: SkillHubWorkspaceSnapshot,
  pageOffset: number,
  pageLimit: number,
  skills: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const nextOffset = pageOffset + skills.length;
  const hasMore = nextOffset < snapshot.skills.length;
  return {
    schema: 'xiaoba.skillhub.local_workspace.v1',
    bot_uid: snapshot.botUid,
    active_bot_uid: snapshot.activeBotUid,
    skills_path: snapshot.skillsPath,
    workspace_revision: snapshot.revision,
    total_skills: snapshot.skills.length,
    page_offset: pageOffset,
    page_limit: pageLimit,
    next_offset: hasMore ? nextOffset : null,
    truncated: hasMore,
    skills,
  };
}

export function scheduleDashboardBotSwitch(
  botUid: string,
  expectedCurrentBotUidOrShutdown: string | (() => boolean) = '',
  maybeIsShuttingDown: () => boolean = () => false,
): void {
  dashboardBotSwitchScheduler.schedule(
    botUid,
    expectedCurrentBotUidOrShutdown,
    maybeIsShuttingDown,
  );
}

interface PendingDashboardBotSwitch {
  botUid: string;
  expectedCurrentBotUid: string;
  isShuttingDown: () => boolean;
}

export class DashboardBotSwitchScheduler {
  private pending?: PendingDashboardBotSwitch;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private runningBotUid = '';

  constructor(
    private readonly requestSwitch: (botUid: string, expectedCurrentBotUid: string) => Promise<void> = (
      botUid,
      expectedCurrentBotUid,
    ) => requestDashboardBotSwitch(botUid, fetch, expectedCurrentBotUid),
    private readonly delayMs = 1_000,
  ) {}

  schedule(
    botUid: string,
    expectedCurrentBotUidOrShutdown: string | (() => boolean) = '',
    maybeIsShuttingDown: () => boolean = () => false,
  ): void {
    const target = String(botUid || '').trim();
    const expectedCurrentBotUid = typeof expectedCurrentBotUidOrShutdown === 'string'
      ? expectedCurrentBotUidOrShutdown
      : '';
    const isShuttingDown = typeof expectedCurrentBotUidOrShutdown === 'function'
      ? expectedCurrentBotUidOrShutdown
      : maybeIsShuttingDown;
    if (!target || isShuttingDown()) return;
    if (this.running && this.runningBotUid === target) {
      this.pending = undefined;
      return;
    }
    if (this.pending?.botUid === target) {
      // Refresh the connector lifecycle fence without extending the debounce.
      this.pending = { botUid: target, expectedCurrentBotUid, isShuttingDown };
      return;
    }

    this.pending = {
      botUid: target,
      expectedCurrentBotUid,
      isShuttingDown,
    };
    if (!this.running) this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.delayMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const next = this.pending;
    this.pending = undefined;
    if (!next) return;
    if (next.isShuttingDown()) {
      if (this.pending) this.arm();
      return;
    }

    this.running = true;
    this.runningBotUid = next.botUid;
    try {
      await this.requestSwitch(next.botUid, next.expectedCurrentBotUid);
    } catch (error: any) {
      Logger.warning(`SkillHub remote Bot switch failed: ${error?.message || String(error)}`);
    } finally {
      this.running = false;
      this.runningBotUid = '';
      if (this.pending) this.arm();
    }
  }
}

const dashboardBotSwitchScheduler = new DashboardBotSwitchScheduler();

export async function requestDashboardBotSwitch(
  botUid: string,
  fetchImpl: typeof fetch = fetch,
  expectedCurrentBotUid = '',
): Promise<void> {
  const numericPort = Number(process.env.XIAOBA_DASHBOARD_PORT || 3800);
  const port = Number.isSafeInteger(numericPort) && numericPort > 0 && numericPort <= 65535
    ? numericPort
    : 3800;
  const apiKey = String(process.env.DASHBOARD_API_KEY || '').trim();
  const response = await fetchImpl(`http://127.0.0.1:${port}/api/cats/switch-bot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      botUid,
      source: 'skillhub-thin-rpc',
      expectedCurrentBotUid,
    }),
  });
  if (!response.ok) {
    throw new Error(`Dashboard rejected the Bot switch (HTTP ${response.status}).`);
  }
}

function readLocalSkillPresentation(skillDir: string): {
  description: string;
  metadata: ReturnType<typeof readSkillHubLocalMetadata>;
} {
  const skillFile = path.join(skillDir, 'SKILL.md');
  try {
    if (fs.statSync(skillFile).size > REJECTED_FINGERPRINT_LARGE_FILE_BYTES) {
      return { description: '', metadata: null };
    }
    const parsed = matter(fs.readFileSync(skillFile, 'utf8'), {});
    return {
      description: String(parsed.data?.description || ''),
      metadata: readSkillHubLocalMetadata(skillFile),
    };
  } catch {
    return { description: '', metadata: null };
  }
}

function fingerprintRejectedSkillPackage(
  skillDir: string,
  budget: RejectedFingerprintBudget,
): string {
  const root = path.resolve(skillDir);
  const evidence: Array<Record<string, unknown>> = [];
  const visit = (current: string): void => {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      if (
        child.isDirectory()
        && (child.name === '.git' || child.name === 'node_modules' || isEphemeralSkillDirectory(child.name))
      ) continue;
      const fullPath = path.join(current, child.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        evidence.push({ path: relativePath, type: 'symlink' });
        continue;
      }
      if (stat.isDirectory()) {
        evidence.push({ path: relativePath, type: 'directory' });
        if (!fs.existsSync(path.join(fullPath, 'SKILL.md'))) visit(fullPath);
        continue;
      }
      if (!stat.isFile()) continue;
      budget.files += 1;
      if (budget.files > MAX_REJECTED_FINGERPRINT_FILES) throw workspaceTooLargeError();
      const sampled = readBoundedFingerprintBytes(fullPath, stat.size);
      budget.bytes += sampled.length;
      if (budget.bytes > MAX_REJECTED_FINGERPRINT_BYTES) throw workspaceTooLargeError();
      evidence.push({
        path: relativePath,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        sha256: createHash('sha256').update(sampled).digest('hex'),
        sampled: sampled.length !== stat.size,
      });
    }
  };
  visit(root);
  return createHash('sha256').update(stableSerialize(evidence)).digest('hex');
}

function readBoundedFingerprintBytes(filePath: string, size: number): Buffer {
  if (size <= REJECTED_FINGERPRINT_LARGE_FILE_BYTES) {
    return fs.readFileSync(filePath);
  }
  const handle = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(REJECTED_FINGERPRINT_SAMPLE_BYTES, size));
    fs.readSync(handle, head, 0, head.length, 0);
    const remaining = Math.max(0, size - head.length);
    const tail = Buffer.alloc(Math.min(REJECTED_FINGERPRINT_SAMPLE_BYTES, remaining));
    if (tail.length > 0) fs.readSync(handle, tail, 0, tail.length, size - tail.length);
    return Buffer.concat([head, tail]);
  } finally {
    fs.closeSync(handle);
  }
}

function scanSkillHubWorkspace(
  skillsRoot: string,
  options: Parameters<typeof scanBotSkillWorkspace>[1],
): ReturnType<typeof scanBotSkillWorkspace> {
  try {
    return scanBotSkillWorkspace(skillsRoot, options);
  } catch (error) {
    if (error instanceof BotSkillWorkspaceScanLimitError) throw workspaceTooLargeError();
    throw new SkillHubThinRpcError(
      'LOCAL_SKILL_INVALID',
      'The local Skill workspace could not be validated safely.',
    );
  }
}

function workspaceTooLargeError(): SkillHubThinRpcError {
  return new SkillHubThinRpcError(
    'WORKSPACE_TOO_LARGE',
    'The local Skill workspace is too large to list safely.',
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || text.includes('\0')) {
    throw new SkillHubThinRpcError('INVALID_REQUEST', `${field} is invalid.`);
  }
  return text;
}

function optionalInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SkillHubThinRpcError('INVALID_REQUEST', `${field} is invalid.`);
  }
  return parsed;
}

function optionalContentHash(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return '';
  const normalized = String(value).trim().toLowerCase();
  if (!CONTENT_HASH_PATTERN.test(normalized)) {
    throw new SkillHubThinRpcError('INVALID_REQUEST', `${field} is invalid.`);
  }
  return normalized;
}

function requiredContentHash(value: unknown, field: string): string {
  const normalized = optionalContentHash(value, field);
  if (!normalized) {
    throw new SkillHubThinRpcError('INVALID_REQUEST', `${field} is required.`);
  }
  return normalized;
}

function limitText(value: string, maxLength: number): string {
  const text = String(value || '');
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeUid(value: unknown): string {
  return String(value || '').trim().replace(/^usr/i, '');
}

function isPrivateSkillReference(skillId: string): boolean {
  const value = String(skillId || '');
  return value.startsWith('priv_') || value.startsWith('private/');
}

function requestFingerprint(request: CatsThinToolRpcMessage): string {
  return stableSerialize({
    target_owner_user_id: normalizeUid(request.target_owner_user_id),
    target_device_id: String(request.target_device_id || request.device_id || '').trim(),
    tool_name: String(request.tool_name || '').trim(),
    payload: recordValue(request.payload),
    expires_at: Number(request.expires_at || 0),
  });
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
