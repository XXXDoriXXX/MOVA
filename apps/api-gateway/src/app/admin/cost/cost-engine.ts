/**
 * Pure cost engine: usage × admin rates → a per-conversation cost breakdown in
 * UAH (with the USD view alongside). No DB, no I/O — unit-tested in isolation.
 *
 * Every rate is normalised through its `rateUnit`, so changing a rate's unit in
 * the admin table changes the math here without a code edit. USD-denominated
 * provider costs convert to UAH via the `fx:usd_to_uah` rate.
 */
export interface RateInfo {
  rate: number;
  rateUnit: string;
  label: string;
}

export type RateMap = Map<string, RateInfo>;

export interface UsageInput {
  telephonySeconds: number;
  stt: { provider: string; seconds: number; estimated: boolean };
  tts: Array<{ provider: string; chars: number }>;
  llm: Array<{
    provider: string;
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
  }>;
}

export interface CostComponent {
  key: string;
  label: string;
  detail: string;
  uah: number;
  usd: number;
  estimated: boolean;
}

export interface CostBreakdown {
  components: CostComponent[];
  totalUah: number;
  totalUsd: number;
  fxUsdToUah: number;
  /** True if any component is an estimate (tokens/STT not yet measured). */
  anyEstimated: boolean;
}

const DEFAULT_FX = 41.5;

function quantityToCost(
  quantity: number,
  info: RateInfo,
  fx: number,
): { uah: number; usd: number } {
  if (!Number.isFinite(quantity) || quantity <= 0) return { uah: 0, usd: 0 };
  switch (info.rateUnit) {
    case 'usd_per_1m_tokens':
    case 'usd_per_1m_chars': {
      const usd = (quantity * info.rate) / 1_000_000;
      return { usd, uah: usd * fx };
    }
    case 'usd_per_minute': {
      const usd = (quantity * info.rate) / 60;
      return { usd, uah: usd * fx };
    }
    case 'uah_per_minute': {
      const uah = (quantity * info.rate) / 60;
      return { uah, usd: fx > 0 ? uah / fx : 0 };
    }
    default:
      return { uah: 0, usd: 0 };
  }
}

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export function computeConversationCost(
  usage: UsageInput,
  rates: RateMap,
): CostBreakdown {
  const fx = rates.get('fx:usd_to_uah')?.rate ?? DEFAULT_FX;
  const components: CostComponent[] = [];

  const tel = rates.get('telephony:second');
  if (tel) {
    const { uah, usd } = quantityToCost(usage.telephonySeconds, tel, fx);
    if (uah > 0)
      components.push({
        key: 'telephony',
        label: tel.label,
        detail: `${usage.telephonySeconds} с`,
        uah,
        usd,
        estimated: false,
      });
  }

  for (const t of usage.tts) {
    const info = rates.get(`tts:${t.provider}:char`);
    if (!info) continue;
    const { uah, usd } = quantityToCost(t.chars, info, fx);
    if (uah > 0)
      components.push({
        key: `tts:${t.provider}`,
        label: info.label,
        detail: `${t.chars} симв.`,
        uah,
        usd,
        estimated: false,
      });
  }

  for (const l of usage.llm) {
    const inInfo = rates.get(`llm:${l.provider}:input_token`);
    const outInfo = rates.get(`llm:${l.provider}:output_token`);
    if (!inInfo && !outInfo) continue;
    let uah = 0;
    let usd = 0;
    if (inInfo) {
      const c = quantityToCost(l.inputTokens, inInfo, fx);
      uah += c.uah;
      usd += c.usd;
    }
    if (outInfo) {
      const c = quantityToCost(l.outputTokens, outInfo, fx);
      uah += c.uah;
      usd += c.usd;
    }
    if (uah > 0)
      components.push({
        key: `llm:${l.provider}`,
        label: (inInfo ?? outInfo)?.label ?? `LLM ${l.provider}`,
        detail: `~${l.inputTokens}/${l.outputTokens} ток.`,
        uah,
        usd,
        estimated: l.estimated,
      });
  }

  const sttInfo = rates.get(`stt:${usage.stt.provider}:second`);
  if (sttInfo) {
    const { uah, usd } = quantityToCost(usage.stt.seconds, sttInfo, fx);
    if (uah > 0)
      components.push({
        key: 'stt',
        label: sttInfo.label,
        detail: `~${Math.round(usage.stt.seconds)} с`,
        uah,
        usd,
        estimated: usage.stt.estimated,
      });
  }

  const totalUah = round(
    components.reduce((s, c) => s + c.uah, 0),
    4,
  );
  const totalUsd = round(
    components.reduce((s, c) => s + c.usd, 0),
    6,
  );
  return {
    components: components.map((c) => ({
      ...c,
      uah: round(c.uah, 4),
      usd: round(c.usd, 6),
    })),
    totalUah,
    totalUsd,
    fxUsdToUah: fx,
    anyEstimated: components.some((c) => c.estimated),
  };
}
