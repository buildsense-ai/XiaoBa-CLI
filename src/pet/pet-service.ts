import { PetStore } from './pet-store';
import { PetEventInput } from './pet-types';

export class PetService {
  constructor(private readonly store: PetStore = new PetStore()) {}

  recordEvent(input: PetEventInput): void {
    try {
      this.store.recordEvent(input);
    } catch (_error) {
      // Pet telemetry must never break the agent runtime.
    }
  }

  status() {
    return this.store.getStatus();
  }

  timeline(limit?: number) {
    return this.store.getTimeline(limit);
  }

  progress() {
    return this.store.getProgress();
  }

  cleanupExpired(): void {
    this.store.cleanupExpired();
  }
}

let defaultPetService: PetService | null = null;

export function getPetService(): PetService {
  if (!defaultPetService) defaultPetService = new PetService();
  return defaultPetService;
}
