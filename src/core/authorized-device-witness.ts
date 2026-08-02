import { createHash } from 'node:crypto';
import type { Message } from '../types';
import type { DeviceGrantOperation } from '../types/session-identity';
import {
  authorizedDeviceProjectionTargetLine,
  type AuthorizedDeviceProjection,
} from './authorized-device-projection';

export interface AuthorizedDeviceContextWitness {
  schema: 'xiaoba.authorized_device_context_witness.v1';
  messageDigest: string;
  remoteTransportAvailable: boolean;
  devices: Array<{
    target: string;
    grantIds: string[];
    ownerUserId: string;
    deviceId: string;
    operations: DeviceGrantOperation[];
    operationExpiresAt: Partial<Record<DeviceGrantOperation, number>>;
    visibleLine: string;
  }>;
}

const witnesses = new WeakMap<Message, AuthorizedDeviceContextWitness>();

export function witnessAuthorizedDeviceContext(
  message: Message,
  projection: AuthorizedDeviceProjection,
  remoteTransportAvailable: boolean,
): void {
  if (projection.targets.length === 0) return;
  witnesses.set(message, {
    schema: 'xiaoba.authorized_device_context_witness.v1',
    messageDigest: messageDigest(message),
    remoteTransportAvailable,
    devices: projection.targets.map(target => ({
      target: target.target,
      grantIds: target.grants.map(grant => grant.grantId),
      ownerUserId: target.ownerUserId,
      deviceId: target.deviceId,
      operations: [...target.operations],
      operationExpiresAt: Object.fromEntries(target.operations.map(operation => [
        operation,
        Math.max(...target.grants
          .filter(grant => grant.operations.includes(operation))
          .map(grant => grant.expiresAt)),
      ])),
      visibleLine: authorizedDeviceProjectionTargetLine(target),
    })),
  });
}

export function preserveAuthorizedDeviceContextWitness(source: Message, target: Message): void {
  const witness = readWitness(source);
  if (
    !witness
    || source.role !== 'system'
    || target.role !== 'system'
    || contentDigest(source) !== contentDigest(target)
    || target.__context?.schema !== 'xiaoba.context_lifecycle.v1'
    || target.__context.source !== 'runtime_context'
    || target.__context.lifecycle !== 'episode'
    || target.__context.cacheScope !== 'epoch'
    || target.__context.persistence !== 'transient'
    || target.__cacheScope !== 'dynamic'
  ) return;
  witnesses.set(target, {
    ...witness,
    messageDigest: messageDigest(target),
    devices: cloneDevices(witness.devices),
  });
}

export function readAuthorizedDeviceContextWitness(
  message: Message,
): AuthorizedDeviceContextWitness | undefined {
  const witness = readWitness(message);
  if (
    !witness
    || message.role !== 'system'
    || message.__context?.schema !== 'xiaoba.context_lifecycle.v1'
    || message.__context.source !== 'runtime_context'
    || message.__context.lifecycle !== 'episode'
    || message.__context.cacheScope !== 'epoch'
    || message.__context.persistence !== 'transient'
    || message.__cacheScope !== 'dynamic'
  ) return undefined;
  return {
    ...witness,
    devices: cloneDevices(witness.devices),
  };
}

function readWitness(message: Message): AuthorizedDeviceContextWitness | undefined {
  const witness = witnesses.get(message);
  return witness?.messageDigest === messageDigest(message) ? witness : undefined;
}

function cloneDevices(devices: AuthorizedDeviceContextWitness['devices']): AuthorizedDeviceContextWitness['devices'] {
  return devices.map(device => ({
    ...device,
    grantIds: [...device.grantIds],
    operations: [...device.operations],
    operationExpiresAt: { ...device.operationExpiresAt },
  }));
}

function messageDigest(message: Message): string {
  return createHash('sha256').update(JSON.stringify({
    role: message.role,
    content: contentValue(message),
    context: message.__context || null,
    cacheScope: message.__cacheScope || null,
  })).digest('hex');
}

function contentDigest(message: Message): string {
  return createHash('sha256').update(contentValue(message)).digest('hex');
}

function contentValue(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
}
