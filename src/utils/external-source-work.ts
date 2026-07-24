/** Canonical lane and catch-up action vocabulary shared by source and admission scheduling. */
export const EXTERNAL_ADMISSION_LANES = [
  'continuous',
  'catch-up',
  'backfill',
] as const;

export type ExternalAdmissionLane = typeof EXTERNAL_ADMISSION_LANES[number];

export type ExternalSourceWorkLane = Exclude<ExternalAdmissionLane, 'backfill'>;

export type ExternalCatchUpAction = 'inventory' | 'stability' | 'page';
