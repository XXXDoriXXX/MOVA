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
  // Voice-tier weight may be fractional (eco 1, realistic 1.5, ultra 2). Keep it
  // as-is and round the PRODUCT to whole billed seconds — flooring the weight
  // would silently drop the 1.5× tier down to 1×.
  const weight =
    typeof multiplier === 'number' && multiplier > 0 ? multiplier : 1;
  return Math.round(duration * weight);
}
