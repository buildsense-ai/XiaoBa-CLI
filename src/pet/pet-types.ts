export type PetEventType =
  | 'skill_started'
  | 'skill_succeeded'
  | 'skill_failed'
  | 'task_completed'
  | 'message_completed'
  | 'level_up';

export type PetState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'skill'
  | 'notify'
  | 'sleepy'
  | 'success'
  | 'happy'
  | 'error'
  | 'level_up'
  | 'peek';

export interface PetEventInput {
  user_id?: string;
  agent_id?: string;
  session_id?: string;
  task_id?: string;
  event_type: PetEventType;
  skill_name?: string;
  status?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface PetEvent extends PetEventInput {
  id: string;
  user_id: string;
  agent_id: string;
  session_id: string;
  task_id: string;
  event_type: PetEventType;
  status: string;
  message: string;
  xp_delta: number;
  metadata: Record<string, unknown>;
  created_at: string;
  expire_at: string;
}

export interface PetProfile {
  user_id: string;
  agent_id: string;
  total_xp: number;
  level: number;
  title: string;
  current_state: PetState;
  current_bubble_message: string;
  last_event_id: string;
  last_event_type: PetEventType | '';
  last_skill_name: string;
  last_active_at: string;
  updated_at: string;
}

export interface PetSkillStats {
  user_id: string;
  agent_id: string;
  skill_name: string;
  call_count: number;
  success_count: number;
  fail_count: number;
  total_xp: number;
  skill_level: number;
  last_used_at: string;
  updated_at: string;
}

export interface PetLevelRule {
  level: number;
  min_xp: number;
  title: string;
}

export interface PetStatusResponse {
  current_state: PetState;
  current_bubble_message: string;
  level: number;
  title: string;
  total_xp: number;
  current_level_xp: number;
  next_level_xp: number | null;
  next_level_required_xp: number | null;
  last_event_id: string;
  last_event_type: PetEventType | '';
  last_skill_name: string;
}

export interface PetProgressResponse {
  level: number;
  title: string;
  total_xp: number;
  today_xp: number;
  skill_stats: PetSkillStats[];
  most_used_skills: PetSkillStats[];
  recent_level_up: PetEvent | null;
}

export interface PetStoreData {
  events: PetEvent[];
  profile: PetProfile;
  skill_stats: PetSkillStats[];
  last_cleanup_at?: string;
}
