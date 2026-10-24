// 사건별 현금·토큰 장부 엔진. DESIGN §5, §6, §14(R1~R6), §15.
// 단위: Power/DAI/AiLGNS = 18자리 BigInt, LGNS = 9자리 BigInt. 화면에서만 반올림.
import { WAD, BPS, wmul, wdiv, bpsOf, rescale } from './decimal.js';
import { ROUTES, FUNDING, PRICE_MODELS, STATUS } from './schema.js';
import { getEntryQuote, quoteBuyAilgns, quoteSellAilgns, makeDayPool, ammIn } from './quotes.js';
import { createFixedState, fixedAccrual } from './fixed.js';
import { firstBoundary, horizonDays, milestones, kstDate, kstMidnightUnix } from './dates.js';

const sv = (snap, k) => { const v = snap?.values?.[k]; return v && v.value !== null ? BigInt(v.value) : null; };
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** 회귀 전용 파라미터(§8 fixture). 실행 가능 표기 금지. */
export const REGRESSION = Object.freeze({ annualRateBps: 10200, turbineFeeBps: 250, sellTaxBps: 300, burnBps: 25000, price: WAD });

/** 스냅샷+시나리오 → 계산 파라미터. provenance에 출처/상태 기록. */
export function resolveParams(sc, snap, opts = {}) {
  const e = sc.engine, warn = [], prov = {};
  const pick = (name, user, snapKey, dflt, note) => {
    if (user !== null && user !== undefined) { prov[name] = 'USER/ASSUMED'; return user; }
    const s = snapKey ? sv(snap, snapKey) : null;
    if (s !== null) { prov[name] = `SNAPSHOT/${snap.values[snapKey].status}`; return s; }
    prov[name] = 'DEFAULT/ASSUMED'; if (note) warn.push(note); return dflt;
  };
  if (opts.regression) {
    return { regression: true, float: true, r: (BigInt(REGRESSION.annualRateBps) * WAD) / (BPS * 365n),
      priceAt: () => REGRESSION.price, model: PRICE_MODELS.LINEAR, depth: null, poolFeeBps: 0, feeIncluded: true,
      turbineFeeBps: REGRESSION.turbineFeeBps, sellTaxBps: REGRESSION.sellTaxBps, burnBps: REGRESSION.burnBps,
      outputMultipleBps: 20000, immediateBps: 10000, lockSeconds: 0, entryLagDays: 0, reburnLagDays: 1, execOffset: 0,
      genesis: 0, daySeconds: 86400, ailgnsBurnOpen: true, lgnsBurnOpen: () => false, lgnsPowerPerLgns: null,
      feeAt: () => ({}), gasUnit: null, autoRefill: false, allowPartial: false, depositsOpen: true, warn: ['회귀 fixture: 가스·풀·지연·운전자금 0 가정 — 실제 실행 불가'], prov: { all: 'REGRESSION/ASSUMED' } };
  }
  // 핵심값: 사용자 명시 override가 없으면 스냅샷 값이 존재하고 CONFLICT/UNAVAILABLE이 아니어야 한다. 기본값 대체 금지.
  const blocked = [];
  const crit = (name, user, snapKey) => {
    if (user !== null && user !== undefined) { prov[name] = 'USER/ASSUMED'; return BigInt(user); }
    const v = snap?.values?.[snapKey];
    const st = !v ? 'UNKNOWN' : v.value === null ? STATUS.UNAVAILABLE : v.status;
    if (st === 'UNKNOWN' || st === STATUS.UNAVAILABLE || st === STATUS.CONFLICT) { blocked.push(`${snapKey}:${st}`); return null; }
    prov[name] = `SNAPSHOT/${st}`; return BigInt(v.value);
  };
  const lgnsRoute = sc.route === ROUTES.ANUBIS_LGNS_BURN || sc.route === ROUTES.POLYGON_FIXED;
  const annual = crit('annualRateBps', e.annualRateBps, 'annualRateBps');
  const basePrice = crit('price', e.priceDaiPerAilgns, 'oracleTwapDaiPerAilgns');
  const turbineFee = crit('turbineFeeBps', e.turbineFeeBps, 'turbineFeeBps');
  const sellTax = crit('sellTaxBps', e.sellTaxBps, 'sellFeeBps');
  const burnBps = crit('ailgnsBurnPowerBps', e.ailgnsBurnPowerBps, 'ailgnsPowerRateBps');
  const lockS = crit('lockSeconds', e.lockSeconds, 'lockSeconds');
  const ailCap = e.ailgnsBurnOpen !== null || e.ignoreBurnCaps ? null : crit('dailyAilgnsBurnPowerCap', null, 'dailyAilgnsBurnPowerCap');
  if (e.ignoreBurnCaps) prov.dailyAilgnsBurnPowerCap = 'USER/ASSUMED_IGNORED';
  let depositsOpen = true, daiCap = null, lgnsCap = null, lgnsRate = null;
  if (!lgnsRoute) {
    crit('daiPowerRateBps', null, 'daiPowerRateBps');
    depositsOpen = crit('depositsOpen', null, 'depositsOpen') !== 0n;
    daiCap = crit('dailyDaiPowerCap', null, 'dailyDaiPowerCap');
  } else {
    lgnsCap = e.lgnsBurnOpenFromDay !== null || e.ignoreBurnCaps ? null : crit('dailyBurnPowerCap', null, 'dailyBurnPowerCap');
    if (e.ignoreBurnCaps) prov.dailyBurnPowerCap = 'USER/ASSUMED_IGNORED';
    lgnsRate = crit('lgnsPowerPerLgns', e.lgnsPowerPerLgns, 'lgnsPowerRate');
  }
  if (annual !== null && BigInt(annual) > 365n * BPS) blocked.push('annualRateBps:DAILY_RATE_OVER_100PCT'); // 일 소진 > 잔액
  if (blocked.length) { const err = new Error(`핵심 스냅샷 값 사용 불가(검증대기): ${blocked.join(', ')} — 명시 override 필요`); err.name = 'SnapshotBlocked'; err.keys = blocked; throw err; }
  warn.push('연 배출률은 unnamed getter 값(의미 미검증) — 개인 배출 상한·예산 구속 규칙 미검증');
  warn.push('미래 가격은 현재 조건 유지 가정(외생 시나리오), 정산가=시장가 가정');
  const sched = [...(e.priceSchedule ?? [])].sort((a, b) => a.fromDay - b.fromDay);
  const priceAt = (d) => { let p = basePrice; for (const s of sched) if (d >= s.fromDay) p = s.price; return p; };
  let model = sc.priceModel;
  if (model === PRICE_MODELS.AMM_DAILY_RESET && e.poolDepthDai === null) { model = PRICE_MODELS.LINEAR; warn.push('AMM 풀 깊이 미입력 → 선형 가정모드'); }
  const ailgnsBurnOpen = e.ailgnsBurnOpen ?? (e.ignoreBurnCaps || (ailCap !== null && ailCap > 0n));
  const daiEntryOpen = depositsOpen && (lgnsRoute || (daiCap !== null && daiCap > 0n));
  if (!lgnsRoute && daiCap === 0n) warn.push('DAI Power 일일 한도 0 — 진입 없음(임의 개방 금지)');
  const daySecondsSnap = sv(snap, 'daySeconds');
  if (daySecondsSnap === null || sv(snap, 'dayStart') === null) warn.push('프로토콜 일 경계 미조회 — 86400초/KST 자정 경계 ASSUMED');
  // 수수료 변경 일정(사용자 시나리오): [{fromDay, turbineFeeBps?, sellTaxBps?, poolFeeBps?}]
  const base = { turbineFeeBps: Number(turbineFee), sellTaxBps: Number(sellTax), poolFeeBps: e.poolFeeBps };
  const fsched = [...(e.feeSchedule ?? [])].sort((a, b) => a.fromDay - b.fromDay);
  const feeAt = (d) => { const f = { ...base }; for (const s of fsched) if (d >= s.fromDay) for (const k of Object.keys(base)) if (s[k] !== null && s[k] !== undefined) f[k] = s[k]; return f; };
  if (fsched.length) warn.push('수수료 변경 일정은 사용자 시나리오(ASSUMED)');
  if (e.ignoreBurnCaps) warn.push('LGNS·AiLGNS 소각 한도는 계산에서 제외한 미래 ASSUMED 시나리오 — 현재 실행 가능 확인 아님');
  else if (ailgnsBurnOpen) warn.push('AiLGNS 재소각 한도 양수 ≠ 개인 편입 확정(ASSUMED)');
  const lgnsBurnOpen = (d) => (e.lgnsBurnOpenFromDay !== null ? d >= e.lgnsBurnOpenFromDay : e.ignoreBurnCaps || (lgnsCap !== null && lgnsCap > 0n));
  if (lgnsCap === 0n && e.lgnsBurnOpenFromDay === null) warn.push('LGNS 소각 한도 0 유지(재개 자동 가정 없음)');
  if (e.lgnsBurnOpenFromDay !== null) warn.push(`LGNS 소각 재개일 ${e.lgnsBurnOpenFromDay}일은 사용자 시나리오`);
  return { regression: false, float: false, r: (BigInt(annual) * WAD) / (BPS * 365n), priceAt, model, depth: e.poolDepthDai,
    ...base, feeAt, feeIncluded: e.feeIncludedInQuote,
    burnBps: Number(burnBps),
    outputMultipleBps: e.outputMultipleBps, immediateBps: e.immediateBps,
    lockSeconds: Number(lockS),
    entryLagDays: e.entryLagDays, reburnLagDays: e.reburnLagDays, execOffset: e.executionOffsetSeconds,
    daySeconds: Number(daySecondsSnap ?? 86400n),
    ailgnsBurnOpen, lgnsBurnOpen, lgnsPowerPerLgns: lgnsRate,
    gasUnit: e.gas.unitDai, autoRefill: e.gas.autoRefillFromCash, allowPartial: e.allowPartialActivation,
    depositsOpen: daiEntryOpen,
    warn: [...warn, '터빈 산출 2배·즉시/잠금 비율·수수료 별도부과·편입 지연·실행 순서는 ASSUMED(실거래 표본 미대조)'], prov };
}

