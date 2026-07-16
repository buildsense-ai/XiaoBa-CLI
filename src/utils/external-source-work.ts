/** Canonical lane and catch-up action vocabulary shared by source and admission scheduling. */
export const EXTERNAL_ADMISSION_LANES = [
  'continuous',
  'catch-up',
  'backfill',
] as const;

export type ExternalAdmissionLane = typeof EXTERNAL_ADMISSION_LANES[number];

export type ExternalSourceWorkLane = Exclude<ExternalAdmissionLane, 'backfill'>;

export const EXTERNAL_CATCH_UP_ACTIONS = [
  'inventory',
  'stability',
  'page',
] as const;

export type ExternalCatchUpAction = typeof EXTERNAL_CATCH_UP_ACTIONS[number];
