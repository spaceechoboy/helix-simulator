// 가격·견적 모형과 진입 견적. DESIGN §3, §5 가격·수수료, §14 R3/R6, §15.
// 현재 RPC quote는 현재일 검증 전용. 미래 일자에는 시나리오 가격·깊이로 매일 reserve를 재구성한다(AMM_DAILY_RESET).
import { WAD, BPS, wmul, wdiv, bpsOf, rescale } from './decimal.js';
import { STATUS, ROUTES, COST_BASIS, PRICE_MODELS, DECIMALS } from './schema.js';

/** 상수곱 AMM 출력. feeBps는 입력측 차감(UniswapV2 형식). 이 fee는 quote에 포함됨. */
export function ammOut(amountIn, rIn, rOut, feeBps) {
  if (amountIn <= 0n) return 0n;
  const inFee = amountIn * (BPS - BigInt(feeBps));
  return (inFee * rOut) / (rIn * BPS + inFee);
}
/** 원하는 출력에 필요한 입력(올림). 출력이 reserve 이상이면 null. */
export function ammIn(amountOut, rIn, rOut, feeBps) {
  if (amountOut <= 0n) return 0n;
  if (amountOut >= rOut) return null;
  return (rIn * amountOut * BPS) / ((rOut - amountOut) * (BPS - BigInt(feeBps))) + 1n;
}

/** 그날 첫 거래 전 시나리오 가격·깊이로 풀 재구성(외부 재균형 가정, §14 R3). */
export function makeDayPool({ priceDaiPerAilgns, depthDai }) {
  if (priceDaiPerAilgns == null || depthDai == null) return null;
  return { dai: depthDai, ailgns: wdiv(depthDai, priceDaiPerAilgns), rebuilt: true, assumption: '외부 시장이 시나리오 가격·깊이로 재균형' };
}

/**
 * 비용 항목. includedInQuote=true면 debited=false여야 이중 차감이 아니다.
 * @typedef {{kind:string,amount:bigint,unit:string,includedInQuote:boolean,debited:boolean,status:string}} CostItem
 */
const cost = (kind, amount, unit, includedInQuote, status = STATUS.ASSUMED) =>
  ({ kind, amount, unit, includedInQuote, debited: !includedInQuote, status });

/**
 * AiLGNS qty 매수에 필요한 DAI. 터빈 수수료·가스는 여기 포함하지 않는다(엔진에서 별도).
 * opts: {model, pool, priceDaiPerAilgns, poolFeeBps, feeIncludedInQuote}
 * 반환: {daiIn, pool(갱신된 일내 풀), costs, model, status}
 */
export function quoteBuyAilgns(qty, opts) {
  const feeBps = opts.poolFeeBps ?? 30; // 0.3%는 검증 전 가정(§5)
  if (opts.model === PRICE_MODELS.AMM_DAILY_RESET) {
    const p = opts.pool;
    const daiIn = ammIn(qty, p.dai, p.ailgns, feeBps);
    if (daiIn === null) return { daiIn: null, pool: p, costs: [], model: opts.model, status: 'INSUFFICIENT_LIQUIDITY' };
    const noFee = ammIn(qty, p.dai, p.ailgns, 0);
    return {
      daiIn, pool: { ...p, dai: p.dai + daiIn, ailgns: p.ailgns - qty, rebuilt: false },
      costs: [cost('poolFee', daiIn - noFee, 'DAI', true)], model: opts.model, status: STATUS.ASSUMED,
    };
  }
  const gross = wmul(qty, opts.priceDaiPerAilgns);
  const included = !!opts.feeIncludedInQuote;
  const fee = included ? 0n : bpsOf(gross, feeBps);
  return { daiIn: gross + fee, pool: null, costs: [cost('poolFee', included ? null : fee, 'DAI', included)], model: PRICE_MODELS.LINEAR, status: STATUS.ASSUMED };
}

/**
 * AiLGNS qty 매도. 순서: 토큰 전송 매도세(fee-on-transfer) → 풀 도착 수량 → quoteOut.
 * router quote가 세금을 반영하지 않을 수 있으므로 세금 단계를 분리한다(§5).
 */
