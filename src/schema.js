// 입력·증거 계약. DESIGN §3, §9, §14 R4, §15.
import { parseUnits } from './decimal.js';
import { isValidDate } from './dates.js';

export const STATUS = Object.freeze({
  LIVE_VERIFIED: 'LIVE_VERIFIED', OBSERVED: 'OBSERVED', ASSUMED: 'ASSUMED',
  STALE: 'STALE', UNAVAILABLE: 'UNAVAILABLE', CONFLICT: 'CONFLICT',
});

// 토큰 자리수(§3). LGNS 9, 나머지 18.
export const DECIMALS = Object.freeze({ LGNS: 9, DAI: 18, AILGNS: 18, POWER: 18, KRW: 18 });

export const ASSETS = ['DAI', 'KRW', 'LGNS'];
export const CHAINS = Object.freeze({ ANUBIS: 'anubis', POLYGON: 'polygon' });

// 진입 경로. Polygon 기본 = FIXED(§15). LGNS→DAI 매도는 명시 선택 보조 비교.
export const ROUTES = Object.freeze({
  DAI_DIRECT: 'DAI_DIRECT',                 // Anubis DAI → HELIX Power
  ANUBIS_LGNS_BURN: 'ANUBIS_LGNS_BURN',     // Anubis LGNS → HELIX 직접 소각
  ANUBIS_LGNS_SELL_DAI: 'ANUBIS_LGNS_SELL_DAI',
  POLYGON_FIXED: 'POLYGON_FIXED',           // Polygon LGNS → FIXED 소각 → Anubis LGNS 지급 → HELIX 소각
  POLYGON_LGNS_SELL_DAI: 'POLYGON_LGNS_SELL_DAI',
});

export const COST_BASIS = Object.freeze({ FIXED_ONE_DAI: 'FIXED_ONE_DAI', OPPORTUNITY: 'OPPORTUNITY', ACQUISITION: 'ACQUISITION' });
export const FUNDING = Object.freeze({ SELF: 'SELF', EXTERNAL: 'EXTERNAL' });
export const FX_MODES = Object.freeze({ DIRECT: 'DIRECT', CROSS: 'CROSS', MANUAL: 'MANUAL' });
export const PERIOD_MODES = Object.freeze({ CALENDAR: 'CALENDAR', FIXED_DAYS: 'FIXED_DAYS' });
export const PRICE_MODELS = Object.freeze({ AMM_DAILY_RESET: 'AMM_DAILY_RESET', LINEAR: 'LINEAR' });

/**
 * EvidenceValue (§9). value는 문자열 원값 또는 null. null은 0이 아니다.
 * @returns {{value:(string|null),unit:string,chainId:(number|null),contract:(string|null),method:(string|null),
 *   blockNumber:(number|null),blockTimestamp:(number|null),fetchedAt:(string|null),sourceUrl:(string|null),
 *   status:string,confidence:string,notes:string}}
 */
export function ev(value, unit, o = {}) {
  if (o.status && !STATUS[o.status]) throw new TypeError(`알 수 없는 status ${o.status}`);
  return {
    value: value === null || value === undefined ? null : String(value),
    unit,
    chainId: o.chainId ?? null, contract: o.contract ?? null, method: o.method ?? null,
    blockNumber: o.blockNumber ?? null, blockTimestamp: o.blockTimestamp ?? null,
    fetchedAt: o.fetchedAt ?? null, sourceUrl: o.sourceUrl ?? null,
    status: o.status ?? (value === null || value === undefined ? STATUS.UNAVAILABLE : STATUS.ASSUMED),
    confidence: o.confidence ?? 'low', notes: o.notes ?? '',
  };
}

export const isNullish = (x) => x === null || x === undefined || x === '';