/** 정책 → 날짜별 요청 재순환 bps. {recycleBps} | {switchDay}. */
export const recycleBpsAt = (policy, d) => (policy.switchDay !== undefined && policy.switchDay !== null ? (d < policy.switchDay ? 10000 : 0) : Number(policy.recycleBps ?? 0));

/**
 * @param scenario normalizeInput 결과
 * @param snapshot validateSnapshot 결과
 * @param policy {recycleBps} | {switchDay}
 * @param opts {strict, regression, horizonDays}
 * @returns {daily, events, summary, warnings, failed}
 */
export function simulate(scenario, snapshot, policy, opts = {}) {
  let P;
  try { P = resolveParams(scenario, snapshot, opts); }
  catch (err) {
    if (err.name !== 'SnapshotBlocked') throw err;
    // 계산 중단(검증대기). 수치를 만들지 않는다.
    return { blocked: true, daily: [], events: [], warnings: [err.message], failed: { day: null, reason: 'SNAPSHOT_BLOCKED', keys: err.keys },
      summary: { resultClass: 'BLOCKED', blockedKeys: err.keys, modelCompleted: false, completed: false, liveExecutable: false, executable: false,
        liveBlockers: ['SNAPSHOT_BLOCKED'], I: null, W: null, net: null, roiBps: null, paybackDay: null, reUnrecovered: false, topups: 0n,
        initialCapitalDai: null, milestones: [], unrealized: null, entryState: 'SNAPSHOT_BLOCKED', label: '계산 중단 — 핵심 스냅샷 값 검증대기' } };
  }
  const e = scenario.engine, warnings = [...P.warn], events = [], daily = [];
  const DS = P.daySeconds, N = opts.horizonDays ?? horizonDays(scenario.startDate, scenario.horizonYears, scenario.periodMode);
  const b0 = P.regression ? 0 : firstBoundary(scenario.startDate, Number(sv(snapshot, 'dayStart') ?? kstMidnightUnix(scenario.startDate)) % DS, DS);
  const quote = P.regression ? { economicCostDai: scenario.amount, powerPreview: wmul(scenario.amount, wad25), route: ROUTES.DAI_DIRECT, issues: [], warnings: [] } : getEntryQuote(scenario, snapshot);
  warnings.push(...quote.warnings);

  // ---- 상태 ----
  const S = { active: 0n, pending: [], credits: 0n, spendable: e.initialAilgns ?? 0n, locked: [], cash: P.regression ? 0n : scenario.reserveDai,
    native: { anubis: P.regression ? 0n : e.gas.anubisNativeDai, polygon: 0n }, lgnsWaiting: 0n, lgnsBurned: 0n,
    topups: 0n, W: 0n, gasSpent: 0n, refill: 0n, holds: 0, partials: 0, gasFails: 0, maxTopupDay: 0n,
    reqRecycleTok: 0n, execBurnTok: 0n, execSellTok: 0n, cumEmissionDai: 0n };
  let I0 = quote.economicCostDai === null ? null : quote.economicCostDai + (P.regression ? 0n : scenario.reserveDai + e.gas.anubisNativeDai + (e.initialAilgnsCostDai ?? 0n));
  if (e.initialAilgns && e.initialAilgnsCostDai === null) { I0 = null; warnings.push('기존 AiLGNS 원가 미입력 → ROI N/A'); }
  let fixedState = null, failed = null, entryState = 'NONE', invariantFails = 0;
  // summaryOnly: 계산은 동일, 일별 장부는 마일스톤 날짜만 보관하고 사건 목록은 쌓지 않는다(최적화용).
  const summaryOnly = !!opts.summaryOnly;
  const msList = milestones(scenario.startDate, scenario.horizonYears, scenario.periodMode);
  const keepDays = new Set(msList.map((m) => m.day - 1));
  let lastRec = null, daysDone = 0, payback = null, reUnrecovered = false;
  const track = (r) => { if (r.I === null || r.I === 0n) return; if (r.cumWithdrawal >= r.I) { if (payback === null) payback = r.day; } else if (payback !== null) reUnrecovered = true; };
  const ev = (day, type, o = {}) => { if (!summaryOnly) events.push({ day, type, ...o }); };

  const payGas = (chain, actions, rec) => {
    if (!P.gasUnit) return true;
    const cost = actions.reduce((s, a) => s + P.gasUnit[a], 0n);
    if (S.native[chain] < cost) {
      if (P.autoRefill && chain === 'anubis' && S.cash >= cost - S.native[chain]) { const need = cost - S.native[chain]; S.cash -= need; S.native[chain] += need; S.refill += need; rec.refillDai += need; }
      else { S.gasFails++; rec.gasShort = true; return false; }
    }
    S.native[chain] -= cost; S.gasSpent += cost; rec.gasDai += cost; return true;
  };
  // 실행 전 가스 계획: {cost, refill(현금에서 충전할 DAI)} | null(불가). 터빈·매도 사전검사에 사용.
  const gasPlan = (chain, actions) => {
    if (!P.gasUnit) return { cost: 0n, refill: 0n };
    const cost = actions.reduce((s, a) => s + P.gasUnit[a], 0n);
    if (S.native[chain] >= cost) return { cost, refill: 0n };
    return P.autoRefill && chain === 'anubis' ? { cost, refill: cost - S.native[chain] } : null;
  };

  // ---- 진입 ----
  if (scenario.route === ROUTES.POLYGON_FIXED) {
    S.native.polygon = e.gas.polygonNativeDai; if (I0 !== null) I0 += e.gas.polygonNativeDai;
    const fq = { ...quote.fixed, stopUnix: quote.fixed.stopDate ? kstMidnightUnix(quote.fixed.stopDate) : null };
    fixedState = createFixedState(fq, b0);
    if (!fixedState.enabled) warnings.push(`FIXED 검증대기: ${fixedState.missing.join(',')} 미입력 → 지급 없음(조건부)`);
    const r0 = { gasDai: 0n, refillDai: 0n };
    if (!payGas('polygon', ['approve', 'fixedBurn'], r0)) { warnings.push('Polygon 가스 부족: FIXED 소각 불가'); fixedState.enabled = false; }
    ev(0, 'FIXED_BURN_POLYGON', { lgns: scenario.amount, principalRecognizedDai: fixedState.principalRecognizedDai });
    warnings.push('FIXED 인정액은 지급 계산용이며 ROI 원금 아님');
  } else if (scenario.route === ROUTES.ANUBIS_LGNS_BURN) {
    S.lgnsWaiting = scenario.amount;
  } else if (quote.powerPreview === null) { entryState = 'UNAVAILABLE'; warnings.push('진입 Power 미확정(견적 없음) → 진입 없음'); }
  else if (!P.depositsOpen) { entryState = 'BLOCKED'; warnings.push('예치 닫힘(depositsOpen=0) → 진입 없음, 재개 자동 가정 금지'); }
  else entryState = 'PENDING'; // 루프에서 approve+deposit 가스 확인 후 실행
  if (!P.regression) warnings.push('개인 일일 한도 배정 미확정 → 진입 편입은 지연 시나리오');

  const sellCfg = (pool, price) => ({ model: P.model, pool, priceDaiPerAilgns: price, sellTaxBps: P.sellTaxBps, poolFeeBps: P.poolFeeBps, feeIncludedInQuote: P.feeIncluded });
  const tokensForDai = (dai, pool, price) => {
    if (dai <= 0n) return 0n;
    if (P.model === PRICE_MODELS.AMM_DAILY_RESET) { const a = ammIn(dai, pool.ailgns, pool.dai, P.poolFeeBps); return a === null ? null : ceilDiv(a * BPS, BPS - BigInt(P.sellTaxBps)); }
    let net = bpsOf(price, Number(BPS) - P.sellTaxBps); if (!P.feeIncluded) net = bpsOf(net, Number(BPS) - P.poolFeeBps);
    return ceilDiv(dai * WAD, net);
  };

  for (let d = 0; d < N && !failed; d++) {
    Object.assign(P, P.feeAt(d)); // 수수료 변경 일정(없으면 기준값)
    const t = b0 + d * DS, exec = t + P.execOffset, price = P.priceAt(d);
    let pool = P.model === PRICE_MODELS.AMM_DAILY_RESET ? makeDayPool({ priceDaiPerAilgns: price, depthDai: P.depth }) : null;
    const rec = { day: d, date: P.regression ? null : kstDate(t), t, price, events: [], gasDai: 0n, refillDai: 0n, poolFeeDai: 0n, sellTaxTokens: 0n,
      turbineBuyDai: 0n, turbineFeeDai: 0n, coverSaleTokens: 0n, coverSaleDai: 0n, reserveSaleTokens: 0n, reserveSaleDai: 0n,
      burnTokens: 0n, newPendingPower: 0n, immediateTokens: 0n, withdrawSaleTokens: 0n, externalWithdrawal: 0n, externalTopup: 0n, heldCredits: 0n, gasShort: false };
    const cash0 = S.cash, spend0 = S.spendable;
    const sell = (tok, kind) => {
      if (tok <= 0n) return 0n;
      if (!payGas('anubis', ['approve', 'sale'], rec)) return null;
      const q = quoteSellAilgns(tok, sellCfg(pool, price)); if (pool) pool = q.pool;
      S.spendable -= tok; S.cash += q.daiOut; rec.sellTaxTokens += tok - q.arrive;
      for (const c of q.costs) if (c.kind === 'poolFee' && c.amount) rec.poolFeeDai += c.amount;
      ev(d, 'SALE', { kind, tokens: tok, dai: q.daiOut }); return q.daiOut;
    };
    const sellForDai = (dai, kind) => {
      let tok = tokensForDai(dai, pool, price); if (tok === null) return { tok: 0n, dai: 0n };
      if (tok > S.spendable) tok = S.spendable;
      const got = sell(tok, kind); return got === null ? { tok: 0n, dai: 0n } : { tok, dai: got };
    };

    // 0. DAI 진입(approve+deposit 가스 선행). 가스 부족이면 pending 생성 안 함.
    if (entryState === 'PENDING') {
      if (payGas('anubis', ['approve', 'deposit'], rec)) {
        S.pending.push({ amount: quote.powerPreview, eligibleAt: t + P.entryLagDays * DS, route: 'entry' });
        entryState = 'DONE'; ev(d, 'ENTRY_DAI', { power: quote.powerPreview });
      } else { ev(d, 'ENTRY_GAS_SHORT'); if (opts.strict) { failed = { day: d, reason: 'ENTRY_GAS' }; break; } }
    } else if ((entryState === 'BLOCKED' || entryState === 'UNAVAILABLE') && opts.strict) { failed = { day: d, reason: 'ENTRY_BLOCKED' }; break; }

    // 1. 잠금 해제 → 적격 Power 활성
    let unlocked = 0n;
    S.locked = S.locked.filter((l) => (l.unlockAt <= exec ? ((unlocked += l.amount), false) : true));
    S.spendable += unlocked;
    const activeStart = S.active; let newActive = 0n;
    S.pending = S.pending.filter((p) => (p.eligibleAt <= t ? ((newActive += p.amount), ev(d, 'ACTIVATE', { power: p.amount, route: p.route }), false) : true));
    S.active += newActive;

    // 2. 정산: E = P×r (상한 비구속 가정), Power 소진 = E
    const E = (S.active * P.r) / WAD; S.active -= E; S.cumEmissionDai += E;
    const Q = wdiv(E, price); S.credits += Q;

    // FIXED 지급·청구 → LGNS 대기 → HELIX 소각(한도 열린 날만)
    if (fixedState?.enabled) {
      let r1 = fixedAccrual(fixedState, { type: 'tick', at: exec }); fixedState = r1.state; r1.events.forEach((x) => ev(d, x.type, x));
      if (fixedState.unclaimedLgns > 0n && payGas('anubis', ['fixedClaim'], rec)) {
        r1 = fixedAccrual(fixedState, { type: 'claim', at: exec }); fixedState = r1.state;
        for (const x of r1.events) { S.lgnsWaiting += x.lgns; ev(d, x.type, x); }
      }
    }
    if (S.lgnsWaiting > 0n && P.lgnsBurnOpen(d)) {
      if (P.lgnsPowerPerLgns === null) warnings.push('LGNS→Power 비율 없음');
      else if (payGas('anubis', ['approve', 'burn'], rec)) {
        const pw = wmul(rescale(S.lgnsWaiting, 9, 18), P.lgnsPowerPerLgns);
        S.pending.push({ amount: pw, eligibleAt: t + P.reburnLagDays * DS, route: 'lgnsBurn' });
        ev(d, 'HELIX_LGNS_BURN', { lgns: S.lgnsWaiting, power: pw }); S.lgnsBurned += S.lgnsWaiting; S.lgnsWaiting = 0n;
      }
    }

    const ACT = ['claim', 'approve', 'activate'];
    const SALE = ['approve', 'sale'];
    const BURN = ['approve', 'burn'];
    const selfReserve = !P.float && scenario.funding === FUNDING.SELF;
    const reqBpsToday = recycleBpsAt(policy, d);
    const disposalActions = (spendable) => {
      if (spendable <= 0n) return [];
      const actions = [];
      const burn = bpsOf(spendable, reqBpsToday);
      if (burn > 0n && P.ailgnsBurnOpen) actions.push(...BURN);
      const withdraw = reqBpsToday === 10000 ? 0n : spendable - burn;
      if (withdraw > 0n) actions.push(...SALE);
      return actions;
    };
    // ACT가 만들어 낼 즉시 토큰을 처분하기 전 필요한 가스는 기존 현금/네이티브로 먼저 확보한다.
    // SELF reserve 매도가 필요할 수 있으므로 그 첫 SALE도 포함하되, 실제 비용은 payGas에서만 기록한다.
    const postActivationActions = (credits) => {
      const now = bpsOf(bpsOf(credits, P.outputMultipleBps), P.immediateBps);
      const spendable = S.spendable + now;
      if (spendable <= 0n) return [];
      return [...(selfReserve ? SALE : []), ...disposalActions(spendable)];
    };

    // 3~6. 터빈: 견적 → (부족분 선매도/외부입금) → 활성화 → 즉시/잠금
    if (S.credits > 0n) {
      const bq = quoteBuyAilgns(S.credits, { model: P.model, pool, priceDaiPerAilgns: price, poolFeeBps: P.poolFeeBps, feeIncludedInQuote: P.feeIncluded });
      const need = bq.daiIn === null ? null : bq.daiIn + bpsOf(bq.daiIn, P.turbineFeeBps);
      // 필요 현금 = 매수+터빈수수료 + ACT 이후 첫 reserve/처분까지의 결합 가스 충전분.
      const after0 = postActivationActions(S.credits);
      const gp0 = gasPlan('anubis', [...ACT, ...after0]);
      if (need !== null && gp0 !== null && !P.float && S.cash < need + gp0.refill) {
        if (scenario.funding === FUNDING.SELF) {
          // cover SALE와 이후 ACT/처분을 하나의 계획으로 계산해 현재 native를 중복 차감하지 않는다.
          const cover = gasPlan('anubis', [...SALE, ...ACT, ...after0]);
          if (cover !== null) {
            const r = sellForDai(need + cover.refill - S.cash, 'cover'); rec.coverSaleTokens += r.tok; rec.coverSaleDai += r.dai;
          }
        } else {
          const b = scenario.externalBudget, room = b.totalDai - S.topups;
          let add = need + gp0.refill - S.cash; if (add > b.dailyDai) add = b.dailyDai; if (add > room) add = room;
          if (add > 0n) { S.cash += add; S.topups += add; rec.externalTopup += add; if (add > S.maxTopupDay) S.maxTopupDay = add; ev(d, 'EXTERNAL_TOPUP', { dai: add }); }
        }
      }
      const gp = gasPlan('anubis', [...ACT, ...postActivationActions(S.credits)]);
      if (gp === null) { rec.gasShort = true; S.gasFails++; }
      let actQ = 0n;
      if (need !== null && gp !== null && (P.float || S.cash >= need + gp.refill)) actQ = S.credits;
      else if (need !== null && gp !== null && P.allowPartial && S.cash > gp.refill) { actQ = (S.credits * (S.cash - gp.refill)) / need; S.partials++; warnings.push('분할 활성화는 계약 검증 전 ASSUMED'); }
      // 선매도로 일내 풀이 변했을 수 있으므로 실행 직전 재견적(AMM). 재견적+가스충전이 현금을 넘으면 보류.
      const aq = actQ > 0n ? quoteBuyAilgns(actQ, { model: P.model, pool, priceDaiPerAilgns: price, poolFeeBps: P.poolFeeBps, feeIncludedInQuote: P.feeIncluded }) : null;
      if (aq && !P.float && (aq.daiIn === null || aq.daiIn + bpsOf(aq.daiIn, P.turbineFeeBps) + gp.refill > S.cash)) actQ = 0n;
      if (actQ > 0n && !payGas('anubis', ['claim', 'approve', 'activate'], rec)) actQ = 0n;
      if (actQ > 0n) {
        const fee = bpsOf(aq.daiIn, P.turbineFeeBps);
        if (aq.pool) pool = aq.pool;
        for (const c of aq.costs) if (c.amount) rec.poolFeeDai += c.amount;
        S.cash -= aq.daiIn + fee; rec.turbineBuyDai = aq.daiIn; rec.turbineFeeDai = fee; S.credits -= actQ;
        const out = bpsOf(actQ, P.outputMultipleBps), now = bpsOf(out, P.immediateBps);
        S.spendable += now; rec.immediateTokens = now; if (out > now) S.locked.push({ amount: out - now, unlockAt: exec + P.lockSeconds });
        ev(d, 'TURBINE', { credits: actQ, buyDai: aq.daiIn, fee, immediate: now, locked: out - now });
        if (P.float && S.cash < 0n) { const r = sellForDai(-S.cash, 'cover'); rec.coverSaleTokens += r.tok; rec.coverSaleDai += r.dai; }
      }
      if (S.credits > 0n) {
        rec.heldCredits = S.credits; S.holds++; ev(d, 'TURBINE_HOLD', { credits: S.credits, needDai: need, cash: S.cash });
        if (opts.strict) failed = { day: d, reason: rec.gasShort ? 'GAS' : 'CASH', needDai: need, cashDai: S.cash, unprocessedQ: S.credits };
      }
    }

    // 7. 다음 실행 reserve (비용충당형만). 다음 E 추정은 시나리오 가격 기반.
    // 목표 = 다음 활성화 매수·수수료 + 활성화 가스 충전분(자동충전 시). 미래 견적은 시나리오 가격 기반 ASSUMED.
    const reserveTarget = (beforeNextAct = []) => {
      const nextActive = S.active + S.pending.filter((p) => p.eligibleAt <= t + DS).reduce((s, p) => s + p.amount, 0n);
      const En = (nextActive * P.r) / WAD;
      let target = bpsOf(En, 10000 + P.turbineFeeBps + (P.feeIncluded ? 0 : P.poolFeeBps));
      const g = gasPlan('anubis', [...beforeNextAct, ...ACT]);
      if (g === null) rec.reserveGasShort = true; else target += g.refill;
      return target;
    };
    const topReserve = (afterActions = []) => {
      let target = reserveTarget(afterActions);
      // reserve SALE 자체와 뒤따르는 처분/다음 ACT를 합산한 부족분을 판다. SALE 후에는 이미 쓴 SALE을 빼고 재계산한다.
      if (S.cash < target && S.spendable > 0n) {
        const grossTarget = reserveTarget([...SALE, ...afterActions]);
        const r = sellForDai(grossTarget - S.cash, 'reserve'); rec.reserveSaleTokens += r.tok; rec.reserveSaleDai += r.dai;
        target = reserveTarget(afterActions);
      }
      rec.reserveTargetDai = target;
      rec.reserveShort = S.cash < target;
    };
    if (selfReserve) topReserve(disposalActions(S.spendable));

    // 8~9. 남은 매도가능분 처분: 재소각(pending, 다음 적격 정산) / 매도→외부 인출
    const avail = S.spendable, reqBps = reqBpsToday;
    let burnTok = bpsOf(avail, reqBps); S.reqRecycleTok += burnTok;
    if (burnTok > 0n && (!P.ailgnsBurnOpen || !payGas('anubis', ['approve', 'burn'], rec))) { ev(d, 'BURN_BLOCKED', { tokens: burnTok }); burnTok = 0n; }
    if (burnTok > 0n) {
      const pw = (wmul(burnTok, price) * BigInt(P.burnBps)) / BPS;
      S.spendable -= burnTok; S.pending.push({ amount: pw, eligibleAt: t + P.reburnLagDays * DS, route: 'reburn' });
      rec.burnTokens = burnTok; rec.newPendingPower = pw; S.execBurnTok += burnTok; ev(d, 'REBURN', { tokens: burnTok, power: pw });
    }
    // 재소각 Power가 다음 정산에 편입되므로 reserve 재계산 → 인출 예정분에서 우선 충당.
    if (selfReserve && rec.newPendingPower > 0n) topReserve(disposalActions(S.spendable));
    let sellTok = reqBps === 10000 ? 0n : avail - bpsOf(avail, reqBps);
    if (sellTok > S.spendable) sellTok = S.spendable;
    if (sellTok > 0n) {
      const got = sell(sellTok, 'withdraw');
      if (got !== null) { S.cash -= got; S.W += got; rec.withdrawSaleTokens = sellTok; rec.externalWithdrawal += got; S.execSellTok += sellTok; ev(d, 'WITHDRAW', { dai: got }); }
    }

    // 10. 보존식·음수 검사
    // 인출용 매도 대금은 즉시 외부로 나가므로 현금 순변화 0.
    const cashCalc = cash0 + rec.externalTopup + rec.coverSaleDai + rec.reserveSaleDai - rec.turbineBuyDai - rec.turbineFeeDai - rec.refillDai;
    const invariant = (msg) => { warnings.push(`CONSERVATION ${msg} day ${d}`); invariantFails++; if (!failed) failed = { day: d, reason: 'INVARIANT', msg }; };
    if (cashCalc !== S.cash) invariant('현금 불일치');
    const tokCalc = spend0 + unlocked + rec.immediateTokens - rec.coverSaleTokens - rec.reserveSaleTokens - rec.burnTokens - rec.withdrawSaleTokens;
    if (tokCalc !== S.spendable || S.spendable < 0n || S.native.anubis < 0n || (!P.float && S.cash < 0n)) invariant('음수/토큰 불일치');

    const I = I0 === null ? null : I0 + S.topups;
    Object.assign(rec, { activePowerStart: activeStart, newActivePower: newActive, consumedPower: E, activePowerEnd: S.active,
      pendingPower: S.pending.reduce((s, p) => s + p.amount, 0n), emissionDai: E, emissionAilgns: Q, credits: S.credits,
      lockedAilgns: S.locked.reduce((s, l) => s + l.amount, 0n), spendableAilgns: S.spendable, cash: S.cash, nativeAnubis: S.native.anubis,
      cumTopup: S.topups, cumWithdrawal: S.W, cumEmissionDai: S.cumEmissionDai, I, net: I === null ? null : S.W - I, unrecovered: I === null ? null : (I > S.W ? I - S.W : 0n),
      requestedRecycleBps: reqBps, executedRecycleBps: avail > 0n ? Number((rec.burnTokens * BPS) / avail) : null,
      fixed: fixedState ? { paidDai: fixedState.paidDai, accruedLgns: fixedState.accruedLgns, unclaimedLgns: fixedState.unclaimedLgns, stopped: fixedState.stopped } : null,
      lgnsWaiting: S.lgnsWaiting, lgnsBurned: S.lgnsBurned });
    if (lastRec) track(lastRec);
    lastRec = rec; daysDone++;
    if (!summaryOnly || keepDays.has(d)) daily.push(rec);
  }

  // 종료 반환(최종 horizon만, R5). 네이티브 가스는 반환 미검증 → 미실현.
  let endReturn = 0n;
  // 반환 전송 가스(transfer)를 먼저 확보·차감하고 순액만 반환. 가스 불가면 반환하지 않고 미실현 표시.
  const gEnd = lastRec && S.cash > 0n ? gasPlan('anubis', ['transfer']) : null;
  if (!failed && e.returnCashAtEnd !== false && S.cash > 0n && lastRec && (gEnd === null || gEnd.refill >= S.cash)) warnings.push('종료 반환 가스 부족 — 내부 현금 미반환(미실현)');
  else if (!failed && e.returnCashAtEnd !== false && S.cash > 0n && lastRec) {
    const cash0 = S.cash;
    payGas('anubis', ['transfer'], lastRec);
    lastRec.endReturnGasDai = gEnd.cost; lastRec.endReturnRefillDai = cash0 - S.cash;
    endReturn = S.cash; S.W += S.cash; S.cash = 0n; const last = lastRec;
    last.externalWithdrawal += endReturn; last.endReturnDai = endReturn; last.cumWithdrawal = S.W; last.cash = 0n;
    if (last.I !== null) { last.net = S.W - last.I; last.unrecovered = last.I > S.W ? last.I - S.W : 0n; }
    ev(last.day, 'END_RETURN', { dai: endReturn });
  }
  if (lastRec) track(lastRec); // 마지막 날은 종료 반환 반영 후 판정
  // 예정 진입/편입 실행 여부(유휴 성공 금지)
  const r = scenario.route;
  let entryOk = entryState === 'DONE', entryReason = 'ENTRY_NOT_EXECUTED';
  if (r === ROUTES.ANUBIS_LGNS_BURN) { entryOk = S.lgnsWaiting === 0n && S.lgnsBurned > 0n; entryReason = 'LGNS_BURN_PENDING'; }
  if (r === ROUTES.POLYGON_FIXED) { entryOk = !!fixedState?.enabled && S.lgnsWaiting === 0n; entryReason = fixedState?.enabled ? 'LGNS_BURN_PENDING' : 'FIXED_UNVERIFIED'; }
  if (!entryOk) { warnings.push(`예정 진입/편입 미완료: ${entryReason}`); if (opts.strict && !failed) failed = { day: daysDone - 1, reason: entryReason }; }
  if (S.holds) warnings.push(`터빈 보류 ${S.holds}회(크레딧 만료 규칙 미검증)`);
  if (S.gasFails) warnings.push(`가스 부족 ${S.gasFails}회`);

  const I = I0 === null ? null : I0 + S.topups;
  const modelDone = !failed && entryOk && invariantFails === 0 && S.holds === 0 && S.partials === 0 && S.gasFails === 0;
  const byDay = new Map(daily.filter((x) => keepDays.has(x.day)).map((x) => [x.day, x]));
  const ms = msList.filter((m) => m.day <= daysDone).map((m) => ({ ...m, record: byDay.get(m.day - 1) }));
  return {
    daily, events, warnings: [...new Set(warnings)], failed,
    summary: {
      // modelCompleted: 가정 모형 안에서 예정 진입·활성화를 모두 수행. liveExecutable: 실거래 대조로 경로가 독립 검증된 경우만 true(현재 없음).
      modelCompleted: modelDone, completed: modelDone, liveExecutable: false, executable: false,
      liveBlockers: ['ROUTE_NOT_LIVE_VERIFIED', 'FUTURE_ASSUMED', ...(e.ignoreBurnCaps ? ['BURN_CAPS_IGNORED'] : []), ...(P.regression ? ['REGRESSION_FIXTURE'] : [])],
      resultClass: P.regression ? 'REGRESSION' : modelDone ? 'CONDITIONAL_MODEL' : 'INCOMPLETE',
      label: P.regression ? '가정 회귀 전용 — 실제 실행 불가' : modelDone ? '조건부 모형 완료(미래 ASSUMED, 실행 가능 확정 아님)' : '조건부 모형 미완료',
      entryState: entryOk ? 'DONE' : entryReason, invariantFails,
      I, W: S.W, net: I === null ? null : S.W - I, roiBps: I === null || I === 0n ? null : Number(((S.W - I) * BPS) / I),
      endReturnDai: endReturn, paybackDay: payback, reUnrecovered, maxTopupDay: S.maxTopupDay, topups: S.topups, gasSpent: S.gasSpent,
      requestedRecycleTokens: S.reqRecycleTok, executedBurnTokens: S.execBurnTok, executedSellTokens: S.execSellTok,
      unrealized: { spendableAilgns: S.spendable, lockedAilgns: S.locked.reduce((s, l) => s + l.amount, 0n), pendingPower: S.pending.reduce((s, p) => s + p.amount, 0n),
        activePower: S.active, credits: S.credits, lgnsWaiting: S.lgnsWaiting, nativeGas: { ...S.native }, cashNotReturned: S.cash },
      fixed: fixedState, costBasis: quote.costBasis ?? null, milestones: ms, params: P.prov, horizonDays: N,
      initialCapitalDai: I0, daysSimulated: daysDone, summaryOnly,
    },
  };
}
const wad25 = 25n * WAD / 10n;

