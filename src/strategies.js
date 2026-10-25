// 전략·최적화. DESIGN §8, §14 R4. 모든 후보는 engine.simulate 단일 장부로 평가한다(폐쇄형 g^n 미사용).
// 결과 문구는 '검색한 전략 중 최적' — 전역 최적·가격 예측 주장 금지. 미래 조건은 전부 ASSUMED.
import { simulate } from './engine.js';
import { getEntryQuote } from './quotes.js';
import { horizonDays } from './dates.js';
import { STATUS, FUNDING, ROUTES } from './schema.js';

export const OPTIMIZER_PROTOCOL = 'helix-opt/1';
export const SEARCH_LABEL = '검색한 전략 중 최적(조건부 모형 기준 — 실행 가능 확정 아님)';
export const FUTURE_NOTE = '미래 가격·배출·개방·수수료·지연은 ASSUMED(현재 조건 유지 등 시나리오) — 예측 아님';
export const DEFAULT_SEARCH = Object.freeze({ ratioStep: 100, refineStep: 10, refineSpan: 90, switchStride: 1, yieldEvery: 20, nearBestBps: 10 });

/**
 * 정책. ratio는 재순환 bps(0~10000, 100=1%, 10=0.1%). switchDay=N은 '정산일 0~N-1일차에 100% 재순환 요청 → N일차부터 0%'.
 * 시점 규칙일 뿐 실제 소각 횟수가 아니다(한도·가스·처분가능분 0이면 해당 일 소각 없음).
 * @returns {{type:string, recycleBps:number|null, switchDay:number|null, key:string, label:string}}
 */
export function makePolicy({ type = 'ratio', ratio = null, switchDay = null } = {}) {
  if (type === 'sell') return makePolicy({ type: 'ratio', ratio: 0 });
  if (type === 'reburn') return makePolicy({ type: 'ratio', ratio: 10000 });
  if (type === 'ratio') {
    const r = Number(ratio);
    if (!Number.isInteger(r) || r < 0 || r > 10000) throw new RangeError('ratio는 0~10000 정수 bps');
    return Object.freeze({ type, recycleBps: r, switchDay: null, key: `r:${r}`, label: `고정 재순환 ${(r / 100).toFixed(2)}%` });
  }
  if (type === 'switch') {
    const n = Number(switchDay);
    if (!Number.isInteger(n) || n < 0) throw new RangeError('switchDay는 0 이상 정수');
    const label = n === 0 ? '0일차부터 전액 현금화(재소각 요청 없음)' : `처음 ${n}개 정산일(0~${n - 1}일차) 전액 재소각 요청 → ${n}일차부터 전액 현금화`;
    return Object.freeze({ type, recycleBps: null, switchDay: n, key: `s:${n}`, label });
  }
  throw new RangeError(`알 수 없는 정책 type ${type}`);
}

// 스냅샷 의존 키(사용자 엔진 값으로 덮으면 의존하지 않음).
const DEPS = [
  ['daiPowerRateBps', null], ['annualRateBps', 'annualRateBps'], ['turbineFeeBps', 'turbineFeeBps'], ['sellFeeBps', 'sellTaxBps'],
  ['lockSeconds', 'lockSeconds'], ['oracleTwapDaiPerAilgns', 'priceDaiPerAilgns'], ['ailgnsPowerRateBps', 'ailgnsBurnPowerBps'],
  ['dailyAilgnsBurnPowerCap', 'ailgnsBurnOpen'],
];
const DAI_DEPS = [['depositsOpen', null], ['dailyDaiPowerCap', null]];
const LGNS_DEPS = [['dailyBurnPowerCap', 'lgnsBurnOpenFromDay'], ['lgnsPowerRate', 'lgnsPowerPerLgns']];

