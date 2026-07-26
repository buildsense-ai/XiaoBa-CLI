const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const REQUEST_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const FAILURE_CACHE_TTL_MS = 60_000;

export interface ModelsDevModelReference {
  model: string;
  provider?: string;
}

interface ModelsDevModel {
  id?: unknown;
  modalities?: { input?: unknown };
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

interface CatalogCacheState {
  cached?: { value: ModelsDevCatalog; expiresAt: number };
  failureExpiresAt?: number;
  request?: Promise<ModelsDevCatalog | undefined>;
}

const catalogCaches = new WeakMap<typeof fetch, CatalogCacheState>();

function normalized(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function modelInputsImage(model: ModelsDevModel | undefined): boolean | undefined {
  const input = model?.modalities?.input;
  if (!Array.isArray(input)) return undefined;
  return input.map(normalized).includes('image');
}

function findModelInProvider(provider: ModelsDevProvider | undefined, modelName: string): ModelsDevModel | undefined {
  const models = provider?.models;
  if (!models) return undefined;
  const target = normalized(modelName);
  return Object.entries(models).find(([key, model]) => (
    normalized(key) === target || normalized(model.id) === target
  ))?.[1];
}

export function resolveModelsDevVision(
  catalog: ModelsDevCatalog,
  reference: ModelsDevModelReference,
): boolean | undefined {
  const providerName = normalized(reference.provider);
  if (providerName) {
    const providerEntry = Object.entries(catalog).find(([key]) => normalized(key) === providerName)?.[1];
    const officialMatch = findModelInProvider(providerEntry, reference.model);
    const officialVision = modelInputsImage(officialMatch);
    if (officialVision !== undefined) return officialVision;
  }

  const target = normalized(reference.model);
  const exactMatches: ModelsDevModel[] = [];
  const leafMatches: ModelsDevModel[] = [];
  for (const provider of Object.values(catalog)) {
    for (const [key, model] of Object.entries(provider?.models || {})) {
      const candidates = [normalized(key), normalized(model.id)];
      if (candidates.includes(target)) exactMatches.push(model);
      else if (candidates.some(candidate => candidate.split('/').pop() === target)) leafMatches.push(model);
    }
  }
  const matches = exactMatches.length > 0 ? exactMatches : leafMatches;
  const resolved = [...new Set(
    matches.map(modelInputsImage).filter((value): value is boolean => value !== undefined),
  )];
  if (resolved.length === 0) return undefined;
  return resolved.length === 1 ? resolved[0] : undefined;
}

async function requestCatalog(fetchImpl: typeof fetch): Promise<ModelsDevCatalog | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(MODELS_DEV_API_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload as ModelsDevCatalog : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCatalog(fetchImpl: typeof fetch): Promise<ModelsDevCatalog | undefined> {
  const now = Date.now();
  let state = catalogCaches.get(fetchImpl);
  if (!state) {
    state = {};
    catalogCaches.set(fetchImpl, state);
  }
  if (state.cached && state.cached.expiresAt > now) return state.cached.value;
  if (state.failureExpiresAt && state.failureExpiresAt > now) return undefined;
  if (!state.request) {
    state.request = requestCatalog(fetchImpl).then(value => {
      if (value) {
        state!.cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        state!.failureExpiresAt = undefined;
      } else {
        state!.failureExpiresAt = Date.now() + FAILURE_CACHE_TTL_MS;
      }
      return value;
    }).finally(() => { state!.request = undefined; });
  }
  return state.request;
}

export async function fetchModelsDevVision(
  reference: ModelsDevModelReference,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | undefined> {
  const catalog = await loadCatalog(fetchImpl);
  return catalog ? resolveModelsDevVision(catalog, reference) : undefined;
}

export async function fetchModelsDevVisionBatch(
  references: ModelsDevModelReference[],
  fetchImpl: typeof fetch = fetch,
): Promise<Array<boolean | undefined>> {
  const catalog = await loadCatalog(fetchImpl);
  return references.map(reference => catalog ? resolveModelsDevVision(catalog, reference) : undefined);
}
