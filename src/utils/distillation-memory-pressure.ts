import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type MemoryPressureMode = 'normal' | 'degraded' | 'suspended';
export type MemoryPressureLevel = 'normal' | 'soft' | 'hard';
export type MemoryPressureTransition =
  | 'none'
  | 'degraded'
  | 'suspended'
  | 'recovered-to-degraded'
  | 'recovered-to-normal';

export interface MemoryPressureConfig {
  enabled?: boolean;
  softCgroupPercent: number;
  hardCgroupPercent: number;
  softHostAvailableBytes: number;
  hardHostAvailableBytes: number;
  recoveryCgroupPercent: number;
  recoveryHostAvailableBytes: number;
  recoverySamples: number;
  pollIntervalMs: number;
  degradedReviewerConcurrency: number;
  degradedMaxCandidates: number;
}

export const DEFAULT_MEMORY_PRESSURE_CONFIG: MemoryPressureConfig = {
  enabled: true,
  softCgroupPercent: 70,
  hardCgroupPercent: 85,
  softHostAvailableBytes: 1024 * 1024 * 1024,
  hardHostAvailableBytes: 512 * 1024 * 1024,
  recoveryCgroupPercent: 55,
  recoveryHostAvailableBytes: 1536 * 1024 * 1024,
  recoverySamples: 3,
  // Browser subprocess spikes can rise and fall between a 30 s scheduler
  // tick. Persisting is independently throttled, so a 10 s observation rate
  // improves protection without turning the heartbeat record into write churn.
  pollIntervalMs: 10_000,
  degradedReviewerConcurrency: 1,
  degradedMaxCandidates: 10,
};

export interface MemoryPressureSample {
  sampledAt: string;
  cgroupCurrentBytes: number | null;
  cgroupMaxBytes: number | null;
  cgroupPercent: number | null;
  hostMemAvailableBytes: number | null;
  nodeRssBytes: number | null;
  cgroupOomKills?: number;
  cgroupHighEvents?: number;
  reasons: string[];
}

export interface MemoryPressureClassification {
  level: MemoryPressureLevel;
  reasons: string[];
}

export interface MemoryPressureEventBaseline {
  cgroupOomKills?: number;
  cgroupHighEvents?: number;
}