function req(cond, msg, errors) { if (!cond) errors.push(msg); }
function dec(x, d, name, errors) {
  if (isNullish(x)) return null;
  let v;
  try { v = parseUnits(x, d); } catch { errors.push(`${name}: 숫자 아님`); return null; }
  if (v < 0n) { errors.push(`${name}: 음수 불가`); return null; }
  return v;
}
/** 소수 bps → WAD 분수(1.0=1e18). 18자리 초과 정밀도는 반올림 대신 거부. max=null이면 상한 없음. */
function bpsToRateWad(x, name, errors, maxBps) {
  if (isNullish(x)) return null;
  let v;
  try { v = parseUnits(String(x), 18); } catch { errors.push(`${name}: 숫자 아님`); return null; }
  if (v < 0n) { errors.push(`${name}: 음수 불가`); return null; }
  if (maxBps !== null && v > maxBps * 10n ** 18n) { errors.push(`${name}: ${maxBps} bps 초과`); return null; }
  if (/\.\d{19,}/.test(String(x)) || v % 10000n !== 0n) { errors.push(`${name}: 정밀도 초과(반올림 금지)`); return null; }
  return v / 10000n;
}
function bps(x, name, errors, dflt = null) {
  if (isNullish(x)) return dflt;
  const n = Number(x);
  if (!Number.isInteger(n) || n < 0 || n > 10000) { errors.push(`${name}: 0~10000 bps 정수`); return dflt; }
  return n;
}

/**
 * 엔진 옵션(Task2 이후 UI/optimizer가 사용). null = 스냅샷 값 사용. 기본값은 모두 ASSUMED.
 * 가스 단위비용은 DAI 환산 추정값(ASSUMED). 네이티브 가스 잔액은 체인별 별도 장부.
 */
export function normalizeEngineOptions(raw = {}, errors = []) {
  const g = raw.gas ?? {}, u = g.unitDai ?? {};
  const unit = (k, d) => dec(u[k] ?? d, 18, `gas.unitDai.${k}`, errors);
  return {
    annualRateBps: isNullish(raw.annualRateBps) ? null : Number(raw.annualRateBps), // 10200 등 >10000 가능
    priceDaiPerAilgns: dec(raw.priceDaiPerAilgns, 18, 'priceDaiPerAilgns', errors),
    priceSchedule: (raw.priceSchedule ?? []).map((p, i) => ({ fromDay: Number(p.fromDay), price: dec(p.price, 18, `priceSchedule[${i}]`, errors) })),
    poolDepthDai: dec(raw.poolDepthDai, 18, 'poolDepthDai', errors),
    poolFeeBps: bps(raw.poolFeeBps, 'poolFeeBps', errors, 30),
    feeIncludedInQuote: !!raw.feeIncludedInQuote,
    turbineFeeBps: bps(raw.turbineFeeBps, 'turbineFeeBps', errors, null),
    sellTaxBps: bps(raw.sellTaxBps, 'sellTaxBps', errors, null),
    ailgnsBurnPowerBps: isNullish(raw.ailgnsBurnPowerBps) ? null : Number(raw.ailgnsBurnPowerBps),
    outputMultipleBps: isNullish(raw.outputMultipleBps) ? 20000 : Number(raw.outputMultipleBps),
    immediateBps: bps(raw.immediateBps, 'immediateBps', errors, 5000), // 승인 설계: 2Q 중 Q 즉시·Q 24h 잠금(ASSUMED)
    feeSchedule: (raw.feeSchedule ?? []).map((f, i) => ({ fromDay: Number(f.fromDay),
      turbineFeeBps: bps(f.turbineFeeBps, `feeSchedule[${i}].turbineFeeBps`, errors, null),
      sellTaxBps: bps(f.sellTaxBps, `feeSchedule[${i}].sellTaxBps`, errors, null),
      poolFeeBps: bps(f.poolFeeBps, `feeSchedule[${i}].poolFeeBps`, errors, null) })),
    lockSeconds: isNullish(raw.lockSeconds) ? null : Number(raw.lockSeconds),
    entryLagDays: Number(raw.entryLagDays ?? 1),
    reburnLagDays: Number(raw.reburnLagDays ?? 1),
    executionOffsetSeconds: Number(raw.executionOffsetSeconds ?? 600),
    // 계산 전용 가정. 현재 관측 cap 값은 snapshot/quote에 그대로 두고 LGNS·AiLGNS 소각 gate만 우회한다.
    ignoreBurnCaps: !!raw.ignoreBurnCaps,
    lgnsBurnOpenFromDay: isNullish(raw.lgnsBurnOpenFromDay) ? null : Number(raw.lgnsBurnOpenFromDay),
    lgnsPowerPerLgns: dec(raw.lgnsPowerPerLgns, 18, 'lgnsPowerPerLgns', errors),
    ailgnsBurnOpen: isNullish(raw.ailgnsBurnOpen) ? null : !!raw.ailgnsBurnOpen,
    allowPartialActivation: !!raw.allowPartialActivation,
    returnCashAtEnd: raw.returnCashAtEnd ?? true,
    initialAilgns: dec(raw.initialAilgns, 18, 'initialAilgns', errors),
    initialAilgnsCostDai: dec(raw.initialAilgnsCostDai, 18, 'initialAilgnsCostDai', errors),
    gas: {
      anubisNativeDai: dec(g.anubisNativeDai ?? '1', 18, 'gas.anubisNativeDai', errors),
      polygonNativeDai: dec(g.polygonNativeDai ?? '0.5', 18, 'gas.polygonNativeDai', errors),
      autoRefillFromCash: !!g.autoRefillFromCash,
      unitDai: { approve: unit('approve', '0.005'), claim: unit('claim', '0.01'), activate: unit('activate', '0.02'),
        sale: unit('sale', '0.02'), deposit: unit('deposit', '0.02'), transfer: unit('transfer', '0.005'), burn: unit('burn', '0.02'), fixedBurn: unit('fixedBurn', '0.05'), fixedClaim: unit('fixedClaim', '0.01') },
    },
  };
}

