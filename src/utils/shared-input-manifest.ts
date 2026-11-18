import { createHash, randomUUID } from 'node:crypto';

export const SHARED_INPUT_MANIFEST_ENCODING = 'shared-input-manifest/1';
const MAX_DEFINITIONS = 4096;
const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_ENCODED_MANIFEST_BYTES = 80 * 1024;

/** Per logger/session ordered definition cache. Definitions contain existing metadata only. */
export class SharedInputManifestEncoder {
  private definitions = new Map<string, string>();
  private bytes = 0;
  private epoch = randomUUID();
  private resetPending = true;

  private clearCache(): void {
    this.definitions.clear();
    this.bytes = 0;
    this.epoch = randomUUID();
    this.resetPending = true;
  }

  encodeEvent(event: any): any {
    if (event?.type !== 'execution_graph' || event?.payload?.type !== 'successful_model_call') return event;
    const payload = event.payload;
    const manifest = payload.input_manifest;
    if (!manifest || !Array.isArray(manifest.items) || typeof payload.input_manifest_sha256 !== 'string') return event;

    const canonicalDefinitions = manifest.items.map((item: unknown) => JSON.stringify(item));
    const definitionSizes = new Map<string, number>();
    for (const value of canonicalDefinitions) {
      const id = createHash('sha256').update(value).digest('hex');
      definitionSizes.set(id, Buffer.byteLength(value, 'utf8'));
    }
    const needed = [...definitionSizes.values()].reduce((sum, size) => sum + size, 0);
    const newDefinitions = [...definitionSizes.keys()].filter(id => !this.definitions.has(id)).length;
    const capacityReset = this.definitions.size + newDefinitions > MAX_DEFINITIONS || this.bytes + [...definitionSizes]
      .filter(([id]) => !this.definitions.has(id)).reduce((sum, [, size]) => sum + size, 0) > MAX_DEFINITION_BYTES;
    if (capacityReset) this.clearCache();
    if (needed > MAX_DEFINITION_BYTES || definitionSizes.size > MAX_DEFINITIONS) {
      this.clearCache();
      return event;
    }

    const items = manifest.items.map((item: unknown, index: number) => {
      const definition = canonicalDefinitions[index];
      const id = createHash('sha256').update(definition).digest('hex');
      if (this.definitions.has(id)) return { ref: id };
      this.definitions.set(id, definition);
      this.bytes += Buffer.byteLength(definition, 'utf8');
      return { definition: item };
    });
    const encodedManifest = { ...manifest, items };
    if (Buffer.byteLength(JSON.stringify(encodedManifest), 'utf8') > MAX_ENCODED_MANIFEST_BYTES) {
      this.clearCache();
      return event;
    }
    const reset = this.resetPending;
    this.resetPending = false;
    return {
      ...event,
      payload: {
        ...payload,
        input_manifest_encoding: SHARED_INPUT_MANIFEST_ENCODING,
        input_manifest_epoch: this.epoch,
        input_manifest_reset: reset,
        input_manifest: encodedManifest,
      },
    };
  }
}
