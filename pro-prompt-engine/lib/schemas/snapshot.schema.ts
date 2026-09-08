/**
 * Snapshot schema — the perception message contract and the
 * PerceptionSnapshot shape. Phase 2 §3.3, §7.6.
 *
 * Every message agent.content.ts's onMessage listener receives is parsed
 * through PerceptionRequest before any handler runs; every response is
 * parsed through the matching response schema before it crosses back out of
 * the content script. A malformed snapshot never partially escapes — it is
 * rejected at the boundary with INVALID_SNAPSHOT (task 2.11).
 */
import { z } from 'zod';
import { OriginSchema } from '@lib/schemas/message.schema';

// ── Handles ──

/** An opaque, per-epoch handle. Never a selector, never an XPath, never a
 *  DOM node id (architecture.md §3.7.2). */
export const HandleSchema = z.string().regex(/^e[0-9]+$/);

// ── Request half (§3.3) ──

export const PerceptionRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('PERCEIVE_STRUCTURE'),
    runId: z.string(),
    region: z.string().optional(),
    tokenBudget: z.number().int().min(500).max(12_000).default(6_000),
  }),
  z.object({
    type: z.literal('PERCEIVE_ELEMENT'),
    runId: z.string(),
    handle: HandleSchema,
  }),
  z.object({
    type: z.literal('PERCEIVE_PAGE'),
    runId: z.string(),
  }),
  z.object({
    type: z.literal('WAIT_FOR_SETTLE'),
    runId: z.string(),
    maxMs: z.number().int().min(100).max(15_000).optional(),
  }),
]);

export type PerceptionRequestType = z.infer<typeof PerceptionRequest>;

// ── Element descriptor (§7.6) ──

export const NameSourceSchema = z.enum([
  'labelledby', 'label', 'native', 'content', 'title', 'placeholder', 'none',
]);

export const ElementDescriptorSchema = z.object({
  handle: HandleSchema,
  role: z.string(),
  name: z.string().max(120),
  nameSource: NameSourceSchema,
  tag: z.string(),
  inputType: z.string().optional(),
  valueShape: z.union([z.literal('empty'), z.literal('filled'), z.string()]).optional(),
  enabled: z.boolean(),
  visible: z.boolean(),
  inViewport: z.boolean(),
  actionable: z.boolean(),
  href: z.string().optional(),
  // The ONLY sensitive kind that survives the walk. password/payment/otp are
  // excluded and have no descriptor at all. Carried so the gate can re-check
  // independently (Phase 3 §4.6).
  sensitiveKind: z.enum(['file']).nullable(),
  autocomplete: z.string().optional(),
  formId: z.string().optional(),
  regionId: z.string(),
  ordinal: z.number().int(),
});

export type ElementDescriptor = z.infer<typeof ElementDescriptorSchema>;

// ── Region completeness (§7.3) ──

export const RegionCompletenessSchema = z.object({
  regionId: z.string(),
  label: z.string(),
  complete: z.boolean(),
  shown: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type RegionCompleteness = z.infer<typeof RegionCompletenessSchema>;

// ── The snapshot itself (§7.6) ──

export const PerceptionSnapshotSchema = z.object({
  runId: z.string(),
  tabId: z.number(),
  epoch: z.number().int().positive(),
  url: z.string().url(),
  origin: OriginSchema,
  title: z.string().max(200),
  settled: z.boolean(),
  settleWaitedMs: z.number().int(),
  settleCalibration: z.enum(['visible', 'hidden']),
  epochSuspect: z.boolean(),
  elements: z.array(ElementDescriptorSchema),
  excludedCount: z.number().int().nonnegative(),
  regions: z.array(RegionCompletenessSchema),
  unreachableRegions: z.array(z.string()),
  buildMs: z.number().int(),
  // Recorded, never silent (§7.5): a snapshot that overshot its budget
  // because Rule 1 (never truncate the target region) forced it to.
  overBudget: z.object({ by: z.number().int() }).optional(),
});

export type PerceptionSnapshot = z.infer<typeof PerceptionSnapshotSchema>;

// ── Settle result (§6.1) ──

export const SettleResultSchema = z.object({
  settled: z.boolean(),
  waitedMs: z.number().int(),
  calibration: z.enum(['visible', 'hidden']),
  mutations: z.number().int().nonnegative(),
  resourceEntries: z.number().int().nonnegative(),
  suspect: z.boolean(),
});

// ── read_page — disclosure class B (§8) ──

export const ReadPageResultSchema = z.object({
  class: z.literal('B'),
  text: z.string(),
  origin: OriginSchema,
  url: z.string().url(),
  capturedAt: z.number().int(),
});

// ── read_element resolution outcomes (§4.3) ──

export const PerceiveElementResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), element: ElementDescriptorSchema }),
  z.object({ kind: z.literal('reresolved'), element: ElementDescriptorSchema, confidence: z.number() }),
  z.object({ kind: z.literal('ambiguous'), candidates: z.array(ElementDescriptorSchema) }),
  z.object({ kind: z.literal('missing') }),
]);

// ── The response envelope every handler answers with ──
// Mirrors ExtensionResponse (lib/types/message.types.ts) but typed per verb
// so a malformed response can be rejected before postMessage serialises it.

export const PerceptionErrorSchema = z.object({
  status: z.literal('error'),
  message: z.enum([
    'INVALID_SNAPSHOT', 'INVALID_REQUEST', 'PERCEPTION_TOO_LARGE',
    'TARGET_MISSING', 'TARGET_AMBIGUOUS',
  ]),
});

export const PerceiveStructureResponseSchema = z.union([
  z.object({ status: z.literal('success'), data: PerceptionSnapshotSchema }),
  PerceptionErrorSchema,
]);

export const PerceiveElementResponseSchema = z.union([
  z.object({ status: z.literal('success'), data: PerceiveElementResultSchema }),
  PerceptionErrorSchema,
]);

export const PerceivePageResponseSchema = z.union([
  z.object({ status: z.literal('success'), data: ReadPageResultSchema }),
  PerceptionErrorSchema,
]);

export const WaitForSettleResponseSchema = z.union([
  z.object({ status: z.literal('success'), data: SettleResultSchema }),
  PerceptionErrorSchema,
]);
