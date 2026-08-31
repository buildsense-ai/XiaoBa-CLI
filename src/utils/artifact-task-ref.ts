export const CATSCO_ARTIFACT_TASK_REF_ENV = 'CATSCO_ARTIFACT_TASK_REF';

const ARTIFACT_TASK_REF_PATTERN = /^atr_[A-Za-z0-9_-]{43}$/;

export function normalizeArtifactTaskRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim() || !ARTIFACT_TASK_REF_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

export function withArtifactTaskRefEnvironment(
  environment: NodeJS.ProcessEnv,
  taskRef: unknown,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() === CATSCO_ARTIFACT_TASK_REF_ENV) {
      delete next[key];
    }
  }
  const normalized = normalizeArtifactTaskRef(taskRef);
  if (normalized) {
    next[CATSCO_ARTIFACT_TASK_REF_ENV] = normalized;
  }
  return next;
}