export function quoteSellAilgns(qty, opts) {
  const taxBps = opts.sellTaxBps ?? 300;
  const tax = bpsOf(qty, taxBps);
  const arrive = qty - tax;
  const feeBps = opts.poolFeeBps ?? 30;
  const costs = [{ kind: 'sellTax', amount: tax, unit: 'AILGNS', includedInQuote: false, debited: true, status: opts.sellTaxStatus ?? STATUS.OBSERVED }];
  if (opts.model === PRICE_MODELS.AMM_DAILY_RESET) {
    const p = opts.pool;
    const daiOut = ammOut(arrive, p.ailgns, p.dai, feeBps);
    const noFee = ammOut(arrive, p.ailgns, p.dai, 0);
    costs.push(cost('poolFee', noFee - daiOut, 'DAI', true));
    return { daiOut, arrive, pool: { ...p, ailgns: p.ailgns + arrive, dai: p.dai - daiOut, rebuilt: false }, costs, model: opts.model, status: STATUS.ASSUMED };
  }
  const gross = wmul(arrive, opts.priceDaiPerAilgns);
  const included = !!opts.feeIncludedInQuote;
  const fee = included ? 0n : bpsOf(gross, feeBps);
  costs.push(cost('poolFee', included ? null : fee, 'DAI', included));
  return { daiOut: gross - fee, arrive, pool: null, costs, model: PRICE_MODELS.LINEAR, status: STATUS.ASSUMED };
}

/** 이중 차감 검사: quote에 포함된 비용을 다시 debit했는지. */
export function findDoubleDebits(costs) {
  return costs.filter((c) => c.includedInQuote && c.debited);
}

// ---- 진입 견적 ----
const val = (snap, key) => snap?.values?.[key] ?? null;
const big = (e) => (e && e.value !== null ? BigInt(e.value) : null);
const capObservation = (snap, key) => {
  const e = val(snap, key);
  return { value: e?.value ?? null, status: e?.status ?? STATUS.UNAVAILABLE, unit: e?.unit ?? null };
};

/** KRW → DAI. 반환 {grossDai, netDai, rateKrwPerDai, fxStatus}. 환율 없으면 오류. */
export function krwToDai(krw, fx) {
  if (!fx) throw new Error('환율 미입력: KRW 환산 불가');
  let rate;
  if (fx.mode === 'CROSS') rate = wmul(fx.daiUsd, fx.usdKrw);
  else rate = fx.daiKrw;
  if (rate === null || rate <= 0n) throw new Error('환율 미입력/0: KRW 환산 불가');
  const grossDai = wdiv(krw, rate);
  const afterFee = krw - (fx.withdrawFeeKrw ?? 0n);
  const netDai = wdiv(afterFee - bpsOf(afterFee, fx.spreadBps ?? 0), rate);
  return { grossDai, netDai, rateKrwPerDai: rate, fxMode: fx.mode, fxStatus: fx.mode === 'MANUAL' ? STATUS.ASSUMED : STATUS.OBSERVED, fixedRateAssumption: fx.fixedRateAssumption };
}

/**
 * @returns EntryQuote {
 *   asset, chain, route, routeStatus,
 *   economicCostDai: 원금(ROI 분모의 진입분; null=미확정), costBasis,
 *   marketValueDai, netSaleDai, entryDai: HELIX에 들어갈 DAI(DAI 경로),
 *   powerPreview: 확정 Power(null=확정 불가), assumedPowerPreview, powerStatus,
 *   lgnsToBurnAnubis(9자리), fixed: {acquisitionCostDai, principalRecognizedDai, status} | null,
 *   reserveDai, initialCapitalDai, fx, warnings[], issues[] }
 */
