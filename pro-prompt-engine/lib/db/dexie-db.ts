import Dexie, { type Table } from 'dexie';
import type { Profile } from '@lib/types/profile.types';
import type { Snippet } from '@lib/types/snippet.types';
import type { RunRecord, RunEvent } from '@lib/types/run.types';
import type { SitePolicy } from '@lib/db/policy-store';

export interface PromptHistoryEntry {
  id?: number;
  profileId: number;
  originalPrompt: string;
  refinedPrompt: string;
  score: number;
  iterations: number;
  provider: string;
  tokensUsed: number;
  createdAt: number;
}

export interface Setting { key: string; value: unknown; }

/** [Phase 6: the real saved-task shape — steps, tags, provenance] */
export interface SavedTask {
  id?: number;
  name: string;
  tags: string[];
  lastUsedAt: number;
  useCount: number;
}

// Exported (not just the singleton below) so tests/unit/profile-store.spec.ts
// can open independent, uniquely-named databases per test case — fake-
// indexeddb persists data by database name for the life of the process, and
// a shared name across tests would leak state between them.
export class ProPromptDB extends Dexie {
  profiles!: Table<Profile>;
  snippets!: Table<Snippet>;
  promptHistory!: Table<PromptHistoryEntry>;
  settings!: Table<Setting>;
  runs!: Table<RunRecord>;
  runEvents!: Table<RunEvent>;
  sitePolicy!: Table<SitePolicy>;
  tasks!: Table<SavedTask>;

  constructor(dbName = 'ProPromptEngine') {
    super(dbName);

    // v1 retained verbatim so an existing install can be opened and upgraded.
    this.version(1).stores({
      profiles: '++id, name, isActive, createdAt',
      snippets: '++id, prefix, profileId, createdAt',
      promptHistory: '++id, profileId, score, createdAt',
      settings: 'key',
      analytics: '++id, event, timestamp',
    });

    this.version(2)
      .stores({
        // analytics: null drops the table. One event kind was ever written
        // ('context_added'); AnalyticsView reads promptHistory, not analytics.
        analytics: null,
        profiles: '++id, name, isActive, createdAt',
        snippets: '++id, prefix, profileId, createdAt',
        promptHistory: '++id, profileId, score, createdAt',
        settings: 'key',
        runs: '++id, state, startedAt, origin',
        runEvents: '++id, runId, seq, kind, at, tabId',
        sitePolicy: 'origin, grantedAt',
        tasks: '++id, name, *tags, lastUsedAt, useCount',
      })
      .upgrade(async (tx) => {
        // Normalise isActive to 0 | 1 so the index actually contains every row.
        const profiles = await tx.table('profiles').toArray();
        let activeSeen = false;
        for (const p of profiles) {
          const isActive = (p.isActive === true || p.isActive === 1) && !activeSeen;
          if (isActive) activeSeen = true;
          await tx.table('profiles').update(p.id, { isActive: isActive ? 1 : 0 });
        }
        // Cold-start contract: exactly one active profile, always.
        // If the upgrade found none (the normal case for an install that has
        // been running with the defect), promote the lowest id rather than
        // leaving the product with no profile.
        if (!activeSeen && profiles.length > 0) {
          const first = profiles.reduce((a, b) => (a.id! < b.id! ? a : b));
          await tx.table('profiles').update(first.id, { isActive: 1 });
        }
      });
  }
}

export const db = new ProPromptDB();

