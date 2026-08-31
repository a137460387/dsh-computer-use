/**
 * Vision call cost-tier routing: every vision call has a purpose, each
 * purpose maps to a tier by configuration, and each tier resolves to one of
 * the two deployment routes — `flash` rides the change-detection route and
 * `pro` rides the primary vision route. The shipped defaults reproduce the
 * pre-routing fixed assignment exactly (analysis on the vision route,
 * change detection and verification on the flash route), so adopting the
 * router changes no call's route or cost by itself.
 * @module dsh-computer-use/vision/router
 */

import type { ComputerUseConfig } from '../config.ts'

/** Cost class of one vision model call; each tier resolves to one deployment route. */
export type VisionTier = 'flash' | 'pro'

/** Why one vision call happens; the routing key the deployment configures per purpose. */
export type VisionPurpose = 'analysis' | 'change-detection' | 'verification'

/** One resolved vision route: provider + model exactly as `ctx.llm` consumes them. */
export interface VisionRoute {
  readonly provider: string
  readonly model: string
}

/** The routing answer for one call: the decided tier and the route it resolves to. */
export interface VisionRoutingDecision {
  readonly purpose: VisionPurpose
  readonly tier: VisionTier
  readonly route: VisionRoute
  /** True when an explicit tier argument bypassed the configured mapping. */
  readonly overridden: boolean
}

/** The config fields routing reads; the rest of the policy is irrelevant here. */
type RoutingConfig = Pick<
  ComputerUseConfig,
  | 'analysisTier'
  | 'changeDetectionTier'
  | 'verificationTier'
  | 'visionProvider'
  | 'visionModel'
  | 'changeDetectionProvider'
  | 'changeDetectionModel'
>

/** The tier field each purpose reads; exhaustive over the closed purpose union. */
const TIER_FIELD: Record<VisionPurpose, 'analysisTier' | 'changeDetectionTier' | 'verificationTier'> = {
  'analysis': 'analysisTier',
  'change-detection': 'changeDetectionTier',
  'verification': 'verificationTier',
}

/** The route fields each tier reads; exhaustive over the closed tier union. */
const ROUTE_FIELDS: Record<VisionTier, {
  provider: 'visionProvider' | 'changeDetectionProvider'
  model: 'visionModel' | 'changeDetectionModel'
}> = {
  flash: { provider: 'changeDetectionProvider', model: 'changeDetectionModel' },
  pro: { provider: 'visionProvider', model: 'visionModel' },
}

/**
 * Routes vision calls by purpose. Stateless: every decision reads the config
 * fields again, so routes resolve per call exactly as the provider always did.
 */
export class VisionRouter {
  /**
   * @param config - policy carrying the three tier fields and both routes.
   */
  constructor(private readonly config: RoutingConfig) {}

  /**
   * Decide the tier and route for one call purpose.
   * @param purpose - why the call happens.
   * @param explicitTier - manual override for tests and diagnostics; bypasses the configured mapping.
   * @returns the decision with the resolved route and the override flag.
   */
  decide(purpose: VisionPurpose, explicitTier?: VisionTier): VisionRoutingDecision {
    const tier = explicitTier ?? this.tierFor(purpose)
    return { purpose, tier, route: this.routeFor(tier), overridden: explicitTier !== undefined }
  }

  /** The tier the deployment configured for one purpose. */
  private tierFor(purpose: VisionPurpose): VisionTier {
    return this.config[TIER_FIELD[purpose]]
  }

  /** The deployment route one tier rides. */
  private routeFor(tier: VisionTier): VisionRoute {
    const fields = ROUTE_FIELDS[tier]
    return { provider: this.config[fields.provider], model: this.config[fields.model] }
  }
}
