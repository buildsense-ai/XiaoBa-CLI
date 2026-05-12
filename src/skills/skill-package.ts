import * as fs from 'fs';
import * as path from 'path';
import type { SkillPackageInfo } from '../types/skill';

interface ManifestEnvEntry {
  name?: unknown;
}

interface AgentToolsManifest {
  name?: unknown;
  schema_version?: unknown;
  package_version?: unknown;
  tools?: unknown;
  environment?: {
    required?: unknown;
    optional?: unknown;
  };
}

export interface SkillPackageValidation {
  ok: boolean;
  skillFile: string;
  packageInfo: SkillPackageInfo;
}

export function inspectSkillPackage(skillFilePath: string, env: NodeJS.ProcessEnv = process.env): SkillPackageInfo {
  const directory = path.dirname(skillFilePath);
  const manifestPath = path.join(directory, 'agent_tools.json');
  const hasManifest = fs.existsSync(manifestPath);
  const hasReadme = fileExistsAnyCase(directory, 'README.md');
  const hasLicense = fileExistsAnyCase(directory, 'LICENSE');
  const reasons: string[] = [];
  let invalidManifest: string | undefined;
  let manifestInfo: SkillPackageInfo['manifest'];
  let missingEnv: string[] = [];
  let hasManifestShapeError = false;

  if (hasManifest) {
    try {
      const manifest = JSON.parse(stripBom(fs.readFileSync(manifestPath, 'utf-8'))) as AgentToolsManifest;
      const requiredEnv = readEnvNames(manifest.environment?.required);
      const optionalEnv = readEnvNames(manifest.environment?.optional);
      missingEnv = requiredEnv.filter(key => !String(env[key] || '').trim());
      const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
      manifestInfo = {
        name: typeof manifest.name === 'string' ? manifest.name : undefined,
        schemaVersion: typeof manifest.schema_version === 'string' ? manifest.schema_version : undefined,
        packageVersion: typeof manifest.package_version === 'string' ? manifest.package_version : undefined,
        toolCount: tools.length,
        providerSafeToolNames: tools
          .map((tool: any) => typeof tool?.provider_safe_name === 'string' ? tool.provider_safe_name : '')
          .filter(Boolean),
        requiredEnv,
        optionalEnv,
      };

      if (!manifestInfo.schemaVersion) {
        hasManifestShapeError = true;
        reasons.push('agent_tools.json missing schema_version');
      }
      if (tools.length === 0) {
        hasManifestShapeError = true;
        reasons.push('agent_tools.json declares no tools');
      }
      const invalidToolReasons = validateToolDeclarations(tools);
      if (invalidToolReasons.length > 0) {
        hasManifestShapeError = true;
        reasons.push(...invalidToolReasons);
      }
    } catch (error: any) {
      invalidManifest = error?.message || String(error);
      reasons.push(`agent_tools.json is invalid: ${invalidManifest}`);
    }
  }

  if (missingEnv.length > 0) {
    reasons.push(`missing required env: ${missingEnv.join(', ')}`);
  }

  const status = invalidManifest || hasManifestShapeError
    ? 'invalid'
    : missingEnv.length > 0
      ? 'not_configured'
      : 'ready';

  return {
    directory,
    hasReadme,
    hasLicense,
    hasManifest,
    ...(hasManifest ? { manifestPath } : {}),
    ...(manifestInfo ? { manifest: manifestInfo } : {}),
    readiness: {
      status,
      reasons,
      missingEnv,
      ...(invalidManifest ? { invalidManifest } : {}),
    },
  };
}

function validateToolDeclarations(tools: unknown[]): string[] {
  const reasons: string[] = [];
  tools.forEach((tool, index) => {
    if (!isRecord(tool)) {
      reasons.push(`tools[${index}] must be an object`);
      return;
    }
    for (const key of ['name', 'provider_safe_name', 'command']) {
      if (typeof tool[key] !== 'string' || !tool[key].trim()) {
        reasons.push(`tools[${index}] missing ${key}`);
      }
    }
    if (!isRecord(tool.parameters_schema)) {
      reasons.push(`tools[${index}] missing parameters_schema`);
    }
    if (!isRecord(tool.output_schema)) {
      reasons.push(`tools[${index}] missing output_schema`);
    }
    if (typeof tool.timeout_seconds !== 'number' || !Number.isFinite(tool.timeout_seconds) || tool.timeout_seconds <= 0) {
      reasons.push(`tools[${index}] missing timeout_seconds`);
    }
  });
  return reasons;
}

export function validateInstalledSkillPackage(skillDir: string, env: NodeJS.ProcessEnv = process.env): SkillPackageValidation {
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Installed skill package is missing SKILL.md: ${skillDir}`);
  }
  const packageInfo = inspectSkillPackage(skillFile, env);
  return {
    ok: packageInfo.readiness.status !== 'invalid',
    skillFile,
    packageInfo,
  };
}

function readEnvNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(entry => {
      if (typeof entry === 'string') return entry;
      if (isRecord(entry)) {
        const envEntry = entry as ManifestEnvEntry;
        return typeof envEntry.name === 'string' ? envEntry.name : '';
      }
      return '';
    })
    .map(item => item.trim())
    .filter(Boolean);
}

function fileExistsAnyCase(directory: string, filename: string): boolean {
  if (fs.existsSync(path.join(directory, filename))) return true;
  if (!fs.existsSync(directory)) return false;
  const target = filename.toLowerCase();
  return fs.readdirSync(directory).some(entry => entry.toLowerCase() === target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
