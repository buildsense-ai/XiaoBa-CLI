import * as fs from 'fs';
import * as path from 'path';
import {
  applyPetEvent,
  cleanupPetEvents,
  createDefaultProfile,
  currentLevelXp,
  getNextLevelInfo,
  nextLevelRequiredXp,
  normalizePetEvent,
} from './pet-growth-engine';
import {
  PetEvent,
  PetEventInput,
  PetProgressResponse,
  PetStatusResponse,
  PetStoreData,
} from './pet-types';

const PET_STORE_FILE = 'pet-state.json';
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

export class PetStore {
  private readonly filePath: string;

  constructor(dataDir: string = resolvePetDataDir()) {
    this.filePath = path.join(dataDir, PET_STORE_FILE);
  }

  recordEvent(input: PetEventInput): PetEvent[] {
    const data = this.read();
    const now = new Date();
    this.cleanupIfNeeded(data, now);
    const event = normalizePetEvent(input, now);
    const events = applyPetEvent(data, event);
    data.events = [...events, ...(data.events || [])];
    data.events = cleanupPetEvents(data.events, now);
    this.write(data);
    return events;
  }

  getStatus(): PetStatusResponse {
    const data = this.readWithCleanup();
    const profile = data.profile || createDefaultProfile();
    const next = getNextLevelInfo(profile.total_xp);
    return {
      current_state: profile.current_state,
      current_bubble_message: profile.current_bubble_message,
      level: profile.level,
      title: profile.title,
      total_xp: profile.total_xp,
      current_level_xp: currentLevelXp(profile.total_xp),
      next_level_xp: next ? next.min_xp : null,
      next_level_required_xp: nextLevelRequiredXp(profile.total_xp),
      last_event_id: profile.last_event_id,
      last_event_type: profile.last_event_type,
      last_skill_name: profile.last_skill_name,
    };
  }

  getTimeline(limit = 20): PetEvent[] {
    const safeLimit = Math.max(1, Math.min(100, Number(limit || 20)));
    return this.readWithCleanup().events
      .slice()
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, safeLimit);
  }

  getProgress(): PetProgressResponse {
    const data = this.readWithCleanup();
    const profile = data.profile || createDefaultProfile();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayXp = data.events
      .filter(event => Date.parse(event.created_at) >= todayStart.getTime())
      .reduce((sum, event) => sum + Math.max(0, Number(event.xp_delta || 0)), 0);
    const skillStats = (data.skill_stats || [])
      .slice()
      .sort((a, b) => b.total_xp - a.total_xp || b.call_count - a.call_count);

    return {
      level: profile.level,
      title: profile.title,
      total_xp: profile.total_xp,
      today_xp: todayXp,
      skill_stats: skillStats,
      most_used_skills: skillStats.slice(0, 5),
      recent_level_up: data.events.find(event => event.event_type === 'level_up') || null,
    };
  }

  cleanupExpired(): void {
    const data = this.read();
    data.events = cleanupPetEvents(data.events || []);
    data.last_cleanup_at = new Date().toISOString();
    this.write(data);
  }

  private readWithCleanup(): PetStoreData {
    const data = this.read();
    if (this.cleanupIfNeeded(data)) this.write(data);
    return data;
  }

  private cleanupIfNeeded(data: PetStoreData, now = new Date()): boolean {
    const last = Date.parse(data.last_cleanup_at || '');
    if (Number.isFinite(last) && now.getTime() - last < CLEANUP_INTERVAL_MS) return false;
    data.events = cleanupPetEvents(data.events || [], now);
    data.last_cleanup_at = now.toISOString();
    return true;
  }

  private read(): PetStoreData {
    try {
      if (!fs.existsSync(this.filePath)) return createDefaultStoreData();
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PetStoreData>;
      return {
        events: Array.isArray(parsed.events) ? parsed.events : [],
        profile: parsed.profile || createDefaultProfile(),
        skill_stats: Array.isArray(parsed.skill_stats) ? parsed.skill_stats : [],
        last_cleanup_at: parsed.last_cleanup_at,
      };
    } catch (_error) {
      return createDefaultStoreData();
    }
  }

  private write(data: PetStoreData): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
}

export function resolvePetDataDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const explicit = String(env.XIAOBA_PET_DATA_DIR || '').trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);

  const electronUserData = String(env.XIAOBA_ELECTRON_USER_DATA_DIR || '').trim();
  if (electronUserData) {
    const resolved = path.isAbsolute(electronUserData) ? electronUserData : path.resolve(cwd, electronUserData);
    return path.join(resolved, 'pet');
  }

  return path.join(cwd, 'data', 'pet');
}

function createDefaultStoreData(): PetStoreData {
  return {
    events: [],
    profile: createDefaultProfile(),
    skill_stats: [],
    last_cleanup_at: new Date().toISOString(),
  };
}