export async function seedDefaultProfiles(): Promise<void> {
  const count = await db.profiles.count();
  if (count > 0) return;

  const now = Date.now();
  const defaults: Omit<Profile, 'id'>[] = [
    {
      name: 'All-Rounder', description: 'Versatile profile for general-purpose prompt engineering.', icon: '🌐',
      isActive: 1, isCustom: false, contextMd: '',
      promptGuidelinesMd: `# All-Rounder Guidelines\n\n1. **Clarity First**: State the primary objective in the first sentence.\n2. **Structure**: Use numbered steps or sections for multi-part tasks.\n3. **Constraints**: Define output format, length, and any forbidden content.\n4. **Context**: Provide relevant background concisely without overwhelming.\n5. **Role**: Assign a clear expert role to the model when helpful.`,
      profileDescriptionMd: 'A balanced, general-purpose profile suitable for any domain or task type.',
      scoringGuidelinesMd: `# All-Rounder Scoring Criteria\n\n- **Intent Clarity (35%)**: Is the primary goal unambiguous in the first 2 sentences?\n- **Constraint Definition (25%)**: Are output format, length, and tone explicitly specified?\n- **Context Sufficiency (20%)**: Is enough background provided for a model to respond correctly?\n- **Role/Persona (20%)**: Is a useful expert role assigned when the task benefits from one?\n\nA score >= 75 means the prompt is production-ready. Below 50 means critical information is missing.`,
      agentWeights: { refactor: 0.8, scorer: 0.7, generator: 0.7, comprehension: 0.6 }, createdAt: now, updatedAt: now,
    },
    {
      name: 'Developer', description: 'Optimized for code generation, reviews, and technical docs.', icon: '💻',
      isActive: 0, isCustom: false, contextMd: '',
      promptGuidelinesMd: `# Developer Guidelines\n\n1. **Precision**: Always specify language, framework, and version.\n2. **Edge Cases**: Explicitly request error handling, null checks, and edge case coverage.\n3. **Code Style**: Mention naming conventions, documentation standards (JSDoc, docstrings).\n4. **Testing**: Include test expectations or ask for unit tests.\n5. **Architecture**: For larger tasks, request modular, reusable implementations.`,
      profileDescriptionMd: 'Developer-focused profile optimizing for code quality, correctness, and technical precision.',
      scoringGuidelinesMd: `# Developer Scoring Criteria\n\n- **Technical Specificity (40%)**: Are language, framework, version, and constraints explicitly stated?\n- **Edge Case Coverage (30%)**: Does the prompt request error handling and edge cases?\n- **Output Format (20%)**: Is the expected code structure, style, or format defined?\n- **Testability (10%)**: Does the prompt mention testing expectations?\n\nA score >= 75 means a developer model can produce production-ready code. Deduct heavily for vague language like "make it work" or "do the thing".`,
      agentWeights: { refactor: 0.9, scorer: 0.8, generator: 0.7, comprehension: 0.8 }, createdAt: now, updatedAt: now,
    },
    {
      name: 'Finance', description: 'Financial analysis, modeling, and compliance-aware prompts.', icon: '📊',
      isActive: 0, isCustom: false, contextMd: '',
      promptGuidelinesMd: `# Finance Guidelines\n\n1. **Data Precision**: Always reference specific data points, dates, and sources.\n2. **Compliance**: Reference relevant regulations (IFRS, GAAP, SEC rules) when applicable.\n3. **Risk Framing**: Frame requests to include risk factors and uncertainty ranges.\n4. **Sources**: Specify required data sources or note when assumptions are needed.\n5. **Objectivity**: Avoid biased framing; request balanced analysis.`,
      profileDescriptionMd: 'Finance-oriented profile for analysis, modeling, and regulatory compliance tasks.',
      scoringGuidelinesMd: `# Finance Scoring Criteria\n\n- **Data Specificity (35%)**: Are specific metrics, timeframes, and data sources referenced?\n- **Regulatory Awareness (25%)**: Are relevant compliance frameworks mentioned when applicable?\n- **Risk Inclusion (25%)**: Does the prompt ask for risk factors or confidence ranges?\n- **Objectivity (15%)**: Is the framing neutral and analytical (not leading)?\n\nPrompts missing specific data references or timeframes score below 50.`,
      agentWeights: { refactor: 0.8, scorer: 0.9, generator: 0.6, comprehension: 0.9 }, createdAt: now, updatedAt: now,
    },
    {
      name: 'Study', description: 'Educational content, study materials, and exam preparation.', icon: '📚',
      isActive: 0, isCustom: false, contextMd: '',
      promptGuidelinesMd: `# Study Guidelines\n\n1. **Pedagogy**: Structure content for progressive learning (simple → complex).\n2. **Engagement**: Request examples, analogies, and real-world connections.\n3. **Assessment**: Include practice problems or self-check questions.\n4. **Simplification**: Ask for digestible chunks, avoiding jargon unless defined.\n5. **Level**: Always specify the target audience level (beginner, intermediate, expert).`,
      profileDescriptionMd: 'Education-focused profile for creating tutorials, study guides, and learning materials.',
      scoringGuidelinesMd: `# Study Scoring Criteria\n\n- **Audience Clarity (30%)**: Is the target learner level explicitly stated?\n- **Pedagogical Structure (30%)**: Does the prompt request progressive, structured content?\n- **Engagement Elements (20%)**: Does it ask for examples, analogies, or exercises?\n- **Assessment Component (20%)**: Does it include practice questions or knowledge checks?\n\nPrompts that don't specify the audience level automatically lose 30 points.`,
      agentWeights: { refactor: 0.7, scorer: 0.7, generator: 0.8, comprehension: 0.7 }, createdAt: now, updatedAt: now,
    },
    {
      name: 'Competitive Coder', description: 'Algorithmic problem solving, DSA, and competitive programming.', icon: '🏆',
      isActive: 0, isCustom: false, contextMd: '',
      promptGuidelinesMd: `# Competitive Coder Guidelines\n\n1. **Complexity Requirements**: Always state time and space complexity targets (e.g., O(n log n)).\n2. **Input Constraints**: Define input size limits, data types, and edge cases explicitly.\n3. **Approach Breadth**: Request both brute-force and optimal solutions with trade-off analysis.\n4. **Test Cases**: Include sample inputs/outputs and edge cases (empty, max, duplicates).\n5. **Language**: Specify the target language (C++, Python, Java) and any standard library restrictions.`,
      profileDescriptionMd: 'Competitive programming profile focused on algorithmic thinking, DSA, and optimal solutions.',
      scoringGuidelinesMd: `# Competitive Coder Scoring Criteria\n\n- **Constraint Specification (35%)**: Are time/space complexity and input size limits defined?\n- **Edge Case Coverage (30%)**: Are boundary conditions, empty inputs, and overflow scenarios mentioned?\n- **Solution Scope (20%)**: Does the prompt ask for both brute force and optimal approaches?\n- **Reproducibility (15%)**: Are sample I/O cases provided?\n\nA prompt missing complexity constraints scores below 50 regardless of other quality.`,
      agentWeights: { refactor: 0.9, scorer: 0.9, generator: 0.6, comprehension: 0.7 }, createdAt: now, updatedAt: now,
    },
    {
      name: 'Creativity', description: 'Creative writing, brainstorming, storytelling, and artistic content.', icon: '🎨',
      isActive: 0, isCustom: false, contextMd: '',
      promptGuidelinesMd: `# Creativity Guidelines\n\n1. **Tone & Voice**: Define mood, emotional register, and narrative voice explicitly.\n2. **Inspiration**: Reference styles, authors, or works to emulate when helpful.\n3. **Creative Freedom**: Leave intentional interpretive space; over-constraining kills creativity.\n4. **Format**: Specify format (poem, story, script, brainstorm list) and rough length.\n5. **Originality**: Request original content, not summaries of existing works.`,
      profileDescriptionMd: 'Creativity-focused profile for storytelling, artistic content, and imaginative brainstorming.',
      scoringGuidelinesMd: `# Creativity Scoring Criteria\n\n- **Tone Definition (30%)**: Is the emotional register, mood, or voice clearly described?\n- **Format Clarity (25%)**: Is the output format (poem, story, list) and rough length specified?\n- **Creative Space (25%)**: Does the prompt leave room for interpretation without being vague?\n- **Inspiration Anchors (20%)**: Are reference styles or works mentioned to guide the output?\n\nNote: For creative prompts, being too prescriptive is also penalized. A prompt that over-specifies every detail scores below 60.`,
      agentWeights: { refactor: 0.6, scorer: 0.5, generator: 0.9, comprehension: 0.5 }, createdAt: now, updatedAt: now,
    },
  ];

  await db.profiles.bulkAdd(defaults as Profile[]);
  console.log(`[DB] Seeded ${defaults.length} default profiles`);
}