/**
 * 사용자 원입력 → Scenario. 오류가 있으면 InputError를 던진다(임의 기본값으로 메우지 않음).
 * 금액은 BigInt(18자리; LGNS는 9자리) 로 보존.
 */
export function normalizeInput(raw = {}) {
  const errors = [];
  const asset = raw.asset ?? 'DAI';
  req(ASSETS.includes(asset), `asset는 ${ASSETS.join('/')} 중 하나`, errors);
  const amountDec = asset === 'LGNS' ? DECIMALS.LGNS : DECIMALS.DAI;
  const amount = dec(raw.amount ?? (asset === 'DAI' ? '1000' : null), amountDec, 'amount', errors);
  req(amount !== null && amount > 0n, 'amount는 양수 필수', errors);

  const startDate = raw.startDate ?? null;
  req(isValidDate(startDate), 'startDate(YYYY-MM-DD, KST, 실제 달력 날짜) 필수', errors);

  // LGNS: 체인 필수, 경로 기본값은 체인별(§15).
  let chain = null, route;
  if (asset === 'LGNS') {
    chain = raw.lgnsChain ?? null;
    req(chain === CHAINS.ANUBIS || chain === CHAINS.POLYGON, 'LGNS는 체인(anubis/polygon) 선택 필수', errors);
    const allowed = chain === CHAINS.POLYGON
      ? [ROUTES.POLYGON_FIXED, ROUTES.POLYGON_LGNS_SELL_DAI]
      : [ROUTES.ANUBIS_LGNS_BURN, ROUTES.ANUBIS_LGNS_SELL_DAI];
    route = raw.route ?? allowed[0];
    req(allowed.includes(route), `${chain} LGNS 경로는 ${allowed.join('/')} 중 하나`, errors);
  } else {
    route = ROUTES.DAI_DIRECT;
  }

  // 원가 기준(LGNS). 기본 = 시작시점 순매도가능 DAI(기회비용). 매입원가 미입력 시 추정 금지.
  const costBasis = raw.costBasis ?? COST_BASIS.OPPORTUNITY;
  req(COST_BASIS[costBasis], 'costBasis 오류', errors);
  const acquisitionCostDai = dec(raw.acquisitionCostDai, 18, 'acquisitionCostDai', errors);
  if (asset === 'LGNS' && costBasis === COST_BASIS.ACQUISITION) req(acquisitionCostDai !== null, '매입원가 기준이면 acquisitionCostDai 필수', errors);
  // LGNS 시장 가격·순매도 견적은 사용자/스냅샷에서 와야 한다. 없으면 null 유지.
  const lgnsPriceDai = dec(raw.lgnsPriceDai, 18, 'lgnsPriceDai', errors);
  // 순매도액: 명시 견적(lgnsNetSaleDai) 또는 수동 가정(lgnsSaleAssumption). 둘 다 없으면 null(시장가로 대체 금지).
  const lgnsNetSaleDai = dec(raw.lgnsNetSaleDai, 18, 'lgnsNetSaleDai', errors);
  const sa = raw.lgnsSaleAssumption;
  const lgnsSaleAssumption = sa ? {
    taxBps: bps(sa.taxBps, 'lgnsSaleAssumption.taxBps', errors, null),
    poolFeeBps: bps(sa.poolFeeBps, 'lgnsSaleAssumption.poolFeeBps', errors, null),
    gasDai: dec(sa.gasDai, 18, 'lgnsSaleAssumption.gasDai', errors),
  } : null;
  if (lgnsSaleAssumption && Object.values(lgnsSaleAssumption).some((v) => v === null)) errors.push('lgnsSaleAssumption은 taxBps·poolFeeBps·gasDai 모두 필수');

  // FIXED 파라미터(§15). 과거 1개=1DAI·200%·하루2회는 기본값으로 넣지 않는다 → null=검증대기.
  const fx0 = raw.fixed ?? {};
  const fixed = route === ROUTES.POLYGON_FIXED ? {
    recognizedDaiPerLgns: dec(fx0.recognizedDaiPerLgns, 18, 'fixed.recognizedDaiPerLgns', errors),
    // 소수 bps(예: 33.34 = 0.3334%) 허용. 비율은 WAD 분수(rateWad)로 반올림 없이 보존.
    totalPayoutCapBps: isNullish(fx0.totalPayoutCapBps) ? null : String(fx0.totalPayoutCapBps), // 원금 대비 총지급 상한(>10000 가능)
    capRateWad: bpsToRateWad(fx0.totalPayoutCapBps, 'fixed.totalPayoutCapBps', errors, null),
    payoutBpsPerPeriod: isNullish(fx0.payoutBpsPerPeriod) ? null : String(fx0.payoutBpsPerPeriod),
    payoutRateWad: bpsToRateWad(fx0.payoutBpsPerPeriod, 'fixed.payoutBpsPerPeriod', errors, 10000n),
    periodSeconds: isNullish(fx0.periodSeconds) ? null : Number(fx0.periodSeconds),
    payoutPriceSchedule: (fx0.payoutPriceSchedule ?? []).map((p, i) => ({ fromDay: Number(p.fromDay), price: dec(p.price, 18, `fixed.payoutPriceSchedule[${i}]`, errors) })),
    payoutPriceDai: dec(fx0.payoutPriceDai, 18, 'fixed.payoutPriceDai', errors),
    payoutPriceSource: fx0.payoutPriceSource ?? null,
    stopDate: fx0.stopDate ?? null,
    status: fx0.status && STATUS[fx0.status] ? fx0.status : 'ASSUMED',
  } : null;

  // 원화: 환율 미입력은 오류(임의 환율 금지, 1 DAI=1 USD 자동 고정 금지).
  let fx = null;
  if (asset === 'KRW' || raw.fx) {
    const f = raw.fx ?? {};
    const mode = f.mode ?? null;
    req(FX_MODES[mode], 'KRW 시작은 환율 모드(DIRECT/CROSS/MANUAL) 필수', errors);
    fx = {
      mode,
      daiKrw: dec(f.daiKrw, 18, 'fx.daiKrw', errors),
      daiUsd: dec(f.daiUsd, 18, 'fx.daiUsd', errors),
      usdKrw: dec(f.usdKrw, 18, 'fx.usdKrw', errors),
      spreadBps: bps(f.spreadBps, 'fx.spreadBps', errors, 0),
      withdrawFeeKrw: dec(f.withdrawFeeKrw ?? '0', 18, 'fx.withdrawFeeKrw', errors),
      source: f.source ?? null, fetchedAt: f.fetchedAt ?? null,
      fixedRateAssumption: f.fixedRateAssumption ?? true,
    };
    if (mode === 'CROSS') req(fx.daiUsd !== null && fx.usdKrw !== null, 'CROSS 환율은 daiUsd·usdKrw 필수', errors);
    if (mode === 'DIRECT' || mode === 'MANUAL') req(fx.daiKrw !== null, `${mode} 환율은 daiKrw 필수`, errors);
  }

  // 자금 방식·예산(§4, §14 R4).
  const funding = raw.funding ?? FUNDING.SELF;
  req(FUNDING[funding], 'funding은 SELF/EXTERNAL', errors);
  const reserveDai = dec(raw.reserveDai ?? '0', 18, 'reserveDai', errors);
  const totalBudgetDai = dec(raw.totalBudgetDai, 18, 'totalBudgetDai', errors);
  const ext = raw.externalBudget ?? {};
  const externalBudget = funding === FUNDING.EXTERNAL ? {
    dailyDai: dec(ext.dailyDai, 18, 'externalBudget.dailyDai', errors),
    totalDai: dec(ext.totalDai, 18, 'externalBudget.totalDai', errors),
  } : null;
  if (externalBudget) req(externalBudget.dailyDai !== null && externalBudget.totalDai !== null, '외부 DAI 방식은 일일·누적 추가투입 한도 필수', errors);

  const horizonYears = Number(raw.horizonYears ?? 1);
  req([0.5, 1, 2, 3].includes(horizonYears), 'horizonYears는 0.5/1/2/3', errors);
  const periodMode = raw.periodMode ?? PERIOD_MODES.CALENDAR;
  req(PERIOD_MODES[periodMode], 'periodMode 오류', errors);
  const priceModel = raw.priceModel ?? PRICE_MODELS.LINEAR;
  req(PRICE_MODELS[priceModel], 'priceModel 오류', errors);

  if (fixed?.stopDate && !isValidDate(fixed.stopDate)) errors.push('fixed.stopDate 날짜 오류');
  if (fixed?.periodSeconds !== null && fixed?.periodSeconds !== undefined && !(fixed.periodSeconds > 0)) errors.push('fixed.periodSeconds 양수');
  const engine = normalizeEngineOptions(raw.engine ?? {}, errors);
  for (const key of ['entryLagDays', 'reburnLagDays']) if (!Number.isSafeInteger(engine[key]) || engine[key] < 0) errors.push(`${key}: 0 이상 정수 필수`);
  if (engine.reburnLagDays < 1) errors.push('재소각 편입 지연은 1일 이상이어야 합니다(정산 후 소각).');
  if (route === ROUTES.ANUBIS_LGNS_BURN && engine.entryLagDays < 1) errors.push('LGNS 소각 진입 편입 지연은 1일 이상이어야 합니다(정산 후 소각).');

  if (errors.length) { const e = new Error('입력 오류: ' + errors.join('; ')); e.name = 'InputError'; e.errors = errors; throw e; }

  return {
    schemaVersion: 'helix-sim-input/1',
    asset, amount, amountDecimals: amountDec, startDate, chain, route,
    costBasis, acquisitionCostDai, lgnsPriceDai, lgnsNetSaleDai, lgnsSaleAssumption, fixed, fx,
    funding, reserveDai, totalBudgetDai, externalBudget,
    horizonYears, periodMode, priceModel, engine,
    pool: raw.pool ?? null, // {priceDaiPerAilgns, depthDai, poolFeeBps, feeIncludedInQuote} — 미입력 시 quotes에서 ASSUMED 처리
  };
}
