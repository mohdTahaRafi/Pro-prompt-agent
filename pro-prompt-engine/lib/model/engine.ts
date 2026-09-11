/**
 * Engine — the interface every entry in lib/model/router.ts's CHAINS table
 * implements. Docs/planning/phase_4_model_tiers_routing.md §4, §4.1.
 */
import type { Result } from '@lib/utils/result';
import type { RouteRequest, RouteResponse, RouteError } from '@lib/model/router-types';

export interface Engine {
  /** journaled as `inference.fallback`'s `from`/`to` and as RouteResponse.engine */
  id: string;
  /** router.ts's boundary check (§4) reads this — never a runtime probe. A
   *  `local-only` chain containing an engine with isRemote:true is a build
   *  error, not a routing decision. */
  isRemote: boolean;
  infer(req: RouteRequest): Promise<Result<RouteResponse, RouteError>>;
}