/** 스냅샷 격리: 경로가 의존하는 값이 UNKNOWN/UNAVAILABLE/CONFLICT이거나 구현 검증대기면 모든 후보를 조건부로. */
export function snapshotGate(scenario, snapshot) {
  const reasons = [];
  if (!snapshot?.values) return { ok: false, reasons: ['SNAPSHOT:NONE'] };
  if (snapshot.mode === 'PENDING_VERIFICATION') reasons.push('SNAPSHOT:PENDING_VERIFICATION');
  const lgns = scenario.route === ROUTES.ANUBIS_LGNS_BURN || scenario.route === ROUTES.POLYGON_FIXED;
  for (const [k, override] of [...DEPS, ...(lgns ? LGNS_DEPS : DAI_DEPS)]) {
    if (scenario.engine?.ignoreBurnCaps && (k === 'dailyAilgnsBurnPowerCap' || k === 'dailyBurnPowerCap')) continue;
    if (override && scenario.engine?.[override] !== null && scenario.engine?.[override] !== undefined) continue;
    const v = snapshot.values[k];
    if (!v) reasons.push(`SNAPSHOT:${k}:UNKNOWN`);
    else if (v.status === STATUS.CONFLICT) reasons.push(`SNAPSHOT:${k}:CONFLICT`);
    else if (v.value === null || v.status === STATUS.UNAVAILABLE) reasons.push(`SNAPSHOT:${k}:UNAVAILABLE`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** 후보 1개 평가(요약만 보관). */
export function evaluateCandidate(scenario, snapshot, policy, gate, opts = {}) {
  const reasons = gate.ok ? [] : [...gate.reasons];
  let s;
  try { s = simulate(scenario, snapshot, policy, { summaryOnly: true, horizonDays: opts.horizonDays }).summary; }
  catch (e) { return { policy, modelEligible: false, liveExecutable: false, reasons: [...reasons, `ERROR:${e.message}`], net: null, roiBps: null }; }
  if (!s.completed) reasons.push(`INCOMPLETE:${s.entryState !== 'DONE' ? s.entryState : 'HOLD/GAS/INVARIANT'}`);
  // 엔진이 요청 정책을 끝까지 실행하지 못했으면 완료 수치가 있어도 추천 대상이 아니다.
  // 특히 AiLGNS 소각 한도/가스가 막힌 상태에서 요청량만 누적되고 실제 소각은 0인 후보를 거른다.
  if (typeof s.requestedRecycleTokens === 'bigint' && typeof s.executedBurnTokens === 'bigint'
    && s.requestedRecycleTokens > s.executedBurnTokens) reasons.push('POLICY_NOT_EXECUTED');
  if (s.I === null) reasons.push('COST_UNKNOWN');
  if (scenario.totalBudgetDai !== null && s.initialCapitalDai !== null && s.initialCapitalDai > scenario.totalBudgetDai) reasons.push('OVER_BUDGET');
  return {
    // modelEligible: 조건부 모형에서 정상 비교 대상. liveExecutable: 실거래 검증 경로만(현재 항상 false).
    policy, modelEligible: reasons.length === 0, liveExecutable: false, liveBlockers: s.liveBlockers ?? ['ROUTE_NOT_LIVE_VERIFIED'], reasons,
    I: s.I, W: s.W, net: s.net, roiBps: s.roiBps, paybackDay: s.paybackDay, reUnrecovered: s.reUnrecovered,
    topups: s.topups, maxTopupDay: s.maxTopupDay, initialCapitalDai: s.initialCapitalDai, endReturnDai: s.endReturnDai,
    unrealized: s.unrealized, requestedRecycleTokens: s.requestedRecycleTokens, executedBurnTokens: s.executedBurnTokens,
  };
}

const cmpBig = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
// ROI 정확 비교: a.net/a.I vs b.net/b.I (I>0)
const cmpRoi = (a, b) => cmpBig(a.net * b.I, b.net * a.I);

/** 지표별 승자(서로 다른 승자를 합치지 않음). 동률은 ties에 모두 표시. */
export function pickWinners(cands, { funding, nearBestBps = DEFAULT_SEARCH.nearBestBps } = {}) {
  const ok = cands.filter((c) => c.modelEligible && c.net !== null);
  const pick = (list, better) => {
    if (!list.length) return null;
    let best = [list[0]];
    for (const c of list.slice(1)) { const k = better(c, best[0]); if (k > 0) best = [c]; else if (k === 0) best.push(c); }
    // 단일 전환 정책끼리 동률이면 더 단순하고 이른 현금화를 택한다. 입력 순서에는 의존하지 않는다.
    const winner = best.every((c) => c.policy?.switchDay !== null && c.policy?.switchDay !== undefined)
      ? best.reduce((a, c) => (c.policy.switchDay < a.policy.switchDay ? c : a))
      : best[0];
    return { winner, ties: best.map((c) => c.policy.key), tieCount: best.length };
  };
  const maxNet = pick(ok, (a, b) => cmpBig(a.net, b.net));
  const maxRoi = pick(ok.filter((c) => c.I > 0n), cmpRoi);
  const fastestPayback = pick(ok.filter((c) => c.paybackDay !== null), (a, b) => (a.paybackDay !== b.paybackDay ? b.paybackDay - a.paybackDay : cmpBig(a.net, b.net)));
  const leastTopup = funding === FUNDING.EXTERNAL ? pick(ok, (a, b) => (a.topups !== b.topups ? cmpBig(b.topups, a.topups) : cmpBig(a.net, b.net))) : null;
  let nearBest = null;
  if (maxNet) {
    const best = maxNet.winner.net, tol = ((best < 0n ? -best : best) * BigInt(nearBestBps)) / 10000n;
    const near = ok.filter((c) => c.net >= best - tol);
    const rs = near.filter((c) => c.policy.recycleBps !== null).map((c) => c.policy.recycleBps);
    const ss = near.filter((c) => c.policy.switchDay !== null).map((c) => c.policy.switchDay);
    nearBest = { toleranceBps: nearBestBps, count: near.length,
      ratioRange: rs.length ? [Math.min(...rs), Math.max(...rs)] : null, switchRange: ss.length ? [Math.min(...ss), Math.max(...ss)] : null };
  }
  return { maxNet, maxRoi, fastestPayback, leastTopup, nearBest };
}

function summarizeConditional(cands) {
  const bad = cands.filter((c) => !c.modelEligible);
  const byReason = {};
  for (const c of bad) for (const r of c.reasons) byReason[r] = (byReason[r] ?? 0) + 1;
  const withNet = bad.filter((c) => c.net !== null);
  const best = withNet.length ? withNet.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  return { count: bad.length, byReason, bestConditional: best, note: '실행 불가/미완료/미검증 — 정상 승자에서 제외된 조건부 결과' };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 비교 예산 고정. 입력값 우선, 없으면 초기 경제적 투입 합계로 고정. 원가 미확정이면 null. */
export function deriveBudget(scenario, snapshot) {
  if (scenario.totalBudgetDai !== null && scenario.totalBudgetDai !== undefined) return { budgetDai: scenario.totalBudgetDai, budgetSource: 'USER' };
  let q;
  try { q = getEntryQuote(scenario, snapshot); } catch { return { budgetDai: null, budgetSource: 'UNKNOWN' }; }
  const e = scenario.engine;
  if (q.economicCostDai === null || (e.initialAilgns && e.initialAilgnsCostDai === null)) return { budgetDai: null, budgetSource: 'UNKNOWN' };
  const polygonGas = scenario.route === ROUTES.POLYGON_FIXED ? e.gas.polygonNativeDai : 0n;
  return { budgetDai: q.economicCostDai + scenario.reserveDai + e.gas.anubisNativeDai + polygonGas + (e.initialAilgnsCostDai ?? 0n), budgetSource: 'DERIVED_FROZEN' };
}

/**
 * 최적화. 동일 scenario(총예산·reserve·외부한도·가격/개방 시나리오)로 모든 후보를 평가한다.
 * @param {{scenario, snapshot, years?:number[], fundings?:string[]}} input
 * @param {{onProgress?, signal?:{aborted:boolean}, search?:object, replayWinners?:boolean}} ctl
 * @returns Promise<OptimizeResult>  (optimizer-contract.md 참고)
 */
export async function optimize({ scenario: scenario0, snapshot, years = [1, 2, 3], fundings = null }, ctl = {}) {
  const searchArg = ctl.search ?? {};
  const switchOnly = searchArg === 'switch-only' || searchArg?.mode === 'switch-only';
  const cfg = { ...DEFAULT_SEARCH, ...(typeof searchArg === 'object' ? searchArg : {}), ...(switchOnly ? { switchStride: 1 } : {}) };
  const signal = ctl.signal ?? { aborted: false };
  const notes = [FUTURE_NOTE, '모든 승자는 조건부 모형 기준(modelEligible). 실거래 검증 경로가 없어 liveExecutable 승자는 없음'];
  // 총 초기예산 고정: 미입력이면 진입원가+reserve+네이티브 가스+기존 토큰 원가로 명시 고정(무한 비교 금지).
  const { budgetDai, budgetSource } = deriveBudget(scenario0, snapshot);
  const scenario = { ...scenario0, totalBudgetDai: budgetDai };
  if (budgetSource === 'DERIVED_FROZEN') notes.push('총 초기예산 미입력 → 진입원가+운전자금+가스+기존 토큰 원가 합계로 고정');
  if (budgetDai === null) notes.push('총 초기예산을 정할 수 없음(원가 미확정) — 모든 후보 조건부');
  const gate = snapshotGate(scenario, snapshot);
  if (budgetDai === null) { gate.ok = false; gate.reasons.push('BUDGET_UNKNOWN'); }
  const fundList = (fundings ?? [scenario.funding]).filter((f) => f === FUNDING.SELF || (f === FUNDING.EXTERNAL && scenario.externalBudget));
  if (fundings?.includes(FUNDING.EXTERNAL) && !scenario.externalBudget) notes.push('외부 DAI 한도 미입력 — 외부 방식 탐색 생략(무제한 투입 최적화 금지)');
  const plan = [];
  for (const y of years) for (const f of fundList) plan.push({ y, f, N: horizonDays(scenario.startDate, y, scenario.periodMode) });
  const ratioCount = switchOnly ? 0 : Math.floor(10000 / cfg.ratioStep) + 1;
  const total = plan.reduce((s, p) => s + ratioCount + Math.floor(p.N / cfg.switchStride) + 1, 0); // 세분화 후보는 진행 중 추가
  let done = 0, sinceYield = 0, totalDyn = total;
  const results = [];
  const step = async (phase, y) => {
    done++; sinceYield++;
    if (sinceYield >= cfg.yieldEvery) { sinceYield = 0; ctl.onProgress?.({ phase, horizonYears: y, done, total: totalDyn }); await tick(); }
    return signal.aborted;
  };
  for (const { y, f, N } of plan) {
    const sc = { ...scenario, horizonYears: y, funding: f };
    const cands = [];
    const run = (p) => { const c = evaluateCandidate(sc, snapshot, p, gate); cands.push(c); return c; };
    if (!switchOnly) for (let b = 0; b <= 10000; b += cfg.ratioStep) { run(makePolicy({ type: 'ratio', ratio: b })); if (await step('ratio', y)) return { cancelled: true, protocol: OPTIMIZER_PROTOCOL }; }
    // 유망 구간 0.1% 세분화(정상 후보 우선, 없으면 조건부 최고)
    const pool = cands.filter((c) => c.net !== null);
    const seed = (pool.filter((c) => c.modelEligible).length ? pool.filter((c) => c.modelEligible) : pool).reduce((a, c) => (a === null || c.net > a.net ? c : a), null);
    if (!switchOnly && seed && cfg.refineStep < cfg.ratioStep) {
      const c0 = seed.policy.recycleBps, seen = new Set(cands.map((c) => c.policy.key));
      for (let b = Math.max(0, c0 - cfg.refineSpan); b <= Math.min(10000, c0 + cfg.refineSpan); b += cfg.refineStep) {
        if (seen.has(`r:${b}`)) continue; totalDyn++;
        run(makePolicy({ type: 'ratio', ratio: b })); if (await step('refine', y)) return { cancelled: true, protocol: OPTIMIZER_PROTOCOL };
      }
    }
    for (let n = 0; n <= N; n += cfg.switchStride) { run(makePolicy({ type: 'switch', switchDay: n })); if (await step('switch', y)) return { cancelled: true, protocol: OPTIMIZER_PROTOCOL }; }
    const winners = pickWinners(cands, { funding: f, nearBestBps: cfg.nearBestBps });
    // 승자만 전체 장부 재실행(그래프·표와 같은 결과) + 요약 일치 검증
    const replays = {};
    if (ctl.replayWinners !== false) {
      for (const k of ['maxNet', 'maxRoi', 'fastestPayback', 'leastTopup']) {
        const w = winners[k]?.winner; if (!w) continue;
        if (!replays[w.policy.key]) {
          const full = simulate(sc, snapshot, w.policy);
          const s = full.summary;
          const verified = s.net === w.net && s.W === w.W && s.I === w.I && s.paybackDay === w.paybackDay;
          replays[w.policy.key] = { policy: w.policy, verified, full };
        }
        winners[k].replayKey = w.policy.key;
      }
    }
    results.push({
      horizonYears: y, horizonDays: N, funding: f, label: SEARCH_LABEL, candidatesEvaluated: cands.length,
      searched: { mode: switchOnly ? 'switch-only' : 'general', ratioStep: switchOnly ? null : cfg.ratioStep,
        refineStep: switchOnly ? null : cfg.refineStep, refineCenter: switchOnly ? null : seed?.policy.recycleBps ?? null,
        switchStride: cfg.switchStride, switchMin: 0, switchMax: N },
      winners, replays, conditional: summarizeConditional(cands),
    });
  }
  ctl.onProgress?.({ phase: 'done', done, total: totalDyn });
  return {
    protocol: OPTIMIZER_PROTOCOL, cancelled: false, label: SEARCH_LABEL, notes, gate,
    metadata: {
      snapshotMode: snapshot?.mode ?? null, blockNumber: snapshot?.meta?.blockNumber ?? null, priceModel: scenario.priceModel,
      priceScheduleSteps: scenario.engine?.priceSchedule?.length ?? 0, priceAssumption: (scenario.engine?.priceSchedule?.length ? '변동 시나리오' : '현재 조건 유지(고정)'),
      fxAssumption: scenario.fx ? (scenario.fx.fixedRateAssumption ? '고정환율 가정' : '환율 시나리오') : null,
      ignoreBurnCaps: !!scenario.engine?.ignoreBurnCaps,
      lgnsBurnOpenFromDay: scenario.engine?.lgnsBurnOpenFromDay ?? null, fixedStopDate: scenario.fixed?.stopDate ?? null,
      totalBudgetDai: scenario.totalBudgetDai, budgetSource, reserveDai: scenario.reserveDai, externalBudget: scenario.externalBudget,
    },
    results,
  };
}

/**
 * UI용 클라이언트: 새 실행 시 이전 worker terminate(취소), jobId 불일치 메시지 무시.
 * createWorker() → {postMessage, terminate, onmessage}. 브라우저 Worker 또는 테스트용 가짜.
 */
export function createOptimizerClient({ createWorker, onProgress, onResult, onError, onCancelled } = {}) {
  let worker = null, jobId = 0;
  const stop = () => { if (worker) { worker.terminate(); worker = null; } };
  return {
    run({ scenario, snapshot, horizons = [1, 2, 3], fundings = null, search = null }) {
      stop();
      const id = ++jobId;
      worker = createWorker();
      worker.onmessage = (ev) => {
        const m = ev.data ?? ev;
        if (m.protocol !== OPTIMIZER_PROTOCOL || m.jobId !== jobId || id !== jobId) return; // stale job 무시
        if (m.type === 'progress') onProgress?.(m);
        else if (m.type === 'result') { onResult?.(m); stop(); }
        else if (m.type === 'error') { onError?.(m); stop(); }
      };
      worker.postMessage({ type: 'run', protocol: OPTIMIZER_PROTOCOL, jobId: id, scenario, snapshot, horizons, fundings, search });
      return id;
    },
    cancel() { const id = jobId; jobId++; stop(); onCancelled?.({ jobId: id }); },
    get currentJob() { return jobId; },
    dispose() { jobId++; stop(); },
  };
}