export interface MemoryPressureObservation {
  mode: MemoryPressureMode;
  level: MemoryPressureLevel;
  transition: MemoryPressureTransition;
  recoverySamples: number;
  sample: MemoryPressureSample;
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const parsed = finiteNumber(env[key]);
  if (parsed === undefined || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function readBytes(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  return readNumber(env, key, fallback, 1);
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value == null || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function getDistillationMemoryPressureConfig(
  env: NodeJS.ProcessEnv = process.env,
): MemoryPressureConfig {
  const configured = {
    enabled: readBoolean(env, 'DISTILLATION_MEMORY_PRESSURE_ENABLED', true),
    softCgroupPercent: readNumber(env, 'DISTILLATION_MEMORY_PRESSURE_SOFT_CGROUP_PERCENT', DEFAULT_MEMORY_PRESSURE_CONFIG.softCgroupPercent, 1, 99),
    hardCgroupPercent: readNumber(env, 'DISTILLATION_MEMORY_PRESSURE_HARD_CGROUP_PERCENT', DEFAULT_MEMORY_PRESSURE_CONFIG.hardCgroupPercent, 1, 100),
    softHostAvailableBytes: readBytes(env, 'DISTILLATION_MEMORY_PRESSURE_SOFT_HOST_AVAILABLE_BYTES', DEFAULT_MEMORY_PRESSURE_CONFIG.softHostAvailableBytes),
    hardHostAvailableBytes: readBytes(env, 'DISTILLATION_MEMORY_PRESSURE_HARD_HOST_AVAILABLE_BYTES', DEFAULT_MEMORY_PRESSURE_CONFIG.hardHostAvailableBytes),
    recoveryCgroupPercent: readNumber(env, 'DISTILLATION_MEMORY_PRESSURE_RECOVERY_CGROUP_PERCENT', DEFAULT_MEMORY_PRESSURE_CONFIG.recoveryCgroupPercent, 1, 99),
    recoveryHostAvailableBytes: readBytes(env, 'DISTILLATION_MEMORY_PRESSURE_RECOVERY_HOST_AVAILABLE_BYTES', DEFAULT_MEMORY_PRESSURE_CONFIG.recoveryHostAvailableBytes),
    recoverySamples: Math.floor(readNumber(env, 'DISTILLATION_MEMORY_PRESSURE_RECOVERY_SAMPLES', DEFAULT_MEMORY_PRESSURE_CONFIG.recoverySamples, 1, 100)),
    pollIntervalMs: Math.floor(readNumber(env, 'DISTILLATION_MEMORY_PRESSURE_POLL_INTERVAL_MS', DEFAULT_MEMORY_PRESSURE_CONFIG.pollIntervalMs, 1_000, 24 * 60 * 60 * 1_000)),
    degradedReviewerConcurrency: Math.floor(readNumber(env, 'DISTILLATION_MEMORY_PRESSURE_DEGRADED_REVIEWER_CONCURRENCY', DEFAULT_MEMORY_PRESSURE_CONFIG.degradedReviewerConcurrency, 1, 32)),
    degradedMaxCandidates: Math.floor(readNumber(env, 'DISTILLATION_MEMORY_PRESSURE_DEGRADED_MAX_CANDIDATES', DEFAULT_MEMORY_PRESSURE_CONFIG.degradedMaxCandidates, 1, 10_000)),
  } satisfies MemoryPressureConfig;

  // Preserve three genuinely distinct bands. If soft and hard collapsed to
  // the same value, the classifier would jump straight from normal to hard
  // and never exercise the intended temporary 1/10 degraded mode.
  configured.hardCgroupPercent = Math.min(
    100,
    Math.max(configured.softCgroupPercent + 1, configured.hardCgroupPercent),
  );
  configured.softHostAvailableBytes = Math.max(2, configured.softHostAvailableBytes);
  configured.hardHostAvailableBytes = Math.min(
    configured.softHostAvailableBytes - 1,
    configured.hardHostAvailableBytes,
  );
  configured.recoveryCgroupPercent = Math.max(
    0,
    Math.min(configured.recoveryCgroupPercent, configured.softCgroupPercent - 1),
  );
  configured.recoveryHostAvailableBytes = Math.max(
    configured.recoveryHostAvailableBytes,
    configured.softHostAvailableBytes + 1,
  );
  return configured;
}

function parseMeminfoAvailableBytes(content: string): number | null {
  const match = content.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value * 1024 : null;
}

function parseCgroupValue(content: string): number | null {
  const value = content.trim();
  if (!value || value === 'max') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readCgroupPath(readFile: (filePath: string) => string): string | null {
  try {
    const line = readFile('/proc/self/cgroup')
      .split('\n')
      .find(item => item.startsWith('0::'));
    if (!line) return null;
    const relative = line.slice(3).trim();
    if (!relative || relative.includes('..')) return null;
    return path.join('/sys/fs/cgroup', relative);
  } catch {
    return null;
  }
}

function readCgroupEvents(readFile: (filePath: string) => string, cgroupPath: string): {
  oomKills?: number;
  high?: number;
} {
  try {
    const values = new Map(
      readFile(path.join(cgroupPath, 'memory.events'))
        .split('\n')
        .map(line => line.trim().split(/\s+/))
        .filter(parts => parts.length === 2)
        .map(([key, value]) => [key, Number(value)] as const),
    );
    return {
      ...(Number.isFinite(values.get('oom_kill')) ? { oomKills: values.get('oom_kill') } : {}),
      ...(Number.isFinite(values.get('high')) ? { high: values.get('high') } : {}),
    };
  } catch {
    return {};
  }
}

export function readSystemMemoryPressureSample(
  readFile: (filePath: string, encoding?: BufferEncoding) => string = filePath => fs.readFileSync(filePath, 'utf8'),
  nodeRssBytes: number = process.memoryUsage().rss,
): MemoryPressureSample {
  const reasons: string[] = [];
  let cgroupCurrentBytes: number | null = null;
  let cgroupMaxBytes: number | null = null;
  let cgroupPercent: number | null = null;
  let cgroupOomKills: number | undefined;
  let cgroupHighEvents: number | undefined;

  const cgroupPath = readCgroupPath(readFile);
  if (cgroupPath) {
    try {
      cgroupCurrentBytes = parseCgroupValue(readFile(path.join(cgroupPath, 'memory.current')));
      cgroupMaxBytes = parseCgroupValue(readFile(path.join(cgroupPath, 'memory.max')));
      if (cgroupCurrentBytes !== null && cgroupMaxBytes !== null && cgroupMaxBytes > 0) {
        cgroupPercent = (cgroupCurrentBytes / cgroupMaxBytes) * 100;
      }
      const events = readCgroupEvents(readFile, cgroupPath);
      cgroupOomKills = events.oomKills;
      cgroupHighEvents = events.high;
    } catch {
      reasons.push('cgroup-read-failed');
    }
  } else {
    reasons.push('cgroup-unavailable');
  }

  let hostMemAvailableBytes: number | null = null;
  try {
    hostMemAvailableBytes = parseMeminfoAvailableBytes(readFile('/proc/meminfo'));
  } catch {
    hostMemAvailableBytes = os.freemem();
    reasons.push('memavailable-unavailable');
  }

  return {
    sampledAt: new Date().toISOString(),
    cgroupCurrentBytes,
    cgroupMaxBytes,
    cgroupPercent,
    hostMemAvailableBytes,
    nodeRssBytes: Number.isFinite(nodeRssBytes) ? nodeRssBytes : null,
    ...(cgroupOomKills === undefined ? {} : { cgroupOomKills }),
    ...(cgroupHighEvents === undefined ? {} : { cgroupHighEvents }),
    reasons,
  };
}

export function classifyMemoryPressure(
  sample: MemoryPressureSample,
  config: MemoryPressureConfig,
  previousEvents?: MemoryPressureEventBaseline,
): MemoryPressureClassification {
  const reasons: string[] = [...sample.reasons];
  const oomKillIncreased = sample.cgroupOomKills !== undefined
    && previousEvents?.cgroupOomKills !== undefined
    && sample.cgroupOomKills > previousEvents.cgroupOomKills;
  const highEventIncreased = sample.cgroupHighEvents !== undefined
    && previousEvents?.cgroupHighEvents !== undefined
    && sample.cgroupHighEvents > previousEvents.cgroupHighEvents;
  const hard = (
    (sample.cgroupPercent !== null && sample.cgroupPercent >= config.hardCgroupPercent)
    || (sample.hostMemAvailableBytes !== null && sample.hostMemAvailableBytes <= config.hardHostAvailableBytes)
    || oomKillIncreased
  );
  if (hard) {
    if (sample.cgroupPercent !== null && sample.cgroupPercent >= config.hardCgroupPercent) reasons.push('cgroup-hard');
    if (sample.hostMemAvailableBytes !== null && sample.hostMemAvailableBytes <= config.hardHostAvailableBytes) reasons.push('host-hard');
    if (oomKillIncreased) reasons.push('cgroup-oom-kill');
    return { level: 'hard', reasons: [...new Set(reasons)] };
  }

  const soft = (
    (sample.cgroupPercent !== null && sample.cgroupPercent >= config.softCgroupPercent)
    || (sample.hostMemAvailableBytes !== null && sample.hostMemAvailableBytes <= config.softHostAvailableBytes)
    || highEventIncreased
  );
  if (soft) {
    if (sample.cgroupPercent !== null && sample.cgroupPercent >= config.softCgroupPercent) reasons.push('cgroup-soft');
    if (sample.hostMemAvailableBytes !== null && sample.hostMemAvailableBytes <= config.softHostAvailableBytes) reasons.push('host-soft');
    if (highEventIncreased) reasons.push('cgroup-high-event');
    return { level: 'soft', reasons: [...new Set(reasons)] };
  }
  return { level: 'normal', reasons: [...new Set(reasons)] };
}

function isRecovered(sample: MemoryPressureSample, config: MemoryPressureConfig): boolean {
  const cgroupRecovered = sample.cgroupPercent === null || sample.cgroupPercent <= config.recoveryCgroupPercent;
  const hostRecovered = sample.hostMemAvailableBytes === null
    || sample.hostMemAvailableBytes >= config.recoveryHostAvailableBytes;
  return cgroupRecovered && hostRecovered;
}

export class MemoryPressureGuard {
  private readonly config: Required<MemoryPressureConfig>;
  private currentMode: MemoryPressureMode = 'normal';
  private consecutiveRecoverySamples = 0;
  private previousEvents: MemoryPressureEventBaseline | undefined;

  constructor(config: MemoryPressureConfig = DEFAULT_MEMORY_PRESSURE_CONFIG) {
    this.config = {
      ...DEFAULT_MEMORY_PRESSURE_CONFIG,
      ...config,
      enabled: config.enabled !== false,
    };
  }

  get mode(): MemoryPressureMode {
    return this.currentMode;
  }

  get recoverySamples(): number {
    return this.consecutiveRecoverySamples;
  }

  /** Reset the guard after an operator disables/re-enables the feature. */
  reset(): void {
    this.currentMode = 'normal';
    this.consecutiveRecoverySamples = 0;
    this.previousEvents = undefined;
  }

  observe(sample: MemoryPressureSample): MemoryPressureObservation {
    if (!this.config.enabled) {
      return {
        mode: this.currentMode,
        level: 'normal',
        transition: 'none',
        recoverySamples: this.consecutiveRecoverySamples,
        sample,
      };
    }

    const classification = classifyMemoryPressure(sample, this.config, this.previousEvents);
    let transition: MemoryPressureTransition = 'none';
    if (this.currentMode === 'normal') {
      this.consecutiveRecoverySamples = 0;
      if (classification.level === 'hard') {
        this.currentMode = 'suspended';
        transition = 'suspended';
      } else if (classification.level === 'soft') {
        this.currentMode = 'degraded';
        transition = 'degraded';
      }
    } else if (this.currentMode === 'degraded') {
      if (classification.level === 'hard') {
        this.currentMode = 'suspended';
        this.consecutiveRecoverySamples = 0;
        transition = 'suspended';
      } else if (classification.level === 'normal' && isRecovered(sample, this.config)) {
        this.consecutiveRecoverySamples += 1;
        if (this.consecutiveRecoverySamples >= this.config.recoverySamples) {
          this.currentMode = 'normal';
          this.consecutiveRecoverySamples = 0;
          transition = 'recovered-to-normal';
        }
      } else {
        this.consecutiveRecoverySamples = 0;
      }
    } else if (classification.level === 'normal' && isRecovered(sample, this.config)) {
      this.consecutiveRecoverySamples += 1;
      if (this.consecutiveRecoverySamples >= this.config.recoverySamples) {
        this.currentMode = 'degraded';
        this.consecutiveRecoverySamples = 0;
        transition = 'recovered-to-degraded';
      }
    } else {
      this.consecutiveRecoverySamples = 0;
    }

    this.previousEvents = {
      ...(sample.cgroupOomKills === undefined ? {} : { cgroupOomKills: sample.cgroupOomKills }),
      ...(sample.cgroupHighEvents === undefined ? {} : { cgroupHighEvents: sample.cgroupHighEvents }),
    };

    return {
      mode: this.currentMode,
      level: classification.level,
      transition,
      recoverySamples: this.consecutiveRecoverySamples,
      sample: {
        ...sample,
        reasons: classification.reasons,
      },
    };
  }
}