export function getEntryQuote(scenario, snapshot) {
  const s = scenario, warnings = [], issues = [];
  const powerRate = big(val(snapshot, 'daiPowerRateBps'));
  const q = { asset: s.asset, chain: s.chain, route: s.route, routeStatus: STATUS.OBSERVED, costBasis: s.asset === 'LGNS' ? s.costBasis : null,
    economicCostDai: null, marketValueDai: null, netSaleDai: null, entryDai: null,
    powerPreview: null, assumedPowerPreview: null, powerStatus: STATUS.UNAVAILABLE,
    lgnsToBurnAnubis: null, fixed: null, reserveDai: s.reserveDai, initialCapitalDai: null, fx: null,
    burnCaps: { lgns: capObservation(snapshot, 'dailyBurnPowerCap'), ailgns: capObservation(snapshot, 'dailyAilgnsBurnPowerCap'),
      ignoredForCalculation: !!s.engine.ignoreBurnCaps }, warnings, issues };

  const daiToPower = (dai) => {
    if (powerRate === null) { issues.push('DAI→Power 비율 미조회'); return; }
    q.entryDai = dai; q.powerPreview = (dai * powerRate) / BPS; q.powerStatus = val(snapshot, 'daiPowerRateBps').status;
    warnings.push('일일 DAI Power 한도는 전체 한도이며 개인 배정 규칙 미확정 → 첫 활성일은 시나리오 지연 사용');
  };

  if (s.asset === 'DAI') { q.economicCostDai = s.amount; daiToPower(s.amount); }
  else if (s.asset === 'KRW') {
    q.fx = krwToDai(s.amount, s.fx);
    q.economicCostDai = q.fx.grossDai; q.economicCostKrw = s.amount;
    daiToPower(q.fx.netDai);
  } else {
    const lgns18 = rescale(s.amount, DECIMALS.LGNS, 18);
    if (s.lgnsPriceDai !== null) {
      q.marketValueDai = wmul(lgns18, s.lgnsPriceDai);
    } else issues.push('LGNS 가격 미입력: 시장 평가액 null');
    // 순매도액 ≠ 시장 평가액. 명시 견적 > 수동 가정(세금·풀·가스 적용) > null.
    if (s.lgnsNetSaleDai !== null) { q.netSaleDai = s.lgnsNetSaleDai; q.netSaleSource = 'USER_QUOTE'; }
    else if (s.lgnsSaleAssumption && q.marketValueDai !== null) {
      const a = s.lgnsSaleAssumption;
      const v = bpsOf(bpsOf(q.marketValueDai, 10000 - a.taxBps), 10000 - a.poolFeeBps) - a.gasDai;
      q.netSaleDai = v > 0n ? v : 0n; q.netSaleSource = STATUS.ASSUMED;
      warnings.push('LGNS 순매도액은 수동 가정(세금·풀·가스) — 실행 견적 아님');
    } else q.netSaleSource = null;
    if (s.costBasis === COST_BASIS.FIXED_ONE_DAI) {
      q.economicCostDai = lgns18; q.economicCostSource = 'FIXED_ONE_DAI/ASSUMED';
      warnings.push('LGNS 원금은 1 LGNS = 1 DAI 고정 비교 기준 — 실제 매입원가·시장가격·현금 보장 아님');
    } else if (s.costBasis === COST_BASIS.ACQUISITION) {
      q.economicCostDai = s.acquisitionCostDai; q.economicCostSource = 'ACQUISITION';
    } else if (q.netSaleDai !== null) {
      q.economicCostDai = q.netSaleDai; q.economicCostSource = 'NET_SALE';
    } else if (s.route === ROUTES.ANUBIS_LGNS_BURN && q.marketValueDai !== null) {
      // 직접 소각은 실행 매도견적이 없어도 현재 시가를 기회비용으로 쓴다. 순매도액으로 둔갑시키지 않는다.
      q.economicCostDai = q.marketValueDai; q.economicCostSource = 'MARKET_VALUE/ASSUMED';
      warnings.push('LGNS 직접 소각 경제원가는 현재 시장평가액(매도세·풀 수수료 전, 매도 견적 아님)');
    } else {
      q.economicCostDai = null; q.economicCostSource = null;
      issues.push('LGNS 순매도 견적 없음: 순매도액 null(시장가로 대체하지 않음)');
    }
    if (q.economicCostDai === null) issues.push('LGNS 원가 미확정: ROI 분모 N/A');

    if (s.route === ROUTES.ANUBIS_LGNS_SELL_DAI || s.route === ROUTES.POLYGON_LGNS_SELL_DAI) {
      if (s.route === ROUTES.POLYGON_LGNS_SELL_DAI) { q.routeStatus = STATUS.ASSUMED; warnings.push('Polygon 매도→DAI 브리지 비용·지연 미검증(보조 비교)'); }
      if (q.netSaleDai !== null) daiToPower(q.netSaleDai);
      else q.routeStatus = 'PENDING_VERIFICATION';
      if (q.netSaleSource === STATUS.ASSUMED) q.routeStatus = STATUS.ASSUMED;
    } else if (s.route === ROUTES.ANUBIS_LGNS_BURN) {
      q.lgnsToBurnAnubis = s.amount;
      const cap = val(snapshot, 'dailyBurnPowerCap');
      const rate = big(val(snapshot, 'lgnsPowerRate'));
      if (rate !== null) { q.assumedPowerPreview = wmul(lgns18, rate); }
      warnings.push('lgnsPowerRate getter 의미·시세>1 규칙 미검증 → Power 미리보기는 ASSUMED');
      if (s.engine.ignoreBurnCaps) {
        q.routeStatus = STATUS.ASSUMED; q.powerStatus = STATUS.ASSUMED;
        warnings.push('현재 LGNS 소각 한도는 상태로만 표시하고 계산에서는 제외(미래 가정, 실거래 가능 확인 아님)');
      } else if (cap && cap.value === '0') { q.routeStatus = 'BLOCKED_CAP0'; q.powerStatus = 'PENDING'; issues.push('LGNS 소각 일일 한도 0: 활성 Power 0/대기, 재개 자동 가정 금지'); }
      else if (!cap || cap.value === null) { q.routeStatus = STATUS.UNAVAILABLE; issues.push('LGNS 소각 한도 미조회'); }
      else q.powerStatus = STATUS.ASSUMED;
    } else if (s.route === ROUTES.POLYGON_FIXED) {
      // FIXED 인정액은 원금이 아니다(§15). 원가와 별개 필드.
      const f = s.fixed;
      q.routeStatus = 'PENDING_VERIFICATION';
      q.fixed = {
        polygonLgnsBurned: s.amount,
        acquisitionCostDai: q.economicCostDai,
        principalRecognizedDai: f.recognizedDaiPerLgns === null ? null : wmul(lgns18, f.recognizedDaiPerLgns),
        totalPayoutCapBps: f.totalPayoutCapBps, payoutBpsPerPeriod: f.payoutBpsPerPeriod, periodSeconds: f.periodSeconds,
        capRateWad: f.capRateWad, payoutRateWad: f.payoutRateWad,
        payoutPriceDai: f.payoutPriceDai, payoutPriceSource: f.payoutPriceSource, stopDate: f.stopDate, status: f.status,
      };
      if (q.fixed.principalRecognizedDai === null) issues.push('FIXED 인정 비율 미입력: 지급 계산 검증대기');
      for (const k of ['totalPayoutCapBps', 'payoutBpsPerPeriod', 'periodSeconds', 'payoutPriceDai']) if (f[k] === null) issues.push(`FIXED ${k} 미입력: 검증대기`);
      warnings.push('FIXED 개방·지급·HELIX 소각 편입은 오늘 미검증 → 가정 시나리오/검증 대기');
      const cap = val(snapshot, 'dailyBurnPowerCap');
      if (s.engine.ignoreBurnCaps) warnings.push('현재 Anubis LGNS 소각 한도는 상태로만 표시하고 계산에서는 제외(미래 가정)');
      else if (cap && cap.value === '0') issues.push('Anubis LGNS HELIX 소각 한도 0: 지급분 소각은 대기');
    }
  }
  q.initialCapitalDai = q.economicCostDai === null ? null : q.economicCostDai + (s.reserveDai ?? 0n);
  if (s.totalBudgetDai !== null && q.initialCapitalDai !== null && q.initialCapitalDai > s.totalBudgetDai)
    issues.push('진입액+운전자금이 총 초기예산 초과');
  return q;
}

export const ONE = WAD;
