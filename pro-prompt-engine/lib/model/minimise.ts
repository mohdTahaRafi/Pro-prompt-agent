/**
 * Minimisation — Class A assertion, Class B local condensation. §7.
 * Docs/planning/phase_4_model_tiers_routing.md §7.2, §7.3.
 *
 * Imports `route` from lib/model/router.ts, which imports `minimise` from
 * here — a genuine circular module reference, not an oversight. Both sides
 * only reach across it from inside a function body (route()'s minimisation
 * step; minimise()'s Class B condensation call), never at module-evaluation
 * time, so it resolves cleanly under ESM/Vite. The doc's own prose has the
 * identical shape (§4's route() calls minimise(); §7.2's minimise() calls
 * route()) — this is not a workaround, it is what the design describes.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import { scrubPII } from '@lib/utils/pii-scrubber';
import type { RouteRequest, RouteError } from '@lib/model/router-types';

export const CONDENSATION_SYSTEM_PROMPT =
  `You condense raw web page text into the minimum needed to serve the request that follows. ` +
  `Preserve facts, figures, and anything a instruction downstream explicitly needs. ` +
  `Remove navigation chrome, boilerplate, repeated content, and anything not relevant to the task. ` +
  `Output plain text only — no commentary about what you removed.`;

/** A Class A payload is always the planner's own three-segment template
 *  (§8.1) — GOAL / POLICY / OBSERVATION, with a JSON-serialised
 *  PerceptionSnapshot inside the OBSERVATION fence. It is never raw
 *  extracted page prose. Asserted rather than transformed (§7.2): if a
 *  caller ever constructs a Class A payload from something that isn't that
 *  template, that is a bug at the call site, not something to silently fix
 *  here. */
const PLANNER_TEMPLATE_MARKERS = ['### GOAL', '### POLICY', '### OBSERVATION'];

function asText(user: RouteRequest['user']): string {
  return typeof user === 'string' ? user : user.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

function containsRawPageText(user: RouteRequest['user']): boolean {
  const text = asText(user);
  return !PLANNER_TEMPLATE_MARKERS.every((marker) => text.includes(marker));
}

export async function minimise(req: RouteRequest): Promise<Result<RouteRequest, RouteError>> {
  if (req.disclosureClass === 'A') {
    if (containsRawPageText(req.user)) return Err('CLASS_A_CONTAINS_RAW_TEXT');
    return Ok(req);
  }

  // Class B: condense on the LOCAL judge tier first — lazy import breaks
  // the circular reference at the module-graph level while still calling
  // the real route().
  const { route } = await import('@lib/model/router');
  const condensed = await route({
    tier: 'judge', posture: req.posture,   // judge is local in BOTH postures
    system: CONDENSATION_SYSTEM_PROMPT,
    user: asText(req.user),
    maxTokens: 700, temperature: 0.1,
    runId: req.runId,
  });
  if (!condensed.ok) return Err('CONDENSATION_UNAVAILABLE');   // REFUSE. Never upgrade.

  const scrubbed = scrubPII(condensed.value.content);   // the FOURTH line (§7.3)
  return Ok({
    ...req, user: scrubbed.cleaned,
    meta: {
      condensed: true,
      originalTokens: Math.ceil(asText(req.user).length / 4),
      sentTokens: Math.ceil(scrubbed.cleaned.length / 4),
      scrubbed: scrubbed.detected,
    },
  });
}
