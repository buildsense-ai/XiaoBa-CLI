export const RUNTIME_SHUTDOWN_MESSAGE_TYPE = 'xiaoba.runtime.shutdown' as const;

export interface RuntimeShutdownMessage {
  type: typeof RUNTIME_SHUTDOWN_MESSAGE_TYPE;
}

export function isRuntimeShutdownMessage(value: unknown): value is RuntimeShutdownMessage {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === RUNTIME_SHUTDOWN_MESSAGE_TYPE,
  );
}
