/**
 * Billed seconds = real call duration weighted by the call's seconds multiplier.
 *
 * A "realistic" (premium ElevenLabs) call snapshots a multiplier > 1 at start
 * because that voice costs us more to produce, so it must consume the included
 * pool / wallet faster than a standard call. The multiplier is read from the
 * conversation snapshot — never recomputed at end — so an in-flight call keeps
 * the price it was quoted even if the env default later changes.
 *
 * Pure on purpose: the lifecycle's atomic claim decides *who* bills; this only
 * decides *how much*, and it is unit-tested in isolation.
 */
export function computeBilledSeconds(
  durationSeconds: number,
  multiplier: number | null | undefined,
): number {
  const duration = Number.isFinite(durationSeconds)
    ? Math.max(0, Math.floor(durationSeconds))
    : 0;
  const weight =
    typeof multiplier === 'number' && multiplier > 0
      ? Math.floor(multiplier)
      : 1;
  return duration * weight;
}
