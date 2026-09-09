import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const fields = ['REGION_ID', 'PROJECT_ID', 'IMAGE_PROJECT_ID', 'AZ_NAME', 'BASE_IMAGE_ID',
  'FLAVOR_ID', 'VPC_ID', 'SUBNET_ID', 'SECURITY_GROUP_ID', 'BASE_IMAGE_HARDENED', 'PROTECTED_IMAGE_IDS'];

export function resolveDeploymentProfile(profile, env) {
  if (!['private_nat', 'public_ip'].includes(profile)) throw new Error('Unknown worker deployment profile');
  const result = Object.fromEntries(fields.map(key => ['WORKER_' + key, env['WORKER_' + key] || '']));
  if (profile === 'public_ip') {
    const raw = JSON.parse(env.CTYUN_PUBLIC_WORKER_PROFILE_JSON || '{}');
    const allowed = new Map(fields.map(key => [key === 'IMAGE_PROJECT_ID' ? 'CTYUN_IMAGE_PROJECT_ID' : 'CTYUN_WORKER_' + key, 'WORKER_' + key]));
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('Invalid public worker profile');
    for (const key of Object.keys(result)) result[key] = ''; // no cross-region fallback
    for (const [key, value] of Object.entries(raw)) {
      if (!allowed.has(key)) throw new Error('Unsupported public worker profile field: ' + key);
      result[allowed.get(key)] = value;
    }
    if (result.WORKER_REGION_ID !== '200000004421') throw new Error('Public workers require Foshan 7');
  }
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid worker profile value: ' + key);
  }
  for (const key of fields.slice(0, 9)) {
    if (!result['WORKER_' + key].trim()) throw new Error('Worker profile requires ' + key);
  }
  result.WORKER_BASE_IMAGE_HARDENED ||= 'false';
  if (!['true', 'false'].includes(result.WORKER_BASE_IMAGE_HARDENED)) throw new Error('Invalid hardened-base flag');
  result.WORKER_PUBLIC_IP = profile === 'public_ip' ? 'true' : 'false';
  result.WORKER_DEPLOYMENT_PROFILE = profile;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const values = resolveDeploymentProfile(process.env.DEPLOYMENT_PROFILE || 'private_nat', process.env);
  if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
  fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(`Validated ${values.WORKER_DEPLOYMENT_PROFILE} image deployment configuration`);
}