export async function seedDefaultSnippets(): Promise<void> {
  const count = await db.snippets.count();
  if (count > 0) return;
  const now = Date.now();
  // IMPORTANT: All prefixes MUST start with /  (not @)
  await db.snippets.bulkAdd([
    { prefix: '/dev', description: 'Senior TypeScript dev persona', body: 'You are a senior TypeScript developer with 10+ years of experience. Write clean, type-safe, maintainable code with proper error handling and JSDoc comments.', createdAt: now, updatedAt: now },
    { prefix: '/json', description: 'JSON output format', body: 'Output your response as valid JSON only. No markdown, no explanation text, no code blocks. Just the raw JSON object.', createdAt: now, updatedAt: now },
    { prefix: '/step', description: 'Step-by-step reasoning', body: 'Think step-by-step. Break down the problem systematically and provide a structured solution with clearly numbered steps. Show your reasoning at each step.', createdAt: now, updatedAt: now },
    { prefix: '/crit', description: 'Critical analysis', body: 'Analyze critically from multiple perspectives. Consider potential flaws, edge cases, counterarguments, and unintended consequences. Be direct and honest.', createdAt: now, updatedAt: now },
    { prefix: '/short', description: 'Concise output', body: 'Be extremely concise. Maximum 3 sentences. No preamble, no filler, no "certainly!" — just the direct answer.', createdAt: now, updatedAt: now },
    { prefix: '/expert', description: 'Domain expert persona', body: 'You are a world-class expert in this domain with 20+ years of hands-on experience. Provide authoritative, nuanced guidance that goes beyond surface-level explanations.', createdAt: now, updatedAt: now },
  ] as Snippet[]);
  console.log('[DB] Seeded 6 default snippets with / prefixes');
}