/**
 * 최소 운전자금 탐색(R1, R4). 성공 = strict 실행에서 전체 활성화 완료.
 * 예산 = totalBudgetDai - 진입원가 - 가스. 예산 내 성공 없으면 INSUFFICIENT_BUDGET(0 성공 처리 금지).
 */
export function findMinReserve(scenario, snapshot, policy, { stepDai = 10n ** 16n, samples = 8 } = {}) {
  const q = getEntryQuote(scenario, snapshot);
  if (scenario.totalBudgetDai === null) throw new Error('총 초기예산 필수');
  if (q.economicCostDai === null) return { status: 'COST_UNKNOWN' };
  const hi = scenario.totalBudgetDai - q.economicCostDai - scenario.engine.gas.anubisNativeDai;
  if (hi < 0n) return { status: 'INSUFFICIENT_BUDGET', maxReserve: hi };
  const ok = (x) => { const r = simulate({ ...scenario, reserveDai: x }, snapshot, policy, { strict: true }); return { pass: r.summary.completed, failed: r.failed }; };
  const top = ok(hi);
  const STRUCTURAL = ['ENTRY_BLOCKED', 'ENTRY_NOT_EXECUTED', 'LGNS_BURN_PENDING', 'FIXED_UNVERIFIED', 'INVARIANT'];
  if (!top.pass) return { status: STRUCTURAL.includes(top.failed?.reason) ? 'NOT_EXECUTABLE' : 'INSUFFICIENT_BUDGET', maxReserve: hi, failed: top.failed };
  // 단조성 표본 검사
  const pts = Array.from({ length: samples + 1 }, (_, i) => (hi * BigInt(i)) / BigInt(samples)).map((x) => ({ x, pass: ok(x).pass }));
  const monotone = pts.every((p, i) => i === 0 || !pts[i - 1].pass || p.pass);
  if (monotone) {
    let lo = 0n, h = hi;
    if (ok(0n).pass) return { status: 'OK', minReserve: 0n, monotone, label: '이분 탐색' };
    while (h - lo > stepDai) { const m = (lo + h) / 2n; if (ok(m).pass) h = m; else lo = m; }
    return { status: 'OK', minReserve: h, monotone, label: '이분 탐색' };
  }
  const first = pts.find((p) => p.pass);
  return { status: 'OK', minReserve: first.x, monotone: false, label: '탐색한 범위의 최소(단조성 불성립, 구간 탐색)' };
}
