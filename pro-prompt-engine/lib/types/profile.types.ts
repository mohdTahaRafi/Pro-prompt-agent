export interface Profile {
  id?: number;
  name: string;
  description: string;
  icon: string;
  isActive: 0 | 1;     // [Phase 1] not boolean — IndexedDB cannot index a boolean value
  isCustom: boolean;
  contextMd: string;
  promptGuidelinesMd: string;
  profileDescriptionMd: string;
  scoringGuidelinesMd?: string;
  agentWeights: AgentWeights;
  createdAt: number;
  updatedAt: number;
}

export interface AgentWeights {
  refactor: number;
  scorer: number;
  generator: number;
  comprehension: number;
}

export const DEFAULT_PROFILE_NAMES = [
  'All-Rounder', 'Finance', 'Study', 'Developer', 'Competitive Coder', 'Creativity',
] as const;

export type DefaultProfileName = typeof DEFAULT_PROFILE_NAMES[number];
