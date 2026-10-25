import { PROTOCOL_BASELINE } from './protocol-baseline.js';
import { TOKEN_ICONS } from './token-icons.js';
// 화면 계층. DESIGN §2 화면 순서 A~H, §6 현금 성과, §7 마일스톤, §8 최적화 hook, §14 R5, §15.
// 계산은 engine.simulate 단일 장부만 사용한다. 표·그래프·내보내기는 같은 result에서 읽는다.
import { formatUnits, toDisplayNumber, wmul, wdiv } from './decimal.js';
import { normalizeInput, ROUTES, CHAINS, FUNDING } from './schema.js';
import { getEntryQuote } from './quotes.js';
import { simulate, findMinReserve } from './engine.js';
import { snapshotFromEvidence, validateSnapshot, refreshLive, liveCalculationErrors, acceptLiveSnapshot } from './data.js';
import { horizonDays, kstDate, daysBetween } from './dates.js';
import { createSyncedCharts } from './charts.js';
import { optimize, createOptimizerClient, OPTIMIZER_PROTOCOL } from './strategies.js';
import { fetchMarket, mergeMarket, usableLeg, legFreshness, FX_LABEL } from './market.js';

const kstTimeShort = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') : ''; };

export { OPTIMIZER_PROTOCOL };
/** 예시값(수정 가능). 가스 40은 실측 필요액이 아닌 예시 보유액. 내부 DAI 보충도 환전·가스비 모형 가정. */
export const EXAMPLE_VALUES = Object.freeze({ reserveDai: '20', 'gas.anubisNativeDai': '40', 'gas.autoRefillFromCash': true, 'engine.immediateBps': '5000' });
export const reserveModeOf = (f) => f?.reserveMode === 'MANUAL' ? 'MANUAL' : 'AUTO';

// ---- 값·서식 (표시 전용, 계산에 되돌려 쓰지 않음) ----
export const B = (x) => (x === null || x === undefined || x === '' ? null : typeof x === 'bigint' ? x : BigInt(x));
export const toNum = (v, d = 18) => { const b = B(v); return b === null ? null : toDisplayNumber(b, d); };
const nfCache = {};
const nf = (digits) => (nfCache[digits] ??= new Intl.NumberFormat('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const compactNf = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });
export const fmtN = (n, digits = 2) => (n === null || n === undefined || !Number.isFinite(n) ? 'N/A' : nf(digits).format(n));
export const fmtCompact = (n) => (Number.isFinite(n) ? compactNf.format(n) : '');
export const fmtDai = (v, digits = 2) => { const n = toNum(v); return n === null ? 'N/A' : `${fmtN(n, digits)} DAI`; };
export const fmtTok = (v, unit = 'AiLGNS', d = 18) => { const n = toNum(v, d); return n === null ? 'N/A' : `${fmtN(n, 4)} ${unit}`; };
export const fmtPower = (v) => { const n = toNum(v); return n === null ? 'N/A' : `${fmtN(n, 0)} Power`; };
export const fmtBpsPct = (bps) => (bps === null || bps === undefined ? 'N/A' : `${fmtN(Number(bps) / 100, 2)}%`);
export function roiBpsOf(net, I) { const n = B(net), i = B(I); return n === null || i === null || i === 0n ? null : Number((n * 10000n) / i); }
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const todayKst = (now = Date.now()) => kstDate(Math.floor(now / 1000));

/** 원화 표시 환율(KRW/DAI, WAD). 없으면 null. 고정환율 가정 표시용. */
export function krwRate(scenario) {
  const f = scenario?.fx; if (!f) return null;
  if (f.mode === 'CROSS') return f.daiUsd !== null && f.usdKrw !== null ? wmul(f.daiUsd, f.usdKrw) : null;
  return f.daiKrw ?? null;
}
export const fmtKrw = (v, rate) => { const n = toNum(v), r = toNum(rate); return n === null || r === null ? '' : `${fmtN(n * r, 0)}원`; };

// ---- 폼 → 원입력 ----
const ROUTE_LABEL = {
  [ROUTES.POLYGON_FIXED]: 'FIXED 소각 → Anubis LGNS 지급 → HELIX 소각 (기본)',
  [ROUTES.POLYGON_LGNS_SELL_DAI]: 'LGNS 매도 → DAI 진입 (보조 비교)',
  [ROUTES.ANUBIS_LGNS_BURN]: 'LGNS → HELIX 직접 소각',
  [ROUTES.ANUBIS_LGNS_SELL_DAI]: 'LGNS 매도 → DAI 진입',
  [ROUTES.DAI_DIRECT]: 'DAI → HELIX Power',
};
export const routesFor = (chain) => (chain === CHAINS.ANUBIS
  ? [ROUTES.ANUBIS_LGNS_BURN, ROUTES.ANUBIS_LGNS_SELL_DAI]
  : [ROUTES.POLYGON_FIXED, ROUTES.POLYGON_LGNS_SELL_DAI]);
export const routeLabel = (r) => ROUTE_LABEL[r] ?? r;

/**
 * 평면 폼 값 {name: string|boolean} → normalizeInput 원입력. 빈 칸은 null(0으로 바꾸지 않음).
 * 숫자 형식 검사는 schema가 담당하고, 여기서는 UI 전용 필드(시간·정수)만 검사해 uiErrors로 돌려준다.
 */
export function formToRaw(f) {
  const s = (k) => (f[k] === undefined || f[k] === null || f[k] === false || String(f[k]).trim() === '' ? null : String(f[k]).trim().replace(/,/g, ''));
  const b = (k) => f[k] === true || f[k] === 'on';
  const uiErrors = [];
  const int = (k, label, min = 0) => {
    const v = s(k); if (v === null) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) { uiErrors.push(`${label}: ${min} 이상 정수`); return null; }
    return n;
  };
  const asset = s('asset') ?? 'DAI';
  const amount = s('amount');
  if (amount === null) uiErrors.push('금액: 양수 필수');
  const raw = {
    asset, amount, startDate: s('startDate'),
    funding: s('funding') ?? FUNDING.SELF, reserveDai: s('reserveDai') ?? '0', totalBudgetDai: s('totalBudgetDai'),
    horizonYears: Number(s('horizonYears') ?? 3), periodMode: s('periodMode') ?? 'CALENDAR', priceModel: s('priceModel') ?? 'LINEAR',
  };
  if (asset === 'LGNS') {
    raw.lgnsChain = s('lgnsChain');
    raw.route = s('route') ?? routesFor(raw.lgnsChain)[0];
    raw.costBasis = raw.route === ROUTES.ANUBIS_LGNS_BURN ? 'FIXED_ONE_DAI' : s('costBasis') ?? 'OPPORTUNITY';
    raw.acquisitionCostDai = s('acquisitionCostDai');
    raw.lgnsPriceDai = s('lgnsPriceDai');
    raw.lgnsNetSaleDai = s('lgnsNetSaleDai');
    if (raw.route === ROUTES.POLYGON_FIXED) {
      const hours = s('fixed.periodHours');
      let periodSeconds = null;
      if (hours !== null) { const h = Number(hours); if (!(h > 0)) uiErrors.push('지급 주기(시간): 양수'); else periodSeconds = Math.round(h * 3600); }
      raw.fixed = {
        recognizedDaiPerLgns: s('fixed.recognizedDaiPerLgns'), totalPayoutCapBps: s('fixed.totalPayoutCapBps'),
        payoutBpsPerPeriod: s('fixed.payoutBpsPerPeriod'), periodSeconds, payoutPriceDai: s('fixed.payoutPriceDai'),
        payoutPriceSource: s('fixed.payoutPriceSource'), stopDate: s('fixed.stopDate'),
      };
      for (const k of ['totalPayoutCapBps', 'payoutBpsPerPeriod']) {
        const v = raw.fixed[k];
        if (v !== null && !/^\d+(\.\d+)?$/.test(v)) uiErrors.push(`FIXED ${k === 'totalPayoutCapBps' ? '총 지급상한' : '지급률'}: 0 이상 숫자(소수 bps 가능)`);
      }
    }
  }
  const fxMode = s('fx.mode');
  if (asset === 'KRW' || fxMode) {
    raw.fx = { mode: fxMode, daiKrw: s('fx.daiKrw'), daiUsd: s('fx.daiUsd'), usdKrw: s('fx.usdKrw'),
      spreadBps: s('fx.spreadBps'), withdrawFeeKrw: s('fx.withdrawFeeKrw') ?? '0', source: s('fx.source'), fixedRateAssumption: true };
  }
  if (raw.funding === FUNDING.EXTERNAL) raw.externalBudget = { dailyDai: s('ext.dailyDai'), totalDai: s('ext.totalDai') };
  raw.engine = {
    annualRateBps: int('engine.annualRateBps', '연 배출률'), turbineFeeBps: s('engine.turbineFeeBps'), sellTaxBps: s('engine.sellTaxBps'),
    priceDaiPerAilgns: s('engine.priceDaiPerAilgns'), poolDepthDai: s('engine.poolDepthDai'),
    poolFeeBps: s('engine.poolFeeBps'), feeIncludedInQuote: b('engine.feeIncludedInQuote'),
    entryLagDays: int('engine.entryLagDays', '진입 편입 지연') ?? 1, reburnLagDays: int('engine.reburnLagDays', '재소각 편입 지연') ?? 1,
    immediateBps: s('engine.immediateBps'), ignoreBurnCaps: b('engine.ignoreBurnCaps'),
    lgnsBurnOpenFromDay: int('engine.lgnsBurnOpenFromDay', 'LGNS 소각 재개일'),
    allowPartialActivation: b('engine.allowPartialActivation'), returnCashAtEnd: b('engine.returnCashAtEnd'),
    gas: { anubisNativeDai: s('gas.anubisNativeDai') ?? '0', polygonNativeDai: s('gas.polygonNativeDai') ?? '0', autoRefillFromCash: b('gas.autoRefillFromCash') },
  };
  return { raw, uiErrors };
}

/** 폼 → 정책. 고정 비율은 0.01% 단위까지 bps 정수로 보존. */
export function formToPolicy(f, horizonN) {
  const errors = [];
  if ((f.policyType ?? 'ratio') === 'switch') {
    const n = Number(String(f.switchDay ?? '').trim());
    if (!Number.isInteger(n) || n < 0 || (horizonN !== undefined && n > horizonN)) { errors.push(`전환일 N: 0~${horizonN ?? '기간'} 정수`); return { policy: null, errors }; }
    return { policy: { switchDay: n }, errors };
  }
  const pct = Number(f.recyclePct ?? 0);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) { errors.push('재순환 비율: 0~100%'); return { policy: null, errors }; }
  return { policy: { recycleBps: Math.round(pct * 100) }, errors };
}
export const policyLabel = (p) => (!p ? 'N/A' : p.switchDay !== undefined && p.switchDay !== null ? `${p.switchDay}일 전액 재순환 → 이후 현금화` : `재순환 ${fmtBpsPct(p.recycleBps)} · 현금화 ${fmtBpsPct(10000 - p.recycleBps)}`);

/**
 * 간단 화면 → 기존 폼 계약. 보상 사용법 프리셋을 정책 필드로 정확히 옮긴다.
 *  sell=고정 재순환 0%, partial=고정 재순환 recyclePct%, switch=N일 전액 재순환 후 현금화.
 * 원화 시작에서 환율 방식을 고르지 않았으면 직접 입력한 DAI/KRW(MANUAL)를 쓴다. 값이 없으면 schema가 오류로 막는다(임의 환율 없음).
 */
export function applySimpleForm(f) {
  const g = { ...f };
  if (g.reserveMode === undefined) g.reserveMode = 'AUTO';
  if (g['engine.ignoreBurnCaps'] === undefined) g['engine.ignoreBurnCaps'] = true;
  // 시작 자산 그룹(현금 DAI·원화 / LGNS) + 입력 통화 → 엔진 asset. 그룹 필드가 없으면 기존 asset 그대로.
  if (g.assetGroup) g.asset = g.assetGroup === 'LGNS' ? 'LGNS' : g.currency === 'KRW' ? 'KRW' : 'DAI';
  if (g.usage === 'sell') { g.policyType = 'ratio'; g.recyclePct = '0'; }
  else if (g.usage === 'partial') g.policyType = 'ratio';
  else if (g.usage === 'switch') g.policyType = 'switch';
  if (g.asset === 'KRW' && !g['fx.mode'] && g['market.fx'] !== 'AUTO') g['fx.mode'] = 'MANUAL';
  return g;
}

// ---- 원화 금액 자릿수 쉼표(표시만; 계산은 formToRaw가 쉼표 제거) ----
const NUMLIKE = /^-?[\d,]*(\.\d*)?$/;
/** "10000000" → "10,000,000". 소수·음수 부호 유지. 숫자 형식이 아니면 그대로 둬 검증이 오류를 보이게 한다. */
export function groupDigits(s) {
  if (typeof s !== 'string' || !NUMLIKE.test(s) || !/\d/.test(s)) return s;
  const neg = s.startsWith('-'), body = (neg ? s.slice(1) : s).replace(/,/g, '');
  const dot = body.indexOf('.');
  const ip = dot < 0 ? body : body.slice(0, dot), fp = dot < 0 ? null : body.slice(dot + 1);
  return (neg ? '-' : '') + ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fp === null ? '' : '.' + fp);
}
export const stripGrouping = (s) => (typeof s === 'string' ? s.replace(/,/g, '') : s);
/** 커서 앞의 쉼표 아닌 글자 수. */
export const charsBeforeCaret = (s, caret) => s.slice(0, Math.max(0, caret)).replace(/,/g, '').length;
/** 쉼표 아닌 글자 n개 뒤의 위치(서식 변경 후 커서 복원). */
export function caretAfterChars(s, n) {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < s.length; i++) { if (s[i] !== ',') seen++; if (seen === n) return i + 1; }
  return s.length;
}
/** 입력값을 서식화하고 새 커서 위치를 돌려준다(DOM 없이 테스트 가능). */
export function reformatWithCaret(value, caret, grouped) {
  const next = grouped ? groupDigits(value) : stripGrouping(value);
  if (next === value) return { value, caret };
  return { value: next, caret: caretAfterChars(next, charsBeforeCaret(value, caret)) };
}

/** 준비금 요약(예시 문구용). 예시 조건과 같으면 isExample. */
export function reserveSummary(f) {
  const n = (k) => { const v = Number(String(f[k] ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : 0; };
  const reserve = n('reserveDai'), gas = n('gas.anubisNativeDai');
  const isExample = Object.entries(EXAMPLE_VALUES).every(([k, v]) => String(f[k] ?? '') === String(v));
  return { reserve, gas, total: reserve + gas, isExample };
}

/**
 * 시세 모드 적용. 모드 필드: market.fx(AUTO/MANUAL), market.ailgns(AUTO/SNAPSHOT/MANUAL), market.lgns(AUTO/MANUAL).
 * 모드 필드가 없으면(이전 계약) 폼 값을 그대로 쓴다. AUTO 값은 같은 폼 필드에 10진 문자열로 넣어 수동 경로와 같은 정규화를 거친다.
 * AUTO 원화 시세가 없으면 원화 계산을 막는다(수동값으로 몰래 대체하지 않음). AiLGNS AUTO 실패는 계산을 중단하며 저장 TWAP으로 대체하지 않는다.
 */
export function applyMarket(f, market, nowMs = Date.now()) {
  const g = { ...f }, errors = [], use = {};
  const legs = market?.legs ?? {};
  const t = (l) => (l?.fetchedAt ? kstTimeShort(l.fetchedAt) : '');
  const fxMode = f['market.fx'], ailMode = f['market.ailgns'], lgMode = f['market.lgns'];
  if (fxMode === 'AUTO') {
    if (usableLeg(legs.fx, nowMs) && usableLeg(legs.daiUsdt, nowMs) && usableLeg(legs.upbit, nowMs)) {
      // 파생 DAI/KRW 하나만 DIRECT 값으로 넘긴다. USD 칸(daiUsd/usdKrw)에 USDT 값을 넣지 않는다(복사본에서만 비움).
      g['fx.mode'] = 'DIRECT'; g['fx.daiKrw'] = formatUnits(BigInt(legs.fx.value), 18);
      g['fx.daiUsd'] = ''; g['fx.usdKrw'] = '';
      g['fx.source'] = `${FX_LABEL} · ${t(legs.fx)}`;
      use.fx = { mode: 'AUTO', status: 'OK', value: legs.fx.value, label: FX_LABEL, fetchedAt: legs.fx.fetchedAt,
        components: { daiUsdt: { value: legs.daiUsdt.value, unit: 'USDT/DAI', blockNumber: legs.daiUsdt.source?.blockNumber ?? null, pair: legs.daiUsdt.source?.pair ?? null },
          usdtKrw: { value: legs.upbit.value, unit: 'KRW/USDT', market: legs.upbit.source?.market ?? null, tickerTimestamp: legs.upbit.source?.tickerTimestamp ?? null } } };
    } else {
      if (g.asset === 'KRW' || f.requireLive) errors.push(market?.loading ? '원화 환율을 불러오는 중입니다.' : '최신 DAI/KRW 환율을 조회해야 계산할 수 있습니다. 잠시 뒤 새로 조회하세요.');
      g['fx.mode'] = ''; g['fx.daiKrw'] = ''; g['fx.daiUsd'] = ''; g['fx.usdKrw'] = '';
      use.fx = { mode: 'AUTO', status: 'UNAVAILABLE', error: legs.fx?.error ?? (market?.loading ? 'loading' : '시세 없음') };
    }
  } else if (g.asset === 'KRW') use.fx = { mode: fxMode ?? 'FORM', status: 'MANUAL' };
  if (ailMode === 'AUTO') {
    if (usableLeg(legs.ailgns, nowMs)) { g['engine.priceDaiPerAilgns'] = formatUnits(BigInt(legs.ailgns.value), 18); use.ailgns = { mode: 'AUTO', source: 'SPOT', value: legs.ailgns.value, fetchedAt: legs.ailgns.fetchedAt, blockNumber: legs.ailgns.source?.blockNumber ?? null }; }
    else { g['engine.priceDaiPerAilgns'] = ''; use.ailgns = { mode: 'AUTO', source: 'UNAVAILABLE' }; errors.push('최신 AiLGNS 시세를 조회해야 계산할 수 있습니다. 저장 TWAP으로 대체하지 않습니다.'); }
  } else if (ailMode === 'SNAPSHOT') { g['engine.priceDaiPerAilgns'] = ''; use.ailgns = { mode: 'SNAPSHOT', source: 'SAVED_TWAP' }; }
  else if (ailMode === 'MANUAL') {
    if (!String(f['engine.priceDaiPerAilgns'] ?? '').trim()) errors.push('AiLGNS 가격을 직접 입력하거나 ‘실시간’으로 바꾸세요.');
    use.ailgns = { mode: 'MANUAL', source: 'USER' };
  }
  if (g.asset === 'LGNS' && lgMode === 'AUTO') {
    const l = g.lgnsChain === 'anubis' ? legs.lgnsAnubis : legs.lgnsPolygon;
    if (usableLeg(l, nowMs)) { g.lgnsPriceDai = formatUnits(BigInt(l.value), 18); use.lgns = { mode: 'AUTO', status: 'OK', key: l.key, value: l.value, fetchedAt: l.fetchedAt, blockNumber: l.source?.blockNumber ?? null }; }
    else { g.lgnsPriceDai = ''; use.lgns = { mode: 'AUTO', status: 'UNAVAILABLE', error: l?.error ?? '시세 없음' }; if (f.requireLive) errors.push('최신 LGNS 시세를 조회해야 계산할 수 있습니다.'); }
  } else if (g.asset === 'LGNS' && lgMode === 'MANUAL') use.lgns = { mode: 'MANUAL', status: 'USER' };
  return { f: g, errors, use };
}

/** 전체 계산. 입력 오류는 {errors}로 돌려주고 던지지 않는다. market는 선택(applyMarket 참고). */
export function compute(f0, snapshot, market = null, nowMs = Date.now()) {
  const m = applyMarket(f0, market, nowMs), f = m.f;
  const { raw, uiErrors: ue } = formToRaw(f);
  const uiErrors = [...m.errors, ...ue, ...(f0.requireLive ? liveCalculationErrors(snapshot, nowMs) : [])];
  if (f0.requireLive && raw.startDate < kstDate(Math.floor(nowMs / 1000))) uiErrors.push('현재 기준 계산의 시작 날짜는 오늘 이후여야 합니다.');
  let scenario;
  try { scenario = normalizeInput(raw); }
  catch (e) { return { errors: [...uiErrors, ...(e.errors ?? [`${e.name === 'InputError' ? '' : '계산 모듈 오류: '}${e.message}`])], raw }; }
  const N = horizonDays(scenario.startDate, scenario.horizonYears, scenario.periodMode);
  const { policy, errors: pErr } = formToPolicy(f, N);
  if (uiErrors.length || pErr.length) return { errors: [...uiErrors, ...pErr], raw };
  try {
    const quote = getEntryQuote(scenario, snapshot);
    const result = simulate(scenario, snapshot, policy);
    if (m.use.ailgns?.source === 'SPOT') result.summary.params.price = `MARKET/OBSERVED · ${m.use.ailgns.fetchedAt} · block ${m.use.ailgns.blockNumber ?? '?'}`;
    return { errors: [], raw, scenario, quote, result, policy, budget: compareBudget(scenario, result), marketUse: m.use };
  } catch (e) { return { errors: [`계산 불가: ${e.message}`], raw }; }
}

/**
 * 비교·운전자금 탐색에 쓰는 총 초기예산. 입력이 없으면 현재 장부의 초기 투입
 * (원금+운전자금+가스 잔액, summary.initialCapitalDai)으로 고정한다. 원금 미확정이면 null.
 */
export function compareBudget(scenario, result) {
  if (scenario.totalBudgetDai !== null) return { value: scenario.totalBudgetDai, derived: false };
  const v = result?.summary?.initialCapitalDai ?? null;
  return { value: v, derived: true };
}
export const withBudget = (scenario, budget) => ({ ...scenario, totalBudgetDai: budget?.value ?? scenario.totalBudgetDai });

/** summary.resultClass/modelCompleted → 사용자 문구. liveExecutable=false는 '실측 경로 미검증'만 표시. */
export function resultStatus(sm) {
  if (!sm) return { key: 'INPUT', text: '입력 확인 필요' };
  const cls = sm.resultClass ?? (sm.modelCompleted ?? sm.completed ? 'CONDITIONAL_MODEL' : 'INCOMPLETE');
  const text = { CONDITIONAL_MODEL: '조건부 계산 완료', INCOMPLETE: '일부 보류', REGRESSION: '회귀 검산 전용' }[cls] ?? '입력 확인 필요';
  return { key: cls, text, liveNote: sm.liveExecutable === true ? '실측 경로 검증됨' : '실측 경로 미검증' };
}
export function resultStatusText(sm) {
  const r = resultStatus(sm);
  const t = r.key === 'CONDITIONAL_MODEL' ? r.text : `<span class="warn">${esc(r.text)}</span>`;
  return `${t}${r.liveNote ? ` · ${esc(r.liveNote)}` : ''}.`;
}

/** 현금·ROI를 정상 결과로 제시해도 되는 장부인지 판정한다. */
export function cashResultReady(out) {
  const sm = out?.result?.summary;
  return !!sm && sm.modelCompleted === true && sm.resultClass !== 'INCOMPLETE' && !out.result.failed;
}

/** 렌더러 공통 상태. 미완료 장부의 W/net/ROI는 진단값이며 정상 성과로 표시하지 않는다. */
export function cashPresentation(out) {
  if (!out || out.errors?.length || !out.result) return { ready: false, key: 'INPUT', title: '입력 확인 필요', blocking: null };
  if (!cashResultReady(out)) return { ready: false, key: 'INCOMPLETE', title: '계산 보류', blocking: blockingText(explainBlocking(out)) };
  return { ready: true, key: 'READY', title: '계산 완료', blocking: null };
}

/** 기록 r의 시점 정보: 정산 순번(1부터)과 시작일부터 실제 경과일. */
export function recordTiming(r, startDate) {
  const n = r.day + 1;
  const elapsed = r.date && startDate ? daysBetween(startDate, r.date) : null;
  return { settlementNo: n, elapsed, text: `${r.date ?? ''} · 정산 ${n}회차${elapsed === null ? '' : ` · 시작 후 ${elapsed}일`}` };
}

// ---- 라이브 갱신 병합: 실패한 값은 마지막 정상값을 STALE로 유지(원래 fetchedAt·block 보존) ----
export function mergeLive(lastGood, fresh, now = Date.now()) {
  const kept = [];
  const values = { ...fresh.values };
  for (const [k, v] of Object.entries(lastGood?.values ?? {})) {
    if ((!values[k] || values[k].value === null) && v.value !== null) {
      values[k] = { ...v, status: 'STALE', notes: `${v.notes ?? ''} (이번 조회 실패 — 이전 값 유지, 원 조회시각 ${v.fetchedAt ?? '미상'})`.trim() };
      kept.push(k);
    }
  }
  const { snapshot } = validateSnapshot({ ...fresh, values }, { now });
  if (kept.length) {
    snapshot.mode = 'STALE';
    snapshot.keptFromLastGood = kept;
    snapshot.issues = [...snapshot.issues, { level: 'warn', code: 'PARTIAL_STALE', msg: `조회 실패 ${kept.length}개 값은 이전 값(STALE) 유지` }];
  }
  const changed = Object.keys(values).filter((k) => lastGood?.values?.[k]?.value !== values[k]?.value);
  return { snapshot, kept, changed };
}

// ---- 차트 모델 (단일 장부) ----
export function chartModel(result, { roiView = false } = {}) {
  const d = result.daily;
  const n18 = (v) => toNum(v);
  // 표식은 마일스톤이 읽는 장부 행(record.day)에 둔다. charts.js는 day-1 index를 쓴다.
  const markers = result.summary.milestones.filter((m) => m.record).map((m) => ({ day: (m.record?.day ?? m.day - 1) + 1, label: m.label }));
  if (result.summary.paybackDay !== null && result.summary.paybackDay !== undefined) {
    markers.push({ day: Number(result.summary.paybackDay) + 1, label: '원금 회수', kind: 'payback' });
  }
  const fmtD = (v) => fmtCompact(v);
  return {
    n: d.length, dailyDai: d.map(r => n18(r.emissionDai)), dates: d.map((r) => r.date ?? `D${r.day + 1}`), markers,
    charts: [
      { id: 'cash-power', title: '누적 실제 현금 회수와 활성 POWER', unit: 'DAI', fmt: fmtD,
        rightAxis: { label: 'POWER', fmt: fmtD }, series: [
        { key: 'cumWithdrawal', label: '누적 실제 현금', cls: 's-teal', type: 'step', values: d.map((r) => n18(r.cumWithdrawal)) },
        { key: 'cumEmissionDai', label: '누적 보상 DAI 가치', cls: 's-teal2', type: 'step', values: d.map((r) => n18(r.cumEmissionDai)) },
        { key: 'activePowerEnd', label: '활성 POWER', cls: 's-navy', type: 'step', axis: 'right', values: d.map((r) => n18(r.activePowerEnd)) },
      ] },
      { id: 'daily', title: '하루 배출 DAI 가치와 하루 실제 현금', unit: 'DAI', fmt: fmtD, series: [
        { key: 'emissionDai', label: '하루 배출 DAI 가치', cls: 's-teal2', type: 'step', values: d.map((r) => n18(r.emissionDai)) },
        { key: 'withdrawal', label: '하루 실제 현금', cls: 's-navy', type: 'bar', values: d.map((r) => n18(r.externalWithdrawal - (r.endReturnDai ?? 0n))) },
      ] },
      roiView
        ? { id: 'roi', title: '현금 ROI (%)', fmt: (v) => `${fmtN(v, 0)}%`, series: [
          { key: 'roi', label: '현금 ROI', cls: 's-navy', type: 'step', values: d.map((r) => { const b = roiBpsOf(r.net, r.I); return b === null ? null : b / 100; }) },
        ] }
        : { id: 'cum', title: '누적 투입 · 누적 현금 회수 · 현금 순손익 (DAI)', fmt: fmtD, series: [
          { key: 'I', label: '누적 총투입', cls: 's-slate', type: 'step', values: d.map((r) => n18(r.I)) },
          { key: 'cumWithdrawal', label: '누적 현금 회수', cls: 's-teal', type: 'step', values: d.map((r) => n18(r.cumWithdrawal)) },
          { key: 'net', label: '현금 순손익', cls: 's-navy', type: 'step', values: d.map((r) => n18(r.net)) },
        ] },
    ],
  };
}

// ---- 장부 열 정의 (CSV·표 공통). 값은 원단위 문자열로 내보낸다. ----
export const LEDGER_COLUMNS = [
  ['day', '정산 회차', (r) => String(r.day + 1)], ['date', '날짜(KST)', (r) => r.date ?? ''],
  ['activePowerStart', '기초 활성 Power'], ['newActivePower', '신규 활성 Power'], ['consumedPower', '소진 Power'], ['activePowerEnd', '기말 활성 Power'],
  ['pendingPower', '대기 Power'], ['emissionAilgns', '배출 AiLGNS'], ['emissionDai', '정산 DAI 가치'], ['price', 'AiLGNS 가격'],
  ['credits', '미처리 크레딧'], ['lockedAilgns', '잠금 AiLGNS'], ['spendableAilgns', '매도가능 AiLGNS'],
  ['turbineBuyDai', '터빈 매수 DAI'], ['turbineFeeDai', '터빈 수수료 DAI'], ['sellTaxTokens', '매도세 AiLGNS'], ['poolFeeDai', '풀 수수료 DAI'], ['gasDai', '가스 DAI'],
  ['coverSaleTokens', '비용충당 매도 AiLGNS'], ['coverSaleDai', '비용충당 매도 DAI'], ['reserveSaleTokens', 'reserve 매도 AiLGNS'], ['reserveSaleDai', 'reserve 매도 DAI'],
  ['burnTokens', '재소각 AiLGNS'], ['newPendingPower', '신규 대기 Power'], ['withdrawSaleTokens', '현금화 매도 AiLGNS'],
  ['externalTopup', '외부 투입 DAI'], ['externalWithdrawal', '외부 인출 DAI'], ['cumTopup', '누적 외부 투입'], ['cumWithdrawal', '누적 현금 회수'],
  ['I', '누적 총투입'], ['net', '현금 순손익'], ['unrecovered', '미회수 원금'], ['cash', '내부 DAI'], ['nativeAnubis', 'Anubis 가스 잔액'],
  ['requestedRecycleBps', '요청 재순환 bps', (r) => String(r.requestedRecycleBps ?? '')], ['executedRecycleBps', '실행 재순환 bps', (r) => (r.executedRecycleBps === null ? '' : String(r.executedRecycleBps))],
  ['lgnsWaiting', 'LGNS 소각 대기', (r) => (r.lgnsWaiting === undefined ? '' : formatUnits(r.lgnsWaiting, 9))],
];
const cellRaw = (r, col) => (col[2] ? col[2](r) : r[col[0]] === null || r[col[0]] === undefined ? '' : formatUnits(r[col[0]], 18));
const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function ledgerToCsv(daily) {
  const head = LEDGER_COLUMNS.map((c) => csvCell(c[1])).join(',');
  return '﻿' + [head, ...daily.map((r) => LEDGER_COLUMNS.map((c) => csvCell(cellRaw(r, c))).join(','))].join('\n') + '\n';
}
export const jsonReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'function' ? undefined : v);
export function buildExport({ raw, scenario, quote, result, policy, snapshot, changelog, budget, marketUse, market }) {
  return {
    marketUse: marketUse ?? null,
    market: market ? { mode: market.mode, fetchedAt: market.fetchedAt, note: market.note, legs: market.legs } : null,
    exportVersion: 'helix-sim-export/1', generatedAt: new Date().toISOString(),
    label: result.summary.label, costBasis: result.summary.costBasis, policy, policyLabel: policyLabel(policy),
    compareBudget: budget ? { value: budget.value, derived: budget.derived, rule: budget.derived ? '원금+운전자금+가스 잔액 합으로 고정' : '사용자 입력' } : null,
    resultClass: result.summary.resultClass ?? null, modelCompleted: result.summary.modelCompleted ?? null,
    liveExecutable: result.summary.liveExecutable ?? null, liveBlockers: result.summary.liveBlockers ?? [], statusText: resultStatus(result.summary).text,
    note: '미래 값은 조건부 가정 모형. 저장/조회 입력값을 썼어도 미래 지급은 실측 아님.',
    rawInput: raw, scenario, entryQuote: quote,
    snapshot: { schemaVersion: snapshot.schemaVersion, mode: snapshot.mode, meta: snapshot.meta, ageSeconds: snapshot.ageSeconds, values: snapshot.values, issues: snapshot.issues },
    summary: result.summary, warnings: result.warnings, failed: result.failed, events: result.events, daily: result.daily, changelog,
  };
}

/** 첫 활성/첫 정산/회수 상태 등 요약 파생값. */
export function derive(result) {
  const d = result.daily;
  const firstActive = d.find((r) => r.newActivePower > 0n) ?? null;
  const firstEmission = d.find((r) => r.emissionDai > 0n) ?? null;
  const last = d[d.length - 1] ?? null;
  const pb = result.summary.paybackDay;
  const settleCount = (uptoIdx) => { let c = 0; for (let i = 0; i <= uptoIdx && i < d.length; i++) if (d[i].emissionDai > 0n) c++; return c; };
  return { firstActive, firstEmission, last, payback: pb === null ? null : d[pb], settleCount };
}

/** 셀렉터 비교 행(고정 후보; 최적화 아님). */
export const QUICK_POLICIES = [{ recycleBps: 0 }, { recycleBps: 5000 }, { recycleBps: 10000 }];

/** 3·6·12개월 카드(같은 장부의 마일스톤 행). 2·3년은 자세히 표에만. */
export function milestoneCards(result) {
  return result.summary.milestones.filter((m) => m.months <= 24).map((m) => ({ label: m.label, date: m.record?.date ?? m.date, periodEnd: m.date, record: m.record ?? null }));
}

/**
 * 모바일 즉시 요약(금액 바로 아래). milestoneCards와 같은 장부 행. 입력 오류면 null(이전 숫자 표시 금지).
 * KRW 시작이면 원화가 주 표시(같은 환율 가정), 그 외는 DAI.
 */
export function quickSummaryRows(out) {
  if (!out || out.errors?.length || !out.result || !cashResultReady(out)) return null;
  const rate = out.scenario?.asset === 'KRW' ? krwRate(out.scenario) : null;
  return milestoneCards(out.result).map((c) => {
    const r = c.record;
    if (!r) return { label: c.label, date: c.date, available: false };
    const roiBps = roiBpsOf(r.net, r.I);
    return { label: c.label, date: c.date, available: true, cashDai: r.cumWithdrawal, roiBps,
      primary: rate ? fmtKrw(r.cumWithdrawal, rate) : fmtDai(r.cumWithdrawal, 0), secondary: rate ? fmtDai(r.cumWithdrawal, 0) : '', roi: fmtBpsPct(roiBps) };
  });
}

/** 수익률 분모 설명(summary.I = 시작 투입 + 누적 추가 입금). 입력 오류면 null. */
export function quickSummaryBasis(out) {
  if (!out || out.errors?.length || !out.result) return null;
  const sm = out.result.summary, rate = out.scenario?.asset === 'KRW' ? krwRate(out.scenario) : null;
  const I = sm.I ?? null, initial = sm.initialCapitalDai ?? null, topups = sm.topups ?? 0n;
  const parts = ['원금', '준비금(운전자금+가스)'];
  if (out.scenario?.funding === 'EXTERNAL') parts.push('추가 입금');
  const amt = rate ? `${fmtKrw(I, rate)} (${fmtDai(I, 0)})` : fmtDai(I, 0);
  return { I, initial, topups, text: `수익률 기준 총투입 ${amt} = ${parts.join(' + ')}${out.scenario?.funding === 'EXTERNAL' ? ` (추가 입금 ${fmtDai(topups, 0)})` : ''}` };
}

/** 현금 DAI를 선택한 현재 AiLGNS 가격으로 나눈 참고 수량. 실제 토큰 수령량과 합산하지 않는다. */
export function cashAiEquivalent(cashDai, priceDaiPerAilgns) {
  const cash = B(cashDai), price = B(priceDaiPerAilgns);
  return cash === null || price === null || price <= 0n ? null : wdiv(cash, price);
}

/** 금액 입력 직후 보여 주는 환산·POWER 상태. 잠재량과 장부상 활성/대기를 명시적으로 분리한다. */
export function conversionSummary(out) {
  if (!out || out.errors?.length || !out.result || !out.quote) return null;
  const { scenario: s, quote: q, result } = out;
  const first = result.daily[0] ?? null;
  const rate = krwRate(s);
  const daiValue = s.asset === 'LGNS' ? q.marketValueDai : q.entryDai;
  const blockedCap0 = q.routeStatus === 'BLOCKED_CAP0';
  const observedCap0 = s.asset === 'LGNS' && q.burnCaps?.lgns?.value === '0';
  const capIgnored = observedCap0 && q.burnCaps?.ignoredForCalculation;
  const activePower = first?.activePowerEnd ?? 0n;
  const pendingPower = first?.pendingPower ?? 0n;
  let powerNote = activePower > 0n ? '장부 첫날 활성 POWER' : pendingPower > 0n
    ? `첫날은 대기 POWER이며 편입 지연 ${s.engine.entryLagDays}일 가정 뒤 활성됩니다.`
    : '장부 첫날 활성 POWER 0';
  if (blockedCap0) powerNote = 'LGNS 소각 일일 한도 0: 잠재 계산값일 뿐, 활성 POWER로 계산하지 않습니다.';
  else if (capIgnored) powerNote += ' 현재 관측 LGNS 소각 한도는 0이지만 계산에서는 한도를 제외했습니다(미래 가정, 실거래 가능 확인 아님).';
  return {
    asset: s.asset, daiValue, krwValue: rate && daiValue !== null ? wmul(daiValue, rate) : null,
    marketValueDai: q.marketValueDai, potentialPower: q.powerPreview ?? q.assumedPowerPreview,
    activePower, pendingPower, blockedCap0, observedCap0, capIgnored, burnCaps: q.burnCaps, powerStatus: q.powerStatus, powerNote,
  };
}

/** 대표 정산 회차. 요청 회차를 horizon으로 자르고 마지막 날을 한 번만 포함한다. */
export function daySampleRows(result) {
  const daily = result?.daily ?? [], N = daily.length;
  if (!N) return [];
  const days = [...new Set([1, 30, 90, 180, 360, 600, 730, 1095].filter((d) => d <= N).concat(N))].sort((a, b) => a - b);
  return days.map((day) => {
    const r = daily[day - 1];
    return { day, date: r.date, emissionDai: r.emissionDai, emissionAilgns: r.emissionAilgns,
      dailyCashDai: r.externalWithdrawal - (r.endReturnDai ?? 0n), activePower: r.activePowerEnd, pendingPower: r.pendingPower };
  });
}

/** 단일 전환 정책의 실제 사건 날짜. N은 정산 인덱스 경계이고 날짜는 장부/사건에서 읽는다. */
export function switchPlanView(result, policy) {
  const N = Number(policy?.switchDay ?? 0), daily = result?.daily ?? [], events = result?.events ?? [];
  const burns = events.filter((e) => e.type === 'REBURN' && e.day < N);
  const lastBurn = burns.at(-1) ?? null;
  const firstCash = daily.find((r) => r.externalWithdrawal - (r.endReturnDai ?? 0n) > 0n) ?? null;
  return { switchDay: N, label: N === 0 ? '처음부터 현금화' : `처음 ${N}일 재투자 → 이후 현금화`,
    lastReburnDay: lastBurn ? lastBurn.day + 1 : null, lastReburnDate: lastBurn ? daily[lastBurn.day]?.date ?? null : null,
    firstCashDay: firstCash ? firstCash.day + 1 : null, firstCashDate: firstCash?.date ?? null };
}

/** 탭 하나만 그리는 모델(같은 장부·같은 커서 계약). tab: 0=누적 현금+POWER, 1=일별, 2=수익. */
export function singleChartModel(model, tab) {
  const i = Math.max(0, Math.min(model.charts.length - 1, Number(tab) || 0));
  return { ...model, charts: [model.charts[i]] };
}

// ================= DOM =================
const $ = (id) => document.getElementById(id);
const st = { snapshot: null, pending: null, out: null, charts: null, cursor: 0, pinned: null, changelog: [], prevFlat: null,
  market: { loading: true, legs: {} }, pendingMarket: null, liveLoading: false, fingerprintBaseline: PROTOCOL_BASELINE.fingerprint, startDateEdited: false,
  roiView: false, showMsDetail: false, tab: 0, ledgerPage: 0, evByDay: new Map(), inputValid: false,
  reserveAdvice: { job: 0, out: null, status: 'idle', plan: null },
  reserveAuto: { dirty: true },
  opt: { client: null, running: false, result: null, status: '', mainJob: 0, signal: null, hasRun: false, applied: null, rerunTimer: null } };

function readForm() {
  const form = $('inputs'), f = {};
  for (const elx of form.elements) {
    if (!elx.name) continue;
    if (elx.type === 'radio') { if (elx.checked) f[elx.name] = elx.value; }
    else if (elx.type === 'checkbox') f[elx.name] = elx.checked;
    else f[elx.name] = elx.value;
  }
  return { ...applySimpleForm(f), requireLive: true };
}
const setField = (name, value) => {
  const els = document.querySelectorAll(`#inputs [name="${name}"], [name="${name}"][form="inputs"]`);
  for (const e of els) { if (e.type === 'radio') e.checked = e.value === String(value); else if (e.type === 'checkbox') e.checked = !!value; else e.value = value; }
};

function syncVisibility(f) {
  const form = $('inputs');
  const show = (sel, ok) => form.querySelectorAll(sel).forEach((n) => { n.hidden = !ok(n); });
  show('[data-show]', (n) => n.dataset.show === f.asset);
  const costSelect = form.elements.costBasis;
  if (costSelect) {
    costSelect.disabled = f.asset === 'LGNS' && f.route === ROUTES.ANUBIS_LGNS_BURN;
    if (costSelect.disabled) costSelect.value = 'FIXED_ONE_DAI';
    else if (costSelect.value === 'FIXED_ONE_DAI') costSelect.value = 'OPPORTUNITY';
  }
  show('[data-show-cost]', (n) => n.dataset.showCost === f.costBasis);
  show('[data-show-route]', (n) => n.dataset.showRoute === f.route && (!n.classList.contains('burn-basis') || f.asset === 'LGNS'));
  show('[data-show-fx]', (n) => n.dataset.showFx.split(' ').includes(f['fx.mode']));
  show('[data-show-funding]', (n) => n.dataset.showFunding === f.funding);
  show('[data-show-usage]', (n) => n.dataset.showUsage === f.usage);
  show('[data-show-group]', (n) => n.dataset.showGroup === f.assetGroup);
  if (form.elements.asset && f.asset) form.elements.asset.value = f.asset;
  show('[data-show-krw]', () => (f.asset === 'KRW' && f['market.fx'] !== 'AUTO') || (f.asset !== 'KRW' && (f['fx.mode'] === 'DIRECT' || f['fx.mode'] === 'MANUAL')));
  show('[data-show-ail-manual]', () => f['market.ailgns'] === 'MANUAL');
  show('[data-show-lgns-manual]', () => f['market.lgns'] !== 'AUTO');
  $('amount-unit').textContent = f.asset === 'KRW' ? '원' : f.asset;
  if ($('recycle-out')) $('recycle-out').textContent = `${form.elements.recyclePct?.value ?? 0}%`;
  renderReserveLine(f);
  const sel = form.elements.route, want = routesFor(f.lgnsChain);
  if ([...sel.options].map((o) => o.value).join() !== want.join()) {
    sel.innerHTML = want.map((r) => `<option value="${r}">${esc(routeLabel(r))}</option>`).join('');
    sel.value = want[0]; f.route = want[0];
    show('[data-show-route]', (n) => n.dataset.showRoute === f.route && (!n.classList.contains('burn-basis') || f.asset === 'LGNS'));
  }
  $('route-hint').textContent = f.route === ROUTES.POLYGON_FIXED
    ? 'FIXED 단계 소각과 HELIX 단계 소각을 따로 기록합니다. 원금은 처음 가진 Polygon LGNS의 원가입니다.'
    : f.route === ROUTES.POLYGON_LGNS_SELL_DAI ? '보조 비교: 브리지 비용·지연 미검증.' : '';
  if ($('policy-hint')) {
    $('policy-hint').textContent = '터빈 비용만큼 먼저 매도하고, 남은 보상은 계산된 전환일까지 재소각한 뒤 현금화합니다.';
    $('policy-hint').title = '비용 충당 매도 후 남은 매도 가능한 AiLGNS(잠금분 제외) 기준';
  }
}

function renderReserveLine(f = readForm(), out = null) {
  const box = $('example-line'); if (!box) return;
  const rs = reserveSummary(f), mode = reserveModeOf(f);
  const current = out?.result?.summary?.initialCapitalDai ?? null;
  const autoState = mode === 'AUTO' && st.reserveAdvice.out === out && st.reserveAdvice.status === 'loading' ? ' · 금액·기간 기준 재산정 중' : '';
  const total = current !== null ? ` · 현재 총투입 ${fmtDai(current)}` : '';
  box.innerHTML = `<b>운전자금 ${mode}</b>${autoState} · 원금과 별도 ${esc(fmtN(rs.reserve, 2))} DAI + Anubis 가스 ${esc(fmtN(rs.gas, 2))} DAI${total}<br>
    <small>${mode === 'AUTO' ? '현재 매일 받기 경로와 선택 기간을 끝까지 실행하는 조건부 탐색값입니다. 전체 전략의 최소값은 아닙니다.' : '직접 입력값을 그대로 사용합니다.'} 중간 외부 추가 입금은 사용하지 않습니다.</small>
    <button type="button" class="link" data-open-settings="reserveDai">세부 설정</button>`;
}

/** LGNS 경로 상태(입력 칸 아래 한 줄). 막힘/검증대기면 세부 설정을 여는 버튼. */
function renderLgnsStatus() {
  const box = $('lgns-status');
  if (!box) return;
  const out = st.out, f = readForm();
  if (f.asset !== 'LGNS') { box.innerHTML = ''; return; }
  const open = (label) => ` <button type="button" class="link" data-open-settings="lgnsPriceDai">${label}</button>`;
  if (!out?.quote || out.scenario.asset !== 'LGNS') { box.className = 'notice warn'; box.innerHTML = `LGNS 값이 더 필요합니다.${open('세부 설정 열기')}`; return; }
  const q = out.quote, fx = out.result?.summary?.fixed;
  const lines = []; let needsInput = false;
  if (q.route === ROUTES.POLYGON_FIXED) {
    lines.push(fx?.enabled ? 'FIXED 값 입력됨 — 개방·지급은 오늘 미검증(가정)' : 'FIXED 경로 검증대기 — FIXED 값을 넣기 전에는 지급을 계산하지 않습니다');
    if (!fx?.enabled) needsInput = true;
  }
  if (q.burnCaps?.ignoredForCalculation) {
    const cv = (x) => x?.value === null ? '조회 불가' : x.value === '0' ? '0' : '양수';
    lines.push(`현재 관측 소각 한도 LGNS ${cv(q.burnCaps.lgns)} · AiLGNS ${cv(q.burnCaps.ailgns)} — 계산에서는 두 한도를 제외(미래 가정, 실행 가능 확인 아님)`);
  } else if (q.routeStatus === 'BLOCKED_CAP0' || q.issues.some((x) => /한도 0/.test(x))) {
    lines.push('Anubis LGNS 소각 한도 0 — 재개일을 넣기 전에는 대기'); needsInput = true;
  }
  if (q.economicCostDai === null) { lines.push('원가 미확정 — 순매도 견적 또는 매입원가 필요'); needsInput = true; }
  const blocked = lines.length > 0;
  box.className = blocked ? 'notice warn' : 'notice';
  box.innerHTML = blocked ? `${lines.map(esc).join('<br>')}${needsInput ? open('세부 설정에서 입력') : ''}` : esc(`${routeLabel(q.route)} · 상태 ${q.routeStatus}`);
}

function openSettings(name) {
  $('input-details').open = true;
  const d = $('settings'); d.open = true;
  const el = name ? $('inputs').querySelector(`[name="${name}"]`) : null;
  if (el && !el.closest('[hidden]')) { el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); }
  else d.scrollIntoView({ block: 'start' });
}

// ---- A. 기준 데이터 ----
const kstTime = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return 'N/A'; return new Date(t + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' KST'; };
const ageText = (s) => (s === null || s === undefined ? '?' : s < 120 ? `${s}초 전` : s < 7200 ? `${Math.round(s / 60)}분 전` : s < 172800 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`);
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;

function renderDataBar() {
  const s = st.snapshot ? validateSnapshot(st.snapshot).snapshot : null;
  if (!s) { $('data-status').innerHTML = `${badge('UNAVAILABLE')} 스냅샷 없음 — 가정 영역에 값을 직접 입력하세요`; return; }
  const v = (k) => s.values?.[k]?.value ?? null;
  const modeLabel = { SAVED: '저장 데이터', LIVE: '실시간 조회', STALE: '조회값(오래됨)', PARTIAL: '일부만 갱신', MANUAL: '저장 데이터 없음', UNAVAILABLE: '조회 실패' }[s.mode] ?? s.mode;
  const issues = (s.issues ?? []).filter((i) => i.level !== 'info');
  const errs = issues.filter((i) => i.level === 'error');
  $('data-status').innerHTML = `${badge(s.mode)} ${esc(modeLabel)} · ${esc(kstTime(s.meta?.fetchedAt))} (${esc(ageText(Math.floor((Date.now() - Date.parse(s.meta?.fetchedAt)) / 1000)))})`
    + (errs.length ? ` · <span class="warn">데이터 오류 ${errs.length}건</span>` : '');
  for (const [field, key] of [['engine.annualRateBps','annualRateBps'],['engine.turbineFeeBps','turbineFeeBps'],['engine.sellTaxBps','sellFeeBps']]) {
    const input = $('inputs').elements[field]; if (input) input.placeholder = v(key) == null ? '최신 조회 필요' : `${v(key)} bps · 최신 조회값`;
  }
  $('data-detail').innerHTML = [
    `Anubis 블록 <b>${s.meta?.blockNumber != null ? fmtN(s.meta.blockNumber, 0) : 'N/A'}</b>`,
    `dApp 정산일 <b>${esc(v('dappDay') ?? 'N/A')}</b>`,
    s.meta?.fingerprint ? `체인 ${esc(s.meta.fingerprint.chainId)} · 코드 지문 ${Object.entries(s.meta.fingerprint.contracts ?? {}).map(([a, v]) => `${esc(a.slice(0, 8))}… ${esc(v.codeHash ?? "조회 실패")}`).join(" / ")}` : '',
    `코드 지문 기준 블록 ${PROTOCOL_BASELINE.blockNumber} · 관측 지문 대조이며 동작·보안 검증은 아님`,
    s.mode === 'LIVE' ? '' : '실시간 아님 · 체인 값은 관측값(OBSERVED, 의미 미검증)',
    ...issues.map((i) => `<span class="${i.level === 'error' ? 'warn' : ''}">${esc(i.msg)}</span>`),
  ].filter(Boolean).join('<br>');
  $('btn-apply').disabled = !(st.pending || st.pendingMarket);
  $('btn-apply').hidden = !(st.pending || st.pendingMarket);
}

/** 시장 시세 조회. 첫 조회(applyNow)는 바로 계산에 반영, 이후 조회는 pending → '이 값으로 다시 계산'. */
async function loadMarket({ applyNow = false } = {}) {
  let fresh;
  try { fresh = await fetchMarket(); } catch (e) { fresh = { mode: 'MARKET', fetchedAt: new Date().toISOString(), legs: {}, error: e.message }; }
  const merged = mergeMarket(st.market?.loading ? null : st.market, fresh);
  const okCount = Object.values(merged.legs).filter((l) => l.status === 'OK').length;
  if (applyNow) { st.market = merged; st.reserveAuto.dirty = true; logChange([`시장 시세 반영(${kstTimeShort(merged.fetchedAt)}): 성공 ${okCount}/${Object.keys(merged.legs).length}`]); recompute(); }
  else st.pendingMarket = merged;
  return { merged, okCount };
}

async function doLive() {
  if (st.liveLoading) return;
  st.liveLoading = true;
  if (!st.startDateEdited) setField('startDate', todayKst());
  const rerun = st.opt.hasRun;
  const btn = $('btn-live'); btn.disabled = true;
  $('data-pending').textContent = '프로토콜·시장 시세 조회 중… 완료되면 자동 반영합니다.';
  const base = { ...st.snapshot, meta: { ...st.snapshot?.meta, fingerprint: st.fingerprintBaseline } };
  try {
    const [proto, mk] = await Promise.allSettled([refreshLive({ base }), loadMarket()]);
    if (proto.status === 'fulfilled' && proto.value.snapshot) {
      st.pending = acceptLiveSnapshot(proto.value.snapshot);
      if (!st.fingerprintBaseline && !liveCalculationErrors(st.pending).length) st.fingerprintBaseline = st.pending.meta.fingerprint;
    } else st.pending = { ...st.snapshot, mode: 'UNAVAILABLE' };
    if (mk.status === 'rejected') st.pendingMarket = { mode: 'MARKET', legs: {} };
    st.liveLoading = false;
    applyPending();
    $('data-pending').textContent = st.inputValid ? '최신 조회값 자동 반영 완료 · 미래 값은 현재 조건 유지 가정' : '일부 조회 실패 또는 데이터 확인 필요 — 계산을 보류합니다.';
    if (rerun && st.inputValid) st.opt.rerunTimer = setTimeout(runOptimizer, 250);
  } finally { st.liveLoading = false; btn.disabled = false; }
}
function applyPending() {
  if (!st.pending && !st.pendingMarket) return;
  const preservePolicy = st.opt.hasRun;
  if (preservePolicy) { cancelOptimizer('최신 조건으로 다시 비교합니다.'); st.opt.applied = null; }
  if (st.pending) {
    const kept = st.pending.keptFromLastGood ?? [];
    st.snapshot = acceptLiveSnapshot(st.pending); st.pending = null;
    if (kept.length) st.snapshot.issues.push({ level: 'warn', code: 'PARTIAL_STALE', msg: `조회 실패 ${kept.length}개 값은 이전 값(STALE) 유지` });
    logChange([`스냅샷 적용: ${st.snapshot.mode} · 블록 ${st.snapshot.meta?.blockNumber ?? 'N/A'} · ${kstTime(st.snapshot.meta?.fetchedAt)}`]);
  }
  if (st.pendingMarket) { st.market = st.pendingMarket; st.pendingMarket = null; logChange([`시장 시세 적용: ${kstTimeShort(st.market.fetchedAt)}`]); }
  $('data-pending').textContent = '';
  if (!preservePolicy) st.reserveAuto.dirty = true;
  renderDataBar(); recompute({ preserveOptimizer: preservePolicy });
}

function logChange(lines) {
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  for (const l of lines) st.changelog.push({ at: new Date().toISOString(), text: l });
  const ol = $('changelog');
  ol.insertAdjacentHTML('afterbegin', lines.map((l) => `<li><span class="num">${t}</span> ${esc(l)}</li>`).join(''));
}
function diffRaw(prev, next, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const k of keys) {
    const a = prev?.[k], b = next?.[k];
    if (a && b && typeof a === 'object' && typeof b === 'object') out.push(...diffRaw(a, b, `${prefix}${k}.`));
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${prefix}${k}: ${a ?? '빈칸'} → ${b ?? '빈칸'}`);
  }
  return out;
}

// ---- 계산 실행 ----
function resetBaselinePolicy() {
  setField('funding', FUNDING.SELF); setField('usage', 'sell'); setField('policyType', 'ratio');
  setField('recyclePct', '0'); setField('switchDay', '0');
}

function invalidateReserveAdvice() {
  st.reserveAdvice = { job: st.reserveAdvice.job + 1, out: null, status: 'idle', plan: null };
}

function reserveAdviceMarkup() {
  const a = st.reserveAdvice;
  if (a.out !== st.out || a.status === 'idle') return '';
  if (a.status === 'loading') return '<div class="reserve-advice pending"><b>금액에 맞는 운전자금 추정 중…</b><small>선택 기간 전체를 다시 실행해 처리 보류가 없는지 확인합니다.</small></div>';
  const p = a.plan;
  if (p?.status !== 'OK') {
    const why = p?.status === 'SEARCH_LIMIT' ? '정해 둔 탐색 범위 안에서 완료 값을 찾지 못했습니다.'
      : p?.status === 'NOT_EXECUTABLE' ? '현재 경로는 운전자금만 늘려도 완료되지 않습니다.'
        : '현재 조건에서는 운전자금 추정값을 만들지 못했습니다.';
    return `<div class="reserve-advice warn"><b>자동 추정 보류</b><small>${esc(why)} 다른 전략 가능 여부와 경로 상태를 별도로 확인하세요.</small></div>`;
  }
  const rate = krwRate(st.out.scenario);
  const krw = (v) => rate ? ` · ${fmtKrw(v, rate)}` : '';
  const budgetNote = p.explicitBudgetShortfall > 0n
    ? `<small class="warn">직접 입력한 비교 예산 ${fmtDai(p.explicitBudget)}은 그대로 둡니다. 적용 후 총투입보다 ${fmtDai(p.explicitBudgetShortfall)} 부족하므로 전략 검색 전 예산도 직접 조정하세요.</small>` : '';
  const auto = reserveModeOf(readForm()) === 'AUTO';
  return `<div class="reserve-advice"><b>운전자금 추정 ${fmtDai(p.reserveDai)}</b>
    <span>현재 운전자금 ${fmtDai(p.currentReserve)} · 추가 준비금 ${fmtDai(p.additionalReserve)}${krw(p.additionalReserve)}</span>
    <span>적용 후 총투입 ${fmtDai(p.projectedTotal)}${krw(p.projectedTotal)}</span>
    <small>진입 원금에서 차감하지 않는 별도 준비금입니다. 현재 ${esc(policyReadable(st.out.policy))} 경로·선택 기간 전체 재실행 완료, 외부 추가 입금 0. 모든 전략의 최소 준비금이 아닌 조건부 추정값이며 실제 필요액을 보장하지 않습니다.</small>
    ${budgetNote}${auto ? '<small>자동 모드에서 검산 후 반영합니다.</small>' : '<button type="button" data-apply-auto-reserve>이 운전자금 적용</button>'}</div>`;
}

function incompleteCashMarkup({ advice = true } = {}) {
  const p = cashPresentation(st.out), b = p.blocking;
  return `<div class="cash-hold" role="status"><b>${esc(p.title)}</b>
    <span>${esc(b?.main ?? '현재 조건에서 처리가 끝나지 않았습니다.')}</span>
    ${b?.notes?.map((n) => `<small>${esc(n)}</small>`).join('') ?? ''}${advice ? reserveAdviceMarkup() : ''}</div>`;
}

function scheduleReserveAdvice(out) {
  const p = cashPresentation(out), b = p.blocking;
  if (p.key !== 'INCOMPLETE' || !b?.fixable) return;
  const job = st.reserveAdvice.job + 1;
  st.reserveAdvice = { job, out, status: 'loading', plan: null };
  setTimeout(() => {
    if (st.reserveAdvice.job !== job || st.out !== out || !st.inputValid) return;
    let plan;
    try { plan = autoReservePlan(out, st.snapshot); }
    catch (e) { plan = { status: 'ERROR', error: e.message }; }
    if (st.reserveAdvice.job !== job || st.out !== out || !st.inputValid) return;
    if (plan?.status === 'OK' && reserveModeOf(readForm()) === 'AUTO') {
      setField('reserveDai', formatUnits(plan.reserveDai, 18));
      st.reserveAuto.dirty = false;
      logChange([`AUTO 운전자금 반영: ${fmtDai(plan.currentReserve)} → ${fmtDai(plan.reserveDai)} (원금과 별도 추가 ${fmtDai(plan.additionalReserve)}, 총투입 ${fmtDai(plan.projectedTotal)}, 외부 추가 입금 0)`]);
      recompute({ preserveOptimizer: true });
      return;
    }
    st.reserveAdvice = { job, out, status: 'ready', plan };
    renderReserveLine(readForm(), out); renderQuickSummary(out); renderKpi(); renderMilestones();
  }, 20);
}

function recompute({ preserveOptimizer = false } = {}) {
  invalidateReserveAdvice();
  if (!preserveOptimizer) {
    clearTimeout(st.opt.rerunTimer);
    cancelOptimizer('입력 변경으로 이전 추천을 지웠습니다.');
    st.opt.applied = null;
    resetBaselinePolicy();
  }
  let f = readForm();
  if (reserveModeOf(f) === 'AUTO' && st.reserveAuto.dirty) {
    setField('reserveDai', EXAMPLE_VALUES.reserveDai);
    st.reserveAuto.dirty = false;
    f = readForm();
  }
  syncVisibility(f);
  st.inputValid = false;
  const out = compute(f, st.snapshot ?? validateSnapshot({ mode: 'MANUAL', meta: {}, values: {} }).snapshot, st.market);
  const errBox = $('input-errors');
  renderConversion(out);
  renderQuickSummary(out);
  renderMarketStrip();
  if (out.errors.length) {
    cancelOptimizer('최신 데이터 확인 후 다시 비교합니다.'); st.opt.applied = null;
    errBox.innerHTML = st.liveLoading && !st.out ? '<b>최신 시세와 프로토콜 값을 확인하고 있습니다…</b>' : `<b>입력·최신 데이터 확인 필요</b><p>${esc(out.errors[0])}</p><details><summary>확인할 항목 ${out.errors.length}개</summary><ul>${out.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>`;
    document.querySelectorAll('.results > .card:not(.results-summary):not(.strategy)').forEach((c) => c.classList.add('stale-result'));
    renderLgnsStatus();
    renderCompare();
    return false;
  }
  document.querySelectorAll('.results > .card').forEach((c) => c.classList.remove('stale-result'));
  errBox.innerHTML = '';
  document.querySelector('.results').classList.remove('stale-result');
  if (st.prevFlat) { const d = diffRaw(st.prevFlat, out.raw); if (d.length) logChange(d.slice(0, 12)); }
  st.prevFlat = JSON.parse(JSON.stringify(out.raw));
  st.out = out;
  st.inputValid = true;
  $('minreserve-out').textContent = '';
  st.evByDay = new Map();
  for (const e of out.result.events) { if (!st.evByDay.has(e.day)) st.evByDay.set(e.day, []); st.evByDay.get(e.day).push(e); }
  st.pinned = null; st.ledgerPage = 0;
  scheduleReserveAdvice(out);
  renderAll();
  return true;
}

function renderConversion(out) {
  const box = $('conversion-summary'); if (!box) return;
  const c = conversionSummary(out);
  const equivalent = $('input-equivalent');
  if (equivalent) {
    const asset = readForm().asset;
    equivalent.hidden = asset !== 'DAI' && asset !== 'KRW';
    equivalent.textContent = asset === 'DAI'
      ? (c?.krwValue != null ? `약 ${fmtN(toNum(c.krwValue), 0)}원` : '원화 환산: 실시간 환율 확인 중')
      : (c?.daiValue != null ? `약 ${fmtDai(c.daiValue, 2)}` : 'DAI 환산: 입력 금액·실시간 환율 확인 필요');
  }
  if (!c) {
    const msg = out?.errors?.find((e) => /환율|시세|Power|POWER/.test(e)) ?? out?.errors?.[0] ?? '금액을 입력하세요.';
    box.innerHTML = `<p class="conversion-empty">환산할 수 없음 · ${esc(msg)}</p>`;
    return;
  }
  const f = readForm(), start = c.asset === 'KRW' ? `${fmtN(toNum(out.scenario.amount), 0)}원`
    : c.asset === 'LGNS' ? fmtTok(out.scenario.amount, `${out.scenario.chain === 'polygon' ? 'Polygon' : 'Anubis'} LGNS`, 9)
      : fmtDai(out.scenario.amount, 2);
  const values = [];
  if (c.asset === 'KRW' && c.daiValue !== null) values.push(`<span><small>DAI 환산</small><b>${fmtDai(c.daiValue, 2)}</b></span>`);
  if (c.asset !== 'KRW' && c.krwValue !== null) values.push(`<span><small>원화 환산</small><b>${fmtN(toNum(c.krwValue), 0)}원</b></span>`);
  else if (c.asset === 'DAI') values.push('<span class="muted"><small>원화 환산</small><b>실시간 환율 없음</b></span>');
  if (out.scenario.route === ROUTES.ANUBIS_LGNS_BURN) values.push(`<span><small>고정 비교 원금 (1 LGNS = 1 DAI)</small><b>${fmtDai(out.quote.economicCostDai, 2)}</b></span>`);
  if (c.asset === 'LGNS' && c.marketValueDai !== null) values.unshift(`<span><small>LGNS 시장 평가액</small><b>${fmtDai(c.marketValueDai, 2)}</b></span>`);
  const state = c.blockedCap0
    ? `<b class="warn">잠재 ${fmtPower(c.potentialPower)} · 활성 0</b><small>${esc(c.powerNote)}</small>`
    : `<b${c.capIgnored ? ' class="warn"' : ''}>잠재 ${fmtPower(c.potentialPower)}</b><small>첫날 활성 ${fmtPower(c.activePower)} · 대기 ${fmtPower(c.pendingPower)}. ${esc(c.powerNote)}</small>`;
  box.innerHTML = `<div class="conversion-head"><span><small>입력 금액</small><b>${start}</b></span><i aria-hidden="true">→</i>${values.join('')}</div>
    <div class="power-state">${state}</div>`;
  box.dataset.asset = f.asset;
}

function renderQuickSummary(out) {
  const box = $('quick-summary'); if (!box) return;
  const state = cashPresentation(out);
  if (state.key === 'INCOMPLETE') {
    box.innerHTML = `<p class="section-kicker">현금 결과</p>${incompleteCashMarkup()}`;
    return;
  }
  const rows = quickSummaryRows(out);
  if (!rows) { box.innerHTML = `<p class="qs-empty">입력 확인 필요 — ${esc(out.errors?.[0] ?? '값을 확인하세요')}</p>`; return; }
  const basis = st.opt.applied?.plan?.label ?? (out.policy?.switchDay > 0 ? `${out.policy.switchDay}일 전환 전략 · 최신 조건 재계산(최대 효율 비교 중)` : '매일 받기 비교 기준');
  box.innerHTML = `<p class="section-kicker">${esc(basis)}</p><table class="qs"><thead><tr><th>기간</th><th>누적 실제 현금</th><th>현금 ROI</th></tr></thead><tbody>${rows.map((r) => (r.available
    ? `<tr><th scope="row">${esc(r.label)}</th><td><b>${esc(r.primary)}</b>${r.secondary ? `<small>${esc(r.secondary)}</small>` : ''}</td><td class="${r.roiBps !== null && r.roiBps < 0 ? 'neg' : ''}"><b>${esc(r.roi)}</b></td></tr>`
    : `<tr><th scope="row">${esc(r.label)}</th><td colspan="2">기간 밖</td></tr>`)).join('')}</tbody></table>`
    + `<p class="qs-basis">${esc(quickSummaryBasis(out)?.text ?? '')}</p>`
    + '<p class="qs-basis">현금 수령 전: 받은 금액 0 · 현금 수익률 −100%. 이후 보상으로 원금을 회수하며, 원금은 별도로 반환되지 않습니다.</p>'
    + (out.scenario.route === ROUTES.ANUBIS_LGNS_BURN ? '<p class="qs-basis">LGNS 고정 비교 기준: 1 LGNS = 1 DAI 원금 · ×2 POWER. 시장 시세는 수익률 분모에 반영하지 않습니다. 2 POWER는 2 DAI 현금 보장이 아닙니다.</p>' : '');
}

function renderFeePanel() {
  const box = $('fee-panel'); if (!box || !st.out?.scenario) return;
  const s = st.out.scenario, snap = st.snapshot;
  const pick = (user, key) => user !== null && user !== undefined ? { value: Number(user), source: '사용자 시나리오' }
    : snap?.values?.[key]?.value !== null && snap?.values?.[key]?.value !== undefined
      ? { value: Number(snap.values[key].value), source: `${snap.values[key].status} 관측값` } : { value: null, source: '확인 불가' };
  const turbine = pick(s.engine.turbineFeeBps, 'turbineFeeBps');
  const sell = pick(s.engine.sellTaxBps, 'sellFeeBps');
  const pool = { value: Number(s.engine.poolFeeBps), source: '시나리오 가정' };
  const fee = (name, x) => `<div><small>${name}</small><b>${x.value === null ? 'N/A' : fmtBpsPct(x.value)}</b><span>${esc(x.source)}</span></div>`;
  box.innerHTML = `<div class="fee-grid">${fee('터빈 수수료', turbine)}${fee('AiLGNS 매도세', sell)}${fee('풀 수수료', pool)}</div>
    <p>터빈·매도세 관측 기준 ${esc(kstTime(snap?.meta?.fetchedAt))}. 풀 0.30%는 관측값과 분리한 시나리오입니다. 터빈 크레딧은 활성화 전에 같은 수량의 AiLGNS를 먼저 사야 하므로 첫 처리에는 준비 DAI가 필요합니다.</p>`;
}

const LEG_ROWS = [['fx', 'DAI/KRW', (v) => `${fmtN(toNum(v), 1)}원`], ['ailgns', 'AiLGNS', (v) => `${fmtN(toNum(v), 2)} DAI`]];
function renderMarketStrip() {
  const box = $('market-strip'); if (!box) return;
  const m = st.market, f = readForm(), nowMs = Date.now();
  const lgKey = f.lgnsChain === 'anubis' ? 'lgnsAnubis' : 'lgnsPolygon';
  const rows = [...LEG_ROWS, [lgKey, f.lgnsChain === 'anubis' ? 'LGNS (Anubis)' : 'LGNS (Polygon)', (v) => `${fmtN(toNum(v), 4)} DAI`]];
  const cell = ([k, name, fmt]) => {
    const l = m.legs?.[k];
    const label = `<span class="market-asset"><img src="${TOKEN_ICONS[k === 'fx' ? 'fx' : k === 'ailgns' ? 'ailgns' : 'lgns']}" alt="" width="30" height="30"><span>${name}</span></span>`;
    if (m.loading && !l) return `<li>${label}<b>불러오는 중</b></li>`;
    if (usableLeg(l, nowMs)) return `<li>${label}<b>${esc(fmt(l.value))}</b><small>${esc(kstTimeShort(l.fetchedAt))}${l.source?.blockNumber ? ` · 블록 ${fmtN(l.source.blockNumber, 0)}` : ''}</small></li>`;
    const fr = legFreshness(l, nowMs);
    if (fr === 'EXPIRED') return `<li class="warn">${label}<b>만료</b><small>${esc(fmt(l.value))} · ${esc(kstTimeShort(l.fetchedAt))} 조회 — 5분 지나 계산에 안 씀</small></li>`;
    const why = fr === 'FUTURE' ? '조회 시각 오류' : fr === 'INVALID' ? '값 형식 오류' : l?.error ?? '없음';
    const prev = l?.previous ? ` · 이전 ${esc(fmt(l.previous.value))} (${esc(kstTimeShort(l.previous.fetchedAt))}, 만료·계산에 안 씀)` : '';
    return `<li class="warn">${label}<b>조회 안 됨</b><small>${esc(why)}${prev}</small></li>`;
  };
  const u = st.inputValid ? st.out?.marketUse ?? {} : {};
  const used = [u.fx?.status === 'OK' && '원화 환율: 실시간', u.ailgns && `AiLGNS: ${({ SPOT: '실시간 spot', SAVED_TWAP: '저장 TWAP', USER: '직접 입력' })[u.ailgns.source] ?? ''}`,
    u.lgns && `LGNS: ${u.lgns.status === 'OK' ? '실시간' : u.lgns.status === 'USER' ? '직접 입력' : '없음'}`].filter(Boolean).join(' · ');
  box.innerHTML = `<div class="ms-head"><b>시장 시세</b><button type="button" class="link" id="btn-market">새로고침</button></div>
    <ul class="market-list">${rows.map(cell).join('')}</ul>
    <details><summary>시세 출처·계산 기준</summary><p class="hint">${used ? `계산에 쓴 값 — ${esc(used)}. ` : ''}풀 reserve spot·체결가이며 실행 견적이 아닙니다. 미래 가격은 이 값으로 고정해 계산합니다.</p>${marketDetailHtml(m)}</details>`;
  $('btn-market').onclick = doLive;
}
function marketDetailHtml(m) {
  const rows = Object.values(m.legs ?? {}).map((l) => {
    const s = l.source ?? {};
    const pool = s.pair ? `풀 ${esc(s.pair)} · ${esc(s.base?.symbol ?? '?')}(${s.base?.decimals}) ${fmtN(toNum(s.baseReserve, s.base?.decimals ?? 18), 2)} / ${esc(s.quote?.symbol ?? '?')}(${s.quote?.decimals}) ${fmtN(toNum(s.quoteReserve, s.quote?.decimals ?? 18), 2)} · DAI 유동성 ${fmtN(toNum(s.daiLiquidity), 0)}` : '';
    const blk = s.blockNumber ? `체인 ${esc(s.chainId)} 블록 ${s.blockNumber} (블록 시각 ${esc(new Date(s.blockTimestamp * 1000).toISOString())})` : '';
    const up = s.market ? `업비트 ${esc(s.market)} ${esc(s.tradePrice)} (체결 ${esc(new Date(s.tickerTimestamp).toISOString())})` : '';
    return `<li><b>${esc(l.label)}</b> ${badge(l.status)} ${l.value ? esc(formatUnits(BigInt(l.value), 18)) + ' ' + esc(l.unit) : ''}<br><small>${[blk, pool, up, l.fetchedAt && `조회 ${esc(l.fetchedAt)}`, l.error && `<span class="warn">${esc(l.error)}</span>`].filter(Boolean).join('<br>')}</small></li>`;
  }).join('');
  return `<ul class="warn-list">${rows || '<li>아직 조회 결과 없음</li>'}</ul><p class="hint">시장 spot과 프로토콜 Oracle TWAP은 별도 출처이며 각각 최신 조회합니다. 조회 시각·블록을 구분하여 기록합니다.</p>`;
}

function renderAll() {
  renderConversion(st.out); renderQuickSummary(st.out); renderEntry(); renderKpi(); renderCharts(); renderMilestones(); renderDaySamples();
  renderUnrealized(); renderCompare(); renderMore(); renderLgnsStatus(); renderMarketStrip(); renderFeePanel(); renderReserveLine(readForm(), st.out);
}

// ---- D. 진입 요약 ----
function renderEntry() {
  const { scenario: s, quote: q, result } = st.out, dv = derive(result), rate = krwRate(s);
  const steps = [];
  const unitAmt = s.asset === 'LGNS' ? fmtTok(s.amount, s.chain === 'polygon' ? 'Polygon LGNS' : 'Anubis LGNS', 9) : s.asset === 'KRW' ? `${fmtN(toNum(s.amount), 0)}원` : fmtDai(s.amount);
  steps.push(['시작자산', unitAmt, routeLabel(s.route)]);
  if (q.fx) steps.push(['원화 → DAI', fmtDai(q.fx.netDai), `환율 ${fmtN(toNum(q.fx.rateKrwPerDai), 2)}원/DAI · ${q.fx.fxMode} · 스프레드·출금비용 차감 후 (평가액 ${fmtDai(q.fx.grossDai)})`]);
  if (s.asset === 'LGNS') {
    steps.push(['시장 평가액', fmtDai(q.marketValueDai), 'LGNS 시장 가격 × 수량']);
    steps.push(['순매도 가능액', fmtDai(q.netSaleDai), q.netSaleSource === 'USER_QUOTE' ? '사용자 입력 견적' : q.netSaleSource === 'ASSUMED' ? '수동 가정(세금·풀·가스)' : '미입력 — 수동 견적 필요']);
  }
  const costNote = q.economicCostSource === 'MARKET_VALUE/ASSUMED'
    ? '현재 LGNS 시장평가액 기준(매도세·수수료 전, 매도 견적 아님)'
    : q.costBasis ? (q.costBasis === 'FIXED_ONE_DAI' ? '1 LGNS = 1 DAI 고정 비교 기준' : q.costBasis === 'ACQUISITION' ? '매입원가 기준' : '기회비용(순매도 가능 DAI) 기준') : 'DAI 진입액';
  steps.push(['원금(ROI 분모 진입분)', fmtDai(q.economicCostDai), costNote]);
  if (q.fixed) {
    const fx = result.summary.fixed;
    steps.push(['FIXED 소각 (Polygon)', fmtTok(q.fixed.polygonLgnsBurned, 'LGNS', 9), `${badge(q.routeStatus)} 인정액 ${fmtDai(q.fixed.principalRecognizedDai)} — 지급 계산용, 원금 아님`]);
    steps.push(['Anubis LGNS 지급', fx?.enabled ? `누적 ${fmtTok(fx.accruedLgns, 'LGNS', 9)}` : '검증대기',
      fx?.enabled ? `주기 지급률 ${esc(q.fixed.payoutBpsPerPeriod)}bps · 미지급 ${fmtDai(fx.capDai === null ? null : fx.capDai - fx.paidDai)}${fx.stopped ? ' · 중단됨' : ''}` : `미입력: ${esc((fx?.missing ?? []).join(', '))}`]);
    steps.push(['HELIX 소각 (Anubis)', fmtTok(dv.last?.lgnsBurned, 'LGNS', 9), `대기 ${fmtTok(dv.last?.lgnsWaiting, 'LGNS', 9)} · 지급마다 HELIX 한도·편입 지연 별도`]);
  }
  const pw = q.powerPreview ?? q.assumedPowerPreview;
  const cap0 = q.routeStatus === 'BLOCKED_CAP0';
  const capIgnored = s.asset === 'LGNS' && q.burnCaps?.ignoredForCalculation && q.burnCaps?.lgns?.value === '0';
  steps.push([cap0 ? '잠재 Power (활성 아님)' : '진입 잠재 Power', fmtPower(pw), cap0 ? `${badge('BLOCKED_CAP0')} 일일 한도 0`
    : capIgnored ? `${badge('ASSUMED')} 현재 관측 한도 0은 별도 표시 · 계산에서는 제외`
      : q.powerPreview !== null ? `${badge(q.powerStatus)} 다음 정산 편입 전 대기` : pw !== null ? `${badge('ASSUMED')} 미리보기` : '확정 불가']);
  steps.push(['첫 활성·첫 정산', dv.firstActive ? `${dv.firstActive.date} 활성` : '미도달', dv.firstEmission ? `첫 정산 ${dv.firstEmission.date} (편입 지연 ${s.engine.entryLagDays}일 가정)` : '기간 내 정산 없음']);
  const initI = result.summary.initialCapitalDai ?? null;
  const bud = st.out.budget;
  $('budget-hint').textContent = bud?.value == null ? '비교 예산 미확정(원금 미확정).'
    : bud.derived ? `비교 예산 ${fmtDai(bud.value)} — 원금+운전자금+가스 합으로 자동 고정. 모든 후보에 같게 적용.`
      : initI !== null && bud.value < initI ? `비교 예산 ${fmtDai(bud.value)} (직접 입력)은 현재 총투입 ${fmtDai(initI)}보다 부족합니다. 전략 검색 전 직접 조정하세요.`
        : `비교 예산 ${fmtDai(bud.value)} (입력값). 모든 후보에 같게 적용.`;
  $('entry').innerHTML = `<h2>진입 요약</h2><div class="flow">${steps.map(([t, v, n], i) =>
    `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ''}<div class="step"><small>${esc(t)}</small><b class="num">${v}</b><small>${n}</small></div>`).join('')}</div>`
    + `<p class="hint">초기 투입 ${fmtDai(initI)} = 원금 ${fmtDai(q.economicCostDai)} + 운전자금 ${fmtDai(s.reserveDai)} + 가스 잔액${rate ? ` · ${fmtKrw(initI, rate)} (고정환율 가정)` : ''}</p>`
    + (q.issues.length ? `<ul class="warn-list">${q.issues.map((x) => `<li class="warn">${esc(x)}</li>`).join('')}</ul>` : '');
}

const ENTRY_REASON = { ENTRY_NOT_EXECUTED: '진입이 실행되지 않음', ENTRY_BLOCKED: '진입 차단', LGNS_BURN_PENDING: 'LGNS 소각 대기', FIXED_UNVERIFIED: 'FIXED 값 검증대기' };
// ---- 핵심 수치 ----
function renderKpi() {
  const { scenario: s, result, policy } = st.out, sm = result.summary, dv = derive(result), rate = krwRate(s);
  if (!cashResultReady(st.out)) {
    $('kpi').innerHTML = `<div class="hero hold-hero"><div class="hero-main"><small>${s.horizonYears}년 현금 결과</small><strong>계산 보류</strong>
      <span>처리가 끝나기 전의 현금·순이익·ROI는 정상 성과로 표시하지 않습니다.</span></div></div>
      ${incompleteCashMarkup()}<p class="status">현재 장부는 원인 확인용입니다. 필요한 운전자금을 적용해 장부가 끝까지 완료된 뒤 현금 성과를 다시 계산합니다.</p>`;
    return;
  }
  const krw = (v) => (rate ? fmtKrw(v, rate) : '');
  const stat = (label, val, sub = '', neg = false) => `<div class="stat"><small>${label}</small><strong class="${neg ? 'neg' : ''}">${val}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const pbT = dv.payback ? recordTiming(dv.payback, s.startDate) : null;
  const pbVal = pbT ? `${pbT.elapsed ?? pbT.settlementNo}일째` : '기간 내 미회수';
  const pbSub = pbT ? `${dv.payback.date}${sm.reUnrecovered ? ' · 이후 다시 미회수' : ''}` : '';
  const holdDays = result.daily.filter((r) => r.heldCredits > 0n).length;
  const status = resultStatus(sm);
  const blocks = [];
  const bt = blockingText(explainBlocking(st.out));
  if (bt) {
    blocks.push(`<b>${esc(bt.main)}</b>${holdDays ? ` <small>(보류 ${holdDays}일)</small>` : ''}`);
    bt.notes.forEach((n) => blocks.push(esc(n)));
    if (bt.fixable) blocks.push('<button type="button" class="link" data-open-settings="reserveDai">준비금 조정</button> · <button type="button" class="link" data-minreserve>필요 운전자금 계산</button>');
  } else if (status.key === 'INCOMPLETE') blocks.push('일부 처리가 보류되었습니다. 자세한 내용은 ‘가정과 경고’를 보세요.');
  const years = s.horizonYears === 0.5 ? '6개월' : `${s.horizonYears}년`;
  const price = result.daily[0]?.price ?? null, aiEq = cashAiEquivalent(sm.W, price);
  const aiBasis = st.out.marketUse?.ailgns?.source === 'SPOT' ? '조회 spot 기준 환산'
    : st.out.marketUse?.ailgns?.source === 'SAVED_TWAP' ? '저장 TWAP 기준 환산' : '계산 기준 가격 환산';
  $('kpi').innerHTML = `<div class="hero">
    <div class="hero-main"><small>${years} 동안 받는 현금</small><strong>${fmtDai(sm.W, 0)}</strong>
      <span>총투입 ${fmtDai(sm.I, 0)}${krw(sm.I) ? ` (${krw(sm.I)})` : ''}</span></div>
    <div class="stats">
      ${stat('순이익', fmtDai(sm.net, 0), krw(sm.net), sm.net !== null && sm.net < 0n)}
      ${stat('수익률', fmtBpsPct(sm.roiBps), '', sm.roiBps !== null && sm.roiBps < 0)}
      ${stat('원금 회수', pbVal, pbSub)}
      ${stat('남은 원금', fmtDai(dv.last?.unrecovered, 0))}
    </div></div>
    ${blocks.length ? `<div class="block-msg" role="status">${blocks.join('<br>')}</div>` : ''}
    <div class="hint" role="note" aria-label="원금 회수일이 다른 이유">
      <strong>받은 가치와 실제 원금 회수일은 왜 다른가요?</strong>
      <p>‘받은 가치’만으로 계산한 날짜는 누적 AiLGNS 보상의 DAI 평가액이 처음 넣은 원금에 도달한 날입니다. 아직 현금으로 회수한 금액은 아닙니다.</p>
      <p>터빈 재순환에서는 보상 일부를 팔아 터빈 비용·매도세·풀 수수료·가스를 충당하고, 남은 보상을 다시 소각해 POWER로 바꿉니다. 재소각한 금액은 현금 회수에 포함하지 않으므로, 보상 평가액이 원금을 넘어도 실제 회수는 늦어질 수 있습니다.</p>
      <p>이 계산기의 ‘원금 회수’는 밖으로 받은 누적 현금이 원금과 준비금(운전자금·가스)을 합친 총투입액에 도달한 날입니다. 재순환은 이후 보상 규모에도 영향을 주므로, 재투자를 멈추는 날짜와 수수료에 따라 회수 일정이 달라집니다.</p>
    </div>
    <p class="status">${esc(status.text)} · ${esc(policyLabel(policy))}${sm.endReturnDai > 0n ? ` · 마지막 날 돌려받는 준비금 ${fmtDai(sm.endReturnDai, 0)} 포함` : ''}.
    현금 수익률의 총투입은 원금+운전자금+가스이며, 누적 배출 가치는 실제 현금과 다릅니다. 선택 기간은 만기·환불일이 아닙니다. 현재 조건 유지 가정(실제 거래 미검증).${rate ? ' 원화는 같은 환율 가정.' : ''}
    ${st.out.marketUse?.ailgns ? `AiLGNS 가격: ${esc({ SPOT: `실시간 풀 spot(${kstTimeShort(st.out.marketUse.ailgns.fetchedAt)}) 고정`, SAVED_TWAP: '저장 Oracle TWAP 고정', USER: '직접 입력 고정' }[st.out.marketUse.ailgns.source] ?? '')}.` : ''}</p>`;
}

// ---- E. 차트·커서 ----
function renderCharts() {
  st.charts?.destroy();
  const ready = cashResultReady(st.out);
  const chartStatus = $('chart-status');
  if (chartStatus) {
    chartStatus.className = ready ? 'chart-status' : 'chart-status warn';
    chartStatus.textContent = ready ? '' : '처리 보류 중 장부입니다. 원인 확인용이며 정상 현금 수익 예측이 아닙니다.';
  }
  const full = chartModel(st.out.result, { roiView: st.roiView });
  if (!full.n) { $('charts').innerHTML = '<p class="hint">표시할 장부가 없습니다.</p>'; return; }
  const model = singleChartModel(full, 0);
  st.charts = createSyncedCharts($('charts'), model, {
    onCursor: (i) => { st.cursor = i; renderReadout(i); },
    onPin: (i) => { st.pinned = i; renderDetail(); if ($('d-ledger').open) renderLedger(true); },
  });
}
function renderReadout(i) {
  const r = st.out.result.daily[i]; if (!r) return;
  const roi = roiBpsOf(r.net, r.I);
  const cell = (t, v) => `<div><span>${t}</span><b>${v}</b></div>`;
  const tm = recordTiming(r, st.out.scenario.startDate);
  $('readout').innerHTML = cell('정산일 · 회차 · 경과', `${r.date ?? ''} · ${tm.settlementNo}회 · ${tm.elapsed ?? '?'}일`) + cell('배출 DAI 가치', fmtDai(r.emissionDai))
    + cell('하루 실제 현금', fmtDai(r.externalWithdrawal - (r.endReturnDai ?? 0n))) + cell('활성 Power', fmtPower(r.activePowerEnd))
    + cell('대기 Power', fmtPower(r.pendingPower)) + cell('누적 순손익 · ROI', cashResultReady(st.out) ? `${fmtDai(r.net, 0)} · ${fmtBpsPct(roi)}` : '계산 보류');
}
const EV_LABEL = { ENTRY_DAI: 'DAI 진입', ACTIVATE: 'Power 활성', TURBINE: '터빈 활성화', TURBINE_HOLD: '터빈 보류', SALE: '매도', WITHDRAW: '외부 인출', REBURN: '재소각',
  BURN_BLOCKED: '재소각 차단', EXTERNAL_TOPUP: '외부 투입', END_RETURN: '종료 반환', FIXED_BURN_POLYGON: 'FIXED 소각(Polygon)', FIXED_PAYOUT: 'FIXED 지급', FIXED_CLAIM: 'FIXED 청구',
  FIXED_STOPPED: 'FIXED 중단', FIXED_CAP_REACHED: 'FIXED 상한 도달', HELIX_LGNS_BURN: 'HELIX LGNS 소각' };
function renderDetail() {
  const box = $('detail'), i = st.pinned;
  if (i === null || !st.out.result.daily[i]) { box.hidden = true; return; }
  const r = st.out.result.daily[i], roi = roiBpsOf(r.net, r.I);
  const rows = [
    ['정산일 · 회차 · 시작 후 경과', recordTiming(r, st.out.scenario.startDate).text], ['AiLGNS 가격(시나리오)', fmtDai(r.price, 4)],
    ['기초 활성 Power', fmtPower(r.activePowerStart)], ['신규 활성 Power', fmtPower(r.newActivePower)], ['소진 Power', fmtPower(r.consumedPower)],
    ['기말 활성 Power', fmtPower(r.activePowerEnd)], ['대기 Power', fmtPower(r.pendingPower)],
    ['정산 DAI 가치', fmtDai(r.emissionDai, 4)], ['미처리 크레딧', fmtTok(r.credits)],
    ['잠금 AiLGNS', fmtTok(r.lockedAilgns)], ['매도가능 AiLGNS', fmtTok(r.spendableAilgns)],
    ['터빈 매수 DAI', fmtDai(r.turbineBuyDai, 4)], ['터빈 수수료', fmtDai(r.turbineFeeDai, 4)], ['매도세', fmtTok(r.sellTaxTokens)],
    ['풀 수수료', fmtDai(r.poolFeeDai, 4)], ['가스', fmtDai(r.gasDai, 4)],
    ['비용충당 매도', `${fmtTok(r.coverSaleTokens)} → ${fmtDai(r.coverSaleDai)}`], ['reserve 매도', `${fmtTok(r.reserveSaleTokens)} → ${fmtDai(r.reserveSaleDai)}`],
    ['reserve 목표', fmtDai(r.reserveTargetDai)], ['재소각', `${fmtTok(r.burnTokens)} → ${fmtPower(r.newPendingPower)}`],
    ['요청 · 실행 재순환', `${fmtBpsPct(r.requestedRecycleBps)} · ${fmtBpsPct(r.executedRecycleBps)}`],
    ['외부 투입', fmtDai(r.externalTopup)], ['외부 인출', fmtDai(r.externalWithdrawal)], ['내부 DAI', fmtDai(r.cash)], ['Anubis 가스 잔액', fmtDai(r.nativeAnubis, 4)],
    ['누적 현금 회수', fmtDai(r.cumWithdrawal)], ['누적 총투입', fmtDai(r.I)], ['현금 순이익', fmtDai(r.net)], ['현금 ROI', fmtBpsPct(roi)],
    ['원금 회수 상태', r.I === null ? 'N/A' : r.cumWithdrawal >= r.I ? '회수' : `미회수 ${fmtDai(r.unrecovered)}`],
  ];
  if (r.fixed) rows.push(['FIXED 누적 지급(인정 DAI)', fmtDai(r.fixed.paidDai)], ['FIXED 미청구', fmtTok(r.fixed.unclaimedLgns, 'LGNS', 9)], ['HELIX 소각 대기 LGNS', fmtTok(r.lgnsWaiting, 'LGNS', 9)]);
  const evs = (st.evByDay.get(i) ?? []).map((e) => EV_LABEL[e.type] ?? e.type);
  const flags = [r.gasShort && '가스 부족', r.reserveShort && 'reserve 부족', r.heldCredits > 0n && '터빈 보류'].filter(Boolean);
  box.hidden = false;
  box.innerHTML = `<h3>${esc(r.date)} 상세 (고정됨 · Esc 해제)</h3><dl>${rows.map(([t, v]) => `<div><dt>${t}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <p class="hint">사건: ${esc(evs.join(', ') || '없음')}${flags.length ? ` · <span class="warn">${esc(flags.join(', '))}</span>` : ''} · 사건 순서·편입 규칙은 가정.</p>`;
}

// ---- F. 3·6·12개월 (선택 horizon 단일 장부에서 읽음) ----
function jumpTo(i) { if (!st.charts) return; st.charts.setCursor(i); st.charts.pin(i); $('charts').scrollIntoView({ block: 'nearest' }); }
function renderMilestones() {
  const { result } = st.out, dv = derive(result), det = st.showMsDetail;
  if (!cashResultReady(st.out)) {
    $('milestones').innerHTML = `<h2>기간별 현금 결과</h2>${incompleteCashMarkup({ advice: false })}
      <p class="hint">미완료 장부의 0원·음수 ROI는 정상 성과가 아니므로 기간별 결과를 표시하지 않습니다.</p>`;
    return;
  }
  const head = ['기간 · 마지막 정산일', '기준 정산(장부 행)', '누적 배출 DAI 가치', '누적 총투입', '누적 외부 회수', '현금 순이익', 'ROI', '미회수 원금', ...(det ? ['정산 횟수', '내부 DAI', '잠금 AiLGNS', '대기 Power'] : [])];
  const rows = result.summary.milestones.map((m) => {
    const r = m.record;
    if (!r) return `<tr><td>${esc(m.label)} · ${esc(m.date)}</td><td colspan="${head.length - 1}">장부 미도달</td></tr>`;
    return `<tr class="clickable em" tabindex="0" data-day="${r.day}"><td>${esc(m.label)} · ${esc(r.date)} <span class="hint">(기간 종료 ${esc(m.date)} 전 마지막 정산)</span></td>
      <td>${esc(r.date)} <span class="hint">정산 ${r.day + 1}회차</span></td>
      <td>${fmtDai(r.cumEmissionDai, 0)}</td><td>${fmtDai(r.I, 0)}</td><td>${fmtDai(r.cumWithdrawal, 0)}</td>
      <td class="${r.net !== null && r.net < 0n ? 'neg' : ''}">${fmtDai(r.net, 0)}</td><td>${fmtBpsPct(roiBpsOf(r.net, r.I))}</td><td>${fmtDai(r.unrecovered, 0)}</td>
      ${det ? `<td>${dv.settleCount(m.day - 1)}</td><td>${fmtDai(r.cash, 0)}</td><td>${fmtTok(r.lockedAilgns)}</td><td>${fmtPower(r.pendingPower)}</td>` : ''}</tr>`;
  }).join('');
  const qs = quickSummaryRows(st.out) ?? [];
  const cards = milestoneCards(result).map((c, i) => {
    const q = qs[i];
    if (!c.record || !q?.available) return `<div class="ms-card"><b>${esc(c.label)}</b><span class="ms-date">${esc(c.date)}</span><span class="ms-sub">기간 밖</span></div>`;
    return `<button type="button" class="ms-card" data-day="${c.record.day}" aria-label="${esc(c.label)} 그래프에서 보기">
        <b>${esc(c.label)}</b><span class="ms-date">${esc(c.date)}</span>
        <span class="ms-cash">${esc(q.primary)}</span>${q.secondary ? `<span class="ms-sub">${esc(q.secondary)}</span>` : ''}
        <span class="ms-roi ${q.roiBps !== null && q.roiBps < 0 ? 'neg' : ''}">수익률 ${esc(q.roi)}</span>
        <span class="ms-sub">순이익 ${fmtDai(c.record.net, 0)}</span>
      </button>`;
  }).join('');
  $('milestones').innerHTML = `<h2 class="desktop-only">기간별 받은 현금</h2><div class="ms-cards desktop-only">${cards}</div>
    <details class="ms-more" id="ms-more" ${st.msOpen ? 'open' : ''}><summary>자세히 (전체 기간 표)</summary>
    <div class="tbl-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">목표일은 시작일의 달력상 +3/+6/+12/+18/+24/+36개월(선택 기간 내, 또는 고정 일수)이고, 값은 목표일 전 마지막 정산의 마감 상태입니다.
    모두 같은 장부에서 읽으며, 준비금은 마지막 날에만 돌려받습니다. 누적 배출 DAI 가치는 현금이 아닙니다.</p>
    <label class="inline"><input type="checkbox" id="ms-detail" ${det ? 'checked' : ''}> 상세 열 보기</label></details>`;
  $('ms-detail').onchange = (e) => { st.showMsDetail = e.target.checked; renderMilestones(); };
  $('ms-more').ontoggle = (e) => { st.msOpen = e.target.open; };
  bindRowJump($('milestones'));
}
function bindRowJump(root) {
  root.querySelectorAll('[data-day]').forEach((tr) => {
    const go = () => jumpTo(Number(tr.dataset.day));
    tr.onclick = go; tr.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

function renderDaySamples() {
  const box = $('day-samples'); if (!box) return;
  const rows = daySampleRows(st.out.result);
  const first = st.out.result.daily.find((r) => r.emissionDai > 0n);
  const firstQty = first ? cashAiEquivalent(first.emissionDai, st.out.result.daily[0]?.price ?? null) : null;
  const firstNote = firstQty === null ? '현재 조건에서 첫 보상 수량을 계산할 수 없습니다.'
    : `첫 보상 예상: ${fmtTok(firstQty)} · ${esc(first.date)} (${fmtDai(first.emissionDai)} ÷ 현재 계산 시세). 수수료 차감 전이며 실제 정산 가격·편입 시점에 따라 달라집니다.`;

  box.innerHTML = `<h2>대표 정산일</h2>
    <p class="hint">1일은 투자 시작일입니다. 현재 기본 모형은 POWER 편입에 1일이 걸린다고 가정하여 당일 배출을 0으로 표시합니다. 실제 편입·첫 정산 시점은 별도 확인이 필요합니다. 배출 DAI 가치도 현재 배출 조건을 유지한 가정값입니다.</p>
    <p class="hint">${firstNote} 미래 일자별 AiLGNS 수량은 가격에 따라 달라져 표시하지 않습니다.</p>
    <div class="tbl-wrap"><table class="sample-table"><thead><tr><th>회차 · 날짜</th><th>배출 DAI 가치</th><th>하루 실제 현금</th><th>활성 · 대기 POWER</th></tr></thead><tbody>${rows.map((r) =>
      `<tr class="clickable" tabindex="0" data-day="${r.day - 1}"><td>${r.day}일 · ${esc(r.date)}</td><td>${fmtDai(r.emissionDai, 2)}</td><td>${fmtDai(r.dailyCashDai, 2)}</td><td>${fmtPower(r.activePower)} · ${fmtPower(r.pendingPower)}</td></tr>`).join('')}</tbody></table></div>`;
  bindRowJump(box);
}

// ---- 미실현(현금 ROI 제외) ----
function renderUnrealized() {
  const u = st.out.result.summary.unrealized;
  const item = (t, v) => `<div><small>${t}</small><b class="num">${v}</b></div>`;
  $('unrealized').innerHTML = `<h2>종료일 미실현 잔액 <span class="hint">현금 ROI에 포함하지 않음 · 강제 매도 없음 · Power에 현금 가치 부여 안 함</span></h2>
  <div class="kpi-grid">${item('매도가능 AiLGNS', fmtTok(u.spendableAilgns))}${item('잠금 AiLGNS', fmtTok(u.lockedAilgns))}${item('대기 Power', fmtPower(u.pendingPower))}
  ${item('활성 Power', fmtPower(u.activePower))}${item('미처리 크레딧', fmtTok(u.credits))}${item('HELIX 소각 대기 LGNS', fmtTok(u.lgnsWaiting, 'LGNS', 9))}
  ${item('미반환 내부 DAI', fmtDai(u.cashNotReturned))}${item('가스 잔액 Anubis · Polygon', `${fmtDai(u.nativeGas.anubis)} · ${fmtDai(u.nativeGas.polygon)}`)}</div>`;
}

// ---- G. 전략 비교: 고정 후보(메인 스레드) + 최적화 worker hook ----
function quickCompare() {
  const { scenario, policy } = st.out, snap = st.snapshot;
  const list = [...QUICK_POLICIES];
  if (!list.some((p) => JSON.stringify(p) === JSON.stringify(policy))) list.push(policy);
  return list.map((p) => {
    try { const r = simulate(scenario, snap, p); return { policy: p, s: r.summary, payback: r.summary.paybackDay === null ? null : r.daily[r.summary.paybackDay] }; }
    catch (e) { return { policy: p, error: e.message }; }
  });
}
const METRIC_LABEL = { maxNet: '순이익 가장 큼', fastestPayback: '원금 회수 가장 빠름', maxRoi: '수익률 가장 높음', leastTopup: '추가 입금 가장 적음' };

/** 정책을 사람이 읽는 문장으로. */
export function policyReadable(p) {
  if (!p) return '';
  if (p.switchDay !== undefined && p.switchDay !== null) return Number(p.switchDay) === 0 ? '매일 받기' : `처음 ${p.switchDay}일 재투자 → 이후 매일 받기`;
  const b = Number(p.recycleBps ?? 0);
  if (b === 0) return '매일 받기';
  if (b === 10000) return '보상 전부 재투자';
  return `보상 ${fmtN(b / 100, b % 100 === 0 ? 0 : b % 10 === 0 ? 1 : 2)}% 재투자 · 나머지 받기`;
}
/** DAI 금액 짧게: 소수 둘째 자리, .00이면 생략. */
export const fmtDaiShort = (v) => { const n = toNum(v); if (n === null) return 'N/A'; const r = Math.round(n * 100) / 100; return `${fmtN(r, Number.isInteger(r) ? 0 : 2)} DAI`; };

/**
 * 현재 장부의 막힘 원인(사건·일별 플래그·요약에서만 도출, 추측 없음).
 * kind: INVARIANT | FIXED_UNVERIFIED | LGNS_BURN_PENDING | ENTRY_NOT_EXECUTED | ENTRY_BLOCKED | CASH_SHORTAGE | GAS | REBURN_BLOCKED | null
 */
export function explainBlocking(out) {
  const r = out?.result; if (!r) return null;
  const sm = r.summary, evs = r.events ?? [], daily = r.daily ?? [];
  const returnedOnly = sm.W > 0n && sm.executedSellTokens === 0n && sm.W === (sm.endReturnDai ?? 0n);
  const base = { returnedOnly, W: sm.W };
  if (r.failed?.reason === 'INVARIANT') return { ...base, kind: 'INVARIANT', day: r.failed.day };
  if (sm.entryState === 'LGNS_BURN_PENDING' && out.scenario?.engine?.ignoreBurnCaps) {
    const gas = daily.find((x) => x.gasShort);
    if (gas) return { ...base, kind: 'GAS', day: gas.day, date: gas.date };
    return { ...base, kind: 'LGNS_BURN_PENDING', capIgnored: true };
  }
  if (sm.entryState && sm.entryState !== 'DONE') return { ...base, kind: sm.entryState };
  const hold = evs.find((e) => e.type === 'TURBINE_HOLD');
  if (hold) {
    const rec = daily.find((x) => x.day === hold.day);
    const first = !evs.some((e) => e.type === 'TURBINE' && e.day <= hold.day);
    return { ...base, kind: rec?.gasShort ? 'GAS' : 'CASH_SHORTAGE', day: hold.day, date: rec?.date ?? null, first,
      needDai: hold.needDai ?? null, cashDai: hold.cash ?? null, holdDays: daily.filter((x) => x.heldCredits > 0n).length };
  }
  const gas = daily.find((x) => x.gasShort);
  if (gas) return { ...base, kind: 'GAS', day: gas.day, date: gas.date };
  const bb = evs.find((e) => e.type === 'BURN_BLOCKED');
  if (bb) return { ...base, kind: 'REBURN_BLOCKED', day: bb.day, date: daily.find((x) => x.day === bb.day)?.date ?? null };
  return null;
}
/** 막힘 원인 → 사용자 문장. 금액은 그 시점 추정치이며 기간 전체 최소액·보장이 아님. */
export function blockingText(x) {
  if (!x) return null;
  const when = x.date ? `${x.date} ` : '';
  const main = {
    CASH_SHORTAGE: `${x.first ? '첫 ' : when}터빈 처리에 약 ${fmtDaiShort(x.needDai)}가 필요한데 운전자금은 ${fmtDaiShort(x.cashDai)}입니다.`,
    GAS: `${when}가스 잔액이 부족해 처리를 하지 못했습니다.`,
    FIXED_UNVERIFIED: 'FIXED 값이 확인되지 않아 지급을 계산하지 않았습니다.',
    LGNS_BURN_PENDING: x.capIgnored ? 'LGNS 소각이 계산 기간 안에 처리되지 않았습니다. 설정한 재개일과 가스를 확인하세요.' : 'LGNS 소각 한도가 0이라 LGNS가 Power로 바뀌지 않았습니다.',
    ENTRY_NOT_EXECUTED: '진입이 처리되지 않았습니다(예치 닫힘 또는 견적 없음).',
    ENTRY_BLOCKED: '진입이 막혀 있습니다.',
    REBURN_BLOCKED: `${when}재투자(재소각)가 막혀 일부 보상을 재투자하지 못했습니다.`,
    INVARIANT: '장부 검산이 맞지 않아 계산을 멈췄습니다.',
  }[x.kind] ?? '일부 처리가 보류되었습니다.';
  const notes = [];
  if (x.kind === 'CASH_SHORTAGE') notes.push('이 금액은 그 시점의 추정치이며 기간 전체에 필요한 최소액이나 보장이 아닙니다.');
  if (x.returnedOnly) notes.push(`받는 ${fmtDaiShort(x.W)}는 마지막 날 돌려받는 준비금이며 수익이 아닙니다.`);
  return { main, notes, fixable: x.kind === 'CASH_SHORTAGE' || x.kind === 'GAS' };
}

const UI_WAD = 10n ** 18n;
const maxBig = (...xs) => xs.reduce((m, x) => x > m ? x : m, 0n);

/**
 * 불완전 SELF 장부의 운전자금 제안. 현재 폼 값은 바꾸지 않는다.
 * 탐색 상한은 필요액을 찾기 위한 경계일 뿐이며, 표시할 총투입은 검증 재실행의 initialCapitalDai다.
 */
export function autoReservePlan(out, snapshot, { maxExpansions = 6 } = {}) {
  if (!out?.scenario || !out?.result || !snapshot) return { status: 'UNAVAILABLE' };
  if (cashResultReady(out)) return { status: 'NOT_NEEDED' };
  if (out.scenario.funding !== FUNDING.SELF) return { status: 'NOT_APPLICABLE', reason: 'SELF_ONLY' };
  const blocked = explainBlocking(out), bt = blockingText(blocked);
  if (!blocked || !bt?.fixable || out.result.summary.entryState !== 'DONE') {
    return { status: 'NOT_APPLICABLE', reason: blocked?.kind ?? out.result.summary.entryState ?? 'INCOMPLETE' };
  }
  const cost = out.quote?.economicCostDai ?? null;
  if (cost === null) return { status: 'COST_UNKNOWN' };
  const currentReserve = out.scenario.reserveDai;
  const currentTotal = out.result.summary.initialCapitalDai;
  if (currentTotal === null || currentTotal < currentReserve) return { status: 'COST_UNKNOWN' };
  const baseCost = currentTotal - currentReserve;
  const gas = out.scenario.engine.gas.anubisNativeDai;
  let reserveCap = maxBig(currentReserve, blocked.needDai ?? 0n, UI_WAD);
  let last = null;
  for (let i = 0; i <= maxExpansions; i++) {
    const searchBudget = cost + gas + reserveCap;
    const scenario = { ...out.scenario, funding: FUNDING.SELF, totalBudgetDai: searchBudget };
    const found = findMinReserve(scenario, snapshot, out.policy);
    last = found;
    if (found.status === 'NOT_EXECUTABLE' || found.status === 'COST_UNKNOWN') return { ...found, reason: found.failed?.reason ?? found.status };
    if (found.status === 'OK') {
      const reserveDai = maxBig(currentReserve, found.minReserve);
      const verified = simulate({ ...scenario, reserveDai }, snapshot, out.policy, { strict: true });
      const sm = verified.summary;
      if (!sm.completed || verified.failed || sm.topups !== 0n || sm.initialCapitalDai !== baseCost + reserveDai) {
        return { status: 'VERIFY_FAILED', failed: verified.failed ?? null };
      }
      const explicitBudget = out.budget?.derived === false ? out.budget.value : null;
      return {
        status: 'OK', label: found.label, currentReserve, reserveDai,
        additionalReserve: reserveDai > currentReserve ? reserveDai - currentReserve : 0n,
        baseCost, currentTotal,
        projectedTotal: sm.initialCapitalDai,
        explicitBudget,
        explicitBudgetShortfall: explicitBudget !== null && explicitBudget < sm.initialCapitalDai ? sm.initialCapitalDai - explicitBudget : 0n,
        searchBudget, replay: verified,
      };
    }
    reserveCap *= 2n;
  }
  return { status: 'SEARCH_LIMIT', failed: last?.failed ?? null, maxReserve: reserveCap / 2n };
}
const fundingLabel = (f) => (f === FUNDING.EXTERNAL ? '외부 DAI' : '비용 충당');

/**
 * OptimizeResult(optimizer-contract.md §3) → 표시용 그룹. 지표별 승자를 합치지 않는다.
 * winner는 metrics[k].winner, 재실행 검증은 replays[replayKey].verified.
 */
export function flattenOptimizeResult(res) {
  if (!res || !Array.isArray(res.results)) return [];
  return res.results.map((g) => ({
    horizonYears: g.horizonYears, horizonDays: g.horizonDays, funding: g.funding, candidatesEvaluated: g.candidatesEvaluated,
    nearBest: g.winners?.nearBest ?? null, conditional: g.conditional ?? null,
    rows: Object.keys(METRIC_LABEL).map((k) => {
      const m = g.winners?.[k];
      if (!m?.winner) return null;
      return { metric: k, label: METRIC_LABEL[k], cand: m.winner, tieCount: m.tieCount ?? 1, ties: m.ties ?? [],
        replayKey: m.replayKey ?? null, verified: m.replayKey ? g.replays?.[m.replayKey]?.verified ?? null : null,
        target: { policy: m.winner.policy, horizonYears: g.horizonYears, funding: g.funding, expectNet: m.winner.net == null ? undefined : String(m.winner.net) } };
    }).filter(Boolean),
  }));
}
const nearBestText = (nb) => {
  if (!nb) return '';
  const parts = [`최대 순이익 ${fmtBpsPct(nb.toleranceBps)} 이내 ${nb.count}개`];
  if (nb.ratioRange) parts.push(`비율 ${fmtBpsPct(nb.ratioRange[0])}~${fmtBpsPct(nb.ratioRange[1])}`);
  if (nb.switchRange) parts.push(`전환 ${nb.switchRange[0]}~${nb.switchRange[1]}회`);
  return parts.join(' · ');
};
const paybackText = (c) => (c.payback ? `${esc(c.payback.date)} (정산 ${c.payback.day + 1}회차)` : c.paybackDay != null ? `정산 ${Number(c.paybackDay) + 1}회차` : '미도달');

const paybackShort = (c) => (c.payback ? `${esc(c.payback.date)}` : c.paybackDay != null ? `${Number(c.paybackDay) + 1}일째 정산` : '기간 내 못 함');
/** 클릭 가능한 후보 행(정상 후보·사용자 직접 비교만). 조건부 후보에는 쓰지 않는다. */
function candRow(c, { extra = '', target = null, note = '' } = {}) {
  if (c.error) return `<tr><td>${esc(policyReadable(c.policy))}</td><td colspan="4" class="warn">${esc(c.error)}</td></tr>`;
  const t = target ?? { policy: c.policy };
  return `<tr class="clickable" tabindex="0" data-target='${esc(JSON.stringify(t))}'>
    <td>${extra}${esc(policyReadable(c.policy))}${c.completed === false ? ' <span class="warn">일부 보류</span>' : ''}${note}</td>
    <td>${fmtDai(c.W, 0)}</td><td class="${c.net !== null && c.net < 0n ? 'neg' : ''}">${fmtDai(c.net, 0)}</td><td>${fmtBpsPct(c.roiBps)}</td><td>${paybackShort(c)}</td></tr>`;
}
const CMP_HEAD = '<tr><th>전략</th><th>받는 금액</th><th>순이익</th><th>수익률</th><th>원금 회수</th></tr>';

/**
 * 정상 후보가 없는 기간이 있을 때의 안내. 조건부 최고값은 추천으로 보여주지 않는다.
 * headline은 비교 결과만으로 정한다(일부 기간 / 전체). current는 '현재 선택한 전략'의 장부에서 읽은 확인 사항이며
 * 비교한 모든 후보·기간의 원인이라고 주장하지 않는다.
 */
export function noWinnerMessage(out, res) {
  const groups = flattenOptimizeResult(res);
  const empty = groups.filter((g) => !g.rows.length);
  if (!empty.length) return null;
  const allEmpty = empty.length === groups.length;
  const headline = allEmpty ? '완료 가능한 전략을 찾지 못했습니다.' : '일부 기간에 완료 가능한 전략이 없습니다.';
  const x = explainBlocking(out), t = blockingText(x);
  const current = t ? { label: '현재 선택한 전략의 확인 사항', main: t.main, notes: t.notes, fixable: t.fixable, kind: x.kind } : null;
  const dataNote = res?.gate && !res.gate.ok ? '조회 데이터 일부가 확인되지 않아 모든 후보를 조건부로 분류했습니다.' : null;
  return { headline, allEmpty, emptyYears: empty.map((g) => g.horizonYears), current, dataNote };
}

const renderOptGroups = () => (st.opt.result ? optGroupsHtml(st.opt.result, st.out) : '');
/** 비교 결과 HTML(순수). 정상 후보만 클릭 가능(data-target), 조건부 값은 닫힌 진단에 글로만. */
export function optGroupsHtml(res, out) {
  if (!res) return '';
  const groups = flattenOptimizeResult(res), cur = Number(out?.scenario?.horizonYears ?? 0);
  const nw = noWinnerMessage(out, res);
  const derived = out?.budget?.derived;
  const c = nw?.current;
  const noWinnerHtml = nw ? `<div class="block-msg" role="status"><b>${esc(nw.headline)}</b>
      ${nw.allEmpty ? '' : ` <small>(${esc(nw.emptyYears.map((y) => `${y}년`).join(', '))})</small>`}
      ${nw.dataNote ? `<br>${esc(nw.dataNote)}` : ''}
      ${c ? `<br><small>${esc(c.label)}:</small> ${esc(c.main)}${c.notes.map((n) => `<br><small>${esc(n)}</small>`).join('')}
        ${c.fixable ? `<div class="actions"><button type="button" data-open-settings="reserveDai">준비금 조정</button><button type="button" data-minreserve>필요 운전자금 계산</button></div>
        ${derived ? '<small>총 초기예산을 비워 두어 준비금을 늘리면 그만큼 총투입도 늘어납니다. 계산은 늘어난 총투입 기준입니다.</small>' : ''}` : ''}` : ''}</div>` : '';
  const body = groups.map((g) => {
    const emph = g.horizonYears === cur;
    const rows = g.rows.map((r) => candRow(r.cand, { extra: `<b>${r.label}</b><br>`, target: r.target,
      note: r.verified === false ? ' <span class="warn">재계산 금액 다름</span>' : '' })).join('');
    return `<div class="opt-group${emph ? ' current' : ''}"><h3>${esc(g.horizonYears)}년${g.funding === FUNDING.EXTERNAL ? ' · DAI 추가 입금' : ''}${emph ? ' <span class="tag">지금 선택한 기간</span>' : ''}</h3>
      ${rows ? `<div class="tbl-wrap"><table><thead>${CMP_HEAD}</thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">이 기간에는 추천할 수 있는 전략이 없습니다.</p>'}</div>`;
  }).join('');
  const diag = groups.map((g) => {
    const c = g.conditional, bc = c?.bestConditional;
    return `<li>${esc(g.horizonYears)}년 · ${esc(fundingLabel(g.funding))}: 후보 ${esc(g.candidatesEvaluated ?? '?')}개${g.nearBest ? ` · ${esc(nearBestText(g.nearBest))}` : ''}
      ${c?.count ? `<br>조건부 ${c.count}개 — ${esc(Object.entries(c.byReason).map(([k, v]) => `${k} ${v}`).join(', '))}` : ''}
      ${bc ? `<br>조건부 최고(추천 아님, 적용 불가): ${esc(policyReadable(bc.policy))} · 받는 금액 ${fmtDai(bc.W, 0)} · 순이익 ${fmtDai(bc.net, 0)} · 수익률 ${fmtBpsPct(bc.roiBps)}` : ''}</li>`;
  }).join('');
  return `<p class="hint">내 기간(1/2/3년)을 고른 뒤, 받을 금액·순이익·원금 회수일을 비교하세요. 전략을 누르면 위 계산기에 적용됩니다.</p>
    ${noWinnerHtml}${body}
    <p class="hint">현재 가격과 조건이 그대로 유지된다는 가정의 계산입니다.</p>
    <details class="diag"><summary>비교 진단</summary><ul class="warn-list">${diag}</ul>
      <p class="hint">${esc(res.label ?? '')} · 비교 예산 ${fmtDai(res.metadata?.totalBudgetDai)} · 운전자금 ${fmtDai(res.metadata?.reserveDai)} · 가격 ${esc(res.metadata?.priceAssumption ?? '')} · 데이터 ${esc(res.metadata?.snapshotMode ?? '')}
      ${res.gate && !res.gate.ok ? ` · 데이터 격리: ${esc(res.gate.reasons.join(', '))}` : ''}</p>
      ${res.notes?.length ? `<ul class="warn-list">${res.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</details>`;
}

function renderCompare() {
  const box = $('compare-body'); if (!box) return;
  const o = st.opt, a = st.inputValid ? o.applied : null;
  let result = '';
  if (a) {
    const s = a.replay.full.summary, plan = a.plan, pb = s.paybackDay == null ? null : a.replay.full.daily[s.paybackDay];
    const price = a.replay.full.daily[0]?.price ?? null, aiEq = cashAiEquivalent(s.W, price);
    const aiBasis = st.out?.marketUse?.ailgns?.source === 'SPOT' ? '조회 spot 기준 환산'
      : st.out?.marketUse?.ailgns?.source === 'SAVED_TWAP' ? '저장 TWAP 기준 환산' : '계산 기준 가격 환산';
    result = `<div class="strategy-result" role="status"><p class="section-kicker">검색한 단일 전환 정책 중 현금 ROI 최대</p>
      <h3>${esc(plan.label)}</h3>
      <p class="strategy-dates">${plan.lastReburnDate ? `마지막 실제 재소각 ${esc(plan.lastReburnDate)} (${plan.lastReburnDay}회차)` : '실제 재소각 없음'} · ${plan.firstCashDate ? `첫 실제 현금 ${esc(plan.firstCashDate)} (${plan.firstCashDay}회차)` : '기간 내 실제 현금 없음'}</p>
      <div class="strategy-metrics"><span><small>누적 실제 현금</small><b>${fmtDai(s.W, 0)}</b></span><span><small>현금 ROI</small><b>${fmtBpsPct(s.roiBps)}</b></span><span><small>순이익</small><b>${fmtDai(s.net, 0)}</b></span><span><small>원금 회수</small><b>${pb ? `${esc(pb.date)} · ${pb.day + 1}회차` : '기간 내 미회수'}</b></span></div>
      <p class="hint">${plan.switchDay === 0 ? '이 조건에서는 재소각 없이 처음부터 보상을 현금화하는 경로가 가장 높았습니다.' : '터빈 비용을 충당할 만큼만 먼저 매도하고, 남은 AiLGNS를 전환일까지 재소각하여 POWER로 활성화합니다. 전환일 이후 보상은 재소각하지 않고 현금으로 받습니다.'}</p></div>`;
  } else if (o.result) {
    result = optimizerFailureHtml(o.result);
  }
  box.innerHTML = `<p class="hint">받은 AiLGNS 중 터빈 비용·매도세·풀 수수료를 충당할 만큼 매도하고, 나머지를 다시 소각하여 POWER로 활성화합니다. 늘어난 POWER에서 보상을 받은 뒤 같은 과정을 반복합니다.</p><p class="hint">선택 기간이 끝날 때 현금 수익률이 가장 높도록, 재소각을 멈추고 보상을 현금으로 받기 시작할 날짜를 비교합니다. 전환 뒤에는 재소각하지 않고 매일 현금화합니다.</p>
    <div class="actions"><button type="button" id="btn-opt" class="primary" ${o.running || !st.inputValid ? 'disabled' : ''}>${o.hasRun ? '최대 효율 다시 계산' : '최대 효율 계산하기'}</button>
      ${o.running ? '<button type="button" id="btn-opt-cancel">취소</button>' : ''}</div>
    <p class="hint" id="opt-status" aria-live="polite">${esc(o.status)}</p>${result}
    <p class="hint">미래 가격·배출률·수수료가 현재 조건으로 유지된다는 조건부 계산입니다. 첫 터빈 비용에는 준비 DAI가 먼저 필요합니다.</p>`;
  $('btn-opt').onclick = runOptimizer;
  const cb = document.getElementById('btn-opt-cancel');
  if (cb) cb.onclick = () => { cancelOptimizer('취소했습니다 — 이전 탐색 결과는 버림'); renderCompare(); };
}

function optimizerFailureHtml(res) {
  const g = res?.results?.find((x) => x.horizonYears === Number(st.out?.scenario?.horizonYears)) ?? res?.results?.[0];
  if (g?.winners?.maxRoi?.winner) return '<div class="block-msg">전체 장부 재검산이 일치하지 않아 추천을 적용하지 않았습니다.</div>';
  const by = g?.conditional?.byReason ?? {};
  let why = res?.gate && !res.gate.ok ? '현재 조회 데이터가 미확정이어서 정상 후보로 검증하지 못했습니다.'
    : by.OVER_BUDGET ? '고정한 초기예산 안에서 완료되는 후보가 없습니다.'
      : '현재 준비금·가스·처리 조건으로 완료 가능한 후보가 없습니다.';
  const current = blockingText(explainBlocking(st.out));
  const diag = Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · ');
  return `<div class="block-msg" role="status"><b>${esc(why)}</b>${current ? `<br>${esc(current.main)}${current.notes.map((n) => `<br><small>${esc(n)}</small>`).join('')}${current.fixable ? '<div class="actions"><button type="button" data-open-settings="reserveDai">준비금 조정</button><button type="button" data-minreserve>필요 운전자금 계산</button></div>' : ''}` : ''}${diag ? `<details class="diag"><summary>제외 원인 보기</summary><small>${esc(diag)}</small></details>` : ''}</div>`;
}
/** 후보 → 폼 값. 기간·자금 방식·정책을 모두 반영(외부 한도는 폼에 이미 있는 값을 그대로 사용). */
export function candidateToFields(target) {
  const f = {}, p = target.policy ?? {};
  if (target.horizonYears) f.horizonYears = String(target.horizonYears);
  if (target.funding) f.funding = target.funding;
  if (p.switchDay !== undefined && p.switchDay !== null) { f.usage = 'switch'; f.policyType = 'switch'; f.switchDay = String(p.switchDay); }
  else {
    const pct = Number(p.recycleBps ?? 0) / 100;
    f.usage = pct === 0 ? 'sell' : 'partial'; f.policyType = 'ratio'; f.recyclePct = String(pct);
  }
  return f;
}
function applyCandidate(target) {
  for (const [k, v] of Object.entries(candidateToFields(target))) setField(k, v);
  const keep = st.opt.result;
  recompute();
  st.opt.result = keep;
  if (st.out?.result && target.expectNet !== undefined) {
    st.opt.status = String(st.out.result.summary.net) === String(target.expectNet) ? '선택한 전략을 계산기에 적용했습니다.' : '적용했지만 비교 때와 금액이 다릅니다 — 가정과 경고를 확인하세요.';
  }
  renderCompare();
}

/**
 * Worker 핸들. 번들: globalThis.__HELIX_WORKER_SRC__ → Blob URL classic worker(terminate 시 URL revoke).
 * 개발: 모듈 worker. 만들 수 없으면 null(메인 스레드 optimize로 대체).
 */
export function makeWorkerHandle({ WorkerCtor = globalThis.Worker, urlApi = globalThis.URL, onLoadError } = {}) {
  if (typeof WorkerCtor !== 'function') return null;
  let w, blobUrl = null;
  try {
    if ('__HELIX_WORKER_SRC__' in globalThis) {
      const src = globalThis.__HELIX_WORKER_SRC__;
      if (!src) return null;
      blobUrl = urlApi.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      w = new WorkerCtor(blobUrl);
    } else w = new WorkerCtor(new URL('./optimizer.worker.js', import.meta.url), { type: 'module' });
  } catch { if (blobUrl) urlApi.revokeObjectURL(blobUrl); return null; }
  let alive = true;
  const h = {
    postMessage: (m) => w.postMessage(m),
    terminate() { if (!alive) return; alive = false; w.terminate(); if (blobUrl) { urlApi.revokeObjectURL(blobUrl); blobUrl = null; } },
    set onmessage(f) { w.onmessage = f; },
    get revoked() { return blobUrl === null; },
  };
  w.onerror = (e) => { e?.preventDefault?.(); if (alive) { h.terminate(); onLoadError?.(e?.message ?? '로드 실패'); } };
  return h;
}

/** worker 요청 본문(contract §2). scenario는 정규화 결과 + 고정 비교예산. */
export function optimizeRequest(out, snapshot) {
  const scenario = { ...withBudget(out.scenario, out.budget), funding: FUNDING.SELF };
  return { scenario, snapshot, horizons: [Number(scenario.horizonYears)], fundings: [FUNDING.SELF], search: { mode: 'switch-only' } };
}

function cancelOptimizer(reason) {
  const o = st.opt;
  o.mainJob = (o.mainJob ?? 0) + 1;           // 메인 스레드 대체 실행 무효화
  if (o.signal) o.signal.aborted = true;
  if (o.running) { o.client?.cancel(); o.status = reason; }   // client.cancel: jobId++ 후 terminate(→ Blob URL revoke)
  else if (o.result) o.status = '';
  o.running = false; o.result = null;
}
function onOptProgress(m) {
  st.opt.status = `비교 중${m.horizonYears ? ` · ${m.horizonYears === 0.5 ? '6개월' : `${m.horizonYears}년`}` : ''} · ${m.done}/${m.total}`;
  const p = document.getElementById('opt-status'); if (p) p.textContent = st.opt.status;
}
function onOptResult(res) {
  const o = st.opt;
  if (!st.inputValid) return;
  o.running = false; o.result = res; o.hasRun = true; o.applied = null;
  const year = Number(st.out?.scenario?.horizonYears), g = res?.results?.find((x) => x.horizonYears === year) ?? res?.results?.[0];
  const metric = g?.winners?.maxRoi, winner = metric?.winner, replay = metric?.replayKey ? g.replays?.[metric.replayKey] : null;
  const exact = replay?.verified === true && winner && ['I', 'W', 'net', 'paybackDay'].every((k) => replay.full.summary[k] === winner[k]);
  if (!exact) {
    o.status = winner ? '전체 장부 재검산이 일치하지 않아 추천을 적용하지 않았습니다.' : '완료 가능한 단일 전환 정책을 찾지 못했습니다.';
    renderCompare(); return;
  }
  const plan = switchPlanView(replay.full, winner.policy);
  for (const [k, v] of Object.entries(candidateToFields({ policy: winner.policy, horizonYears: g.horizonYears, funding: FUNDING.SELF }))) setField(k, v);
  o.applied = { plan, winner, replay };
  const valid = recompute({ preserveOptimizer: true });
  const applied = st.out?.result?.summary;
  const same = valid && st.inputValid && applied && ['I', 'W', 'net', 'paybackDay'].every((k) => applied[k] === winner[k]);
  if (!same) {
    o.applied = null; resetBaselinePolicy(); recompute({ preserveOptimizer: true });
    o.status = valid ? '적용 후 전체 장부 금액이 달라 추천을 적용하지 않았습니다.' : '입력값 또는 시세 상태가 바뀌어 추천을 적용하지 않았습니다.';
  } else o.status = `${g.horizonYears === 0.5 ? '6개월' : `${g.horizonYears}년`} 전체 ${g.candidatesEvaluated}개 전환일을 검산하고 자동 적용했습니다.`;
  renderCompare();
}
function onOptError(msg) { st.opt.running = false; st.opt.status = `탐색 실패: ${msg}`; renderCompare(); }

function runMainThread(req) {
  const job = ++st.opt.mainJob, signal = { aborted: false };
  st.opt.signal = signal; st.opt.running = true;
  st.opt.client = { cancel() { signal.aborted = true; } };
  st.opt.status = 'Worker 사용 불가 — 메인 스레드에서 탐색(화면이 느려질 수 있음)';
  renderCompare();
  optimize({ scenario: req.scenario, snapshot: st.snapshot, years: req.horizons, fundings: req.fundings }, { signal, search: req.search, onProgress: (p) => { if (job === st.opt.mainJob) onOptProgress(p); } })
    .then((res) => { if (job === st.opt.mainJob && !res.cancelled) onOptResult(res); })
    .catch((e) => { if (job === st.opt.mainJob) onOptError(e.message); });
}

function runOptimizer() {
  cancelOptimizer('');
  if (!st.inputValid || !st.out?.scenario) { st.opt.status = '입력 오류를 먼저 해결하세요.'; renderCompare(); return; }
  if (reserveModeOf(readForm()) === 'AUTO' && st.reserveAdvice.status === 'loading') { st.opt.status = '운전자금 자동 산정이 끝난 뒤 계산하세요.'; renderCompare(); return; }
  st.opt.applied = null;
  if (!recompute({ preserveOptimizer: true })) { st.opt.status = '입력 오류를 먼저 해결하세요.'; renderCompare(); return; }
  const req = optimizeRequest(st.out, st.snapshot);
  if (!makeWorkerAvailable()) { runMainThread(req); return; }
  let fellBack = false;
  const client = createOptimizerClient({
    createWorker: () => makeWorkerHandle({ onLoadError: (msg) => { if (fellBack || st.opt.client !== client) return; fellBack = true; st.opt.running = false; st.opt.status = `Worker 로드 실패(${msg})`; runMainThread(req); } }),
    onProgress: onOptProgress,
    onResult: (m) => onOptResult(m.results),
    onError: (m) => onOptError(m.message),
  });
  st.opt.client = client; st.opt.running = true; st.opt.status = '탐색 준비 중…';
  try { client.run(req); } catch (e) { fellBack = true; st.opt.running = false; runMainThread(req); return; }
  renderCompare();
}
const makeWorkerAvailable = () => typeof Worker === 'function' && !('__HELIX_WORKER_SRC__' in globalThis && !globalThis.__HELIX_WORKER_SRC__);

// ---- H. 경고·출처·장부·내보내기 ----
const PAGE = 60;
function renderMore() {
  const { result } = st.out, snap = st.snapshot;
  const isWarn = (x) => /CONSERVATION|부족|보류|0 유지|검증대기|미완료/.test(x);
  const w = result.warnings.map((x) => `<li class="${isWarn(x) ? 'warn' : ''}">${esc(x)}</li>`).join('');
  const nWarn = result.warnings.filter(isWarn).length;
  $('warn-summary').textContent = `가정 ${result.warnings.length - nWarn}개${nWarn ? ` · 주의 ${nWarn}개` : ''}`;
  $('warnings').innerHTML = `<ul class="warn-list">${w}</ul>${result.failed ? `<p class="warn">중단: ${esc(result.failed.day + 1)}일째 ${esc(result.failed.reason)}</p>` : ''}
    <p class="hint">미래는 현재 조건 유지 가정입니다. 지급 중단·가격·수수료·편입 지연은 입력한 시나리오만 반영하며 확률을 붙이지 않습니다. POWER는 정산마다 줄며 정수 절삭·수수료·한도로 유한 기간 안에 배출이 멈출 수 있습니다.</p>`;
  const prov = Object.entries(result.summary.params ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  const vals = Object.entries(snap?.values ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${esc(v.value ?? 'null')}</td><td>${esc(v.unit)}</td><td>${badge(v.status)}</td>
    <td>${esc(v.blockNumber ?? '')}</td><td>${esc(v.sourceUrl ?? '')}</td><td>${esc(v.method ?? '')}</td><td>${esc(v.notes)}</td></tr>`).join('');
  $('sources').innerHTML = `<h3>계산에 쓴 값의 출처</h3><div class="tbl-wrap"><table><tbody>${prov}</tbody></table></div>
    <h3>스냅샷 (${esc(snap?.mode ?? '없음')}, ${esc(kstTime(snap?.meta?.fetchedAt))})</h3>
    <div class="tbl-wrap"><table><thead><tr><th>키</th><th>원값</th><th>단위</th><th>상태</th><th>블록</th><th>출처</th><th>method</th><th>메모</th></tr></thead><tbody>${vals}</tbody></table></div>
    <p class="hint">저장 스냅샷은 LIVE로 표시하지 않습니다. null은 미조회이며 0이 아닙니다. 계산에 사용한 RPC·API·조회 블록은 위 표와 JSON 내보내기에 기록됩니다.</p>`;
  if ($('d-ledger').open) renderLedger();
}
function renderLedger(followPin = false) {
  const d = st.out.result.daily, pages = Math.max(1, Math.ceil(d.length / PAGE));
  if (followPin && st.pinned !== null) st.ledgerPage = Math.floor(st.pinned / PAGE);
  const p = Math.min(st.ledgerPage, pages - 1), rows = d.slice(p * PAGE, (p + 1) * PAGE);
  const start = st.out.scenario.startDate;
  const cols = [['정산일', (r) => esc(r.date)], ['회차', (r) => r.day + 1], ['시작 후 일', (r) => recordTiming(r, start).elapsed ?? ''], ['활성 Power', (r) => fmtN(toNum(r.activePowerEnd), 0)], ['대기 Power', (r) => fmtN(toNum(r.pendingPower), 0)],
    ['정산 DAI', (r) => fmtN(toNum(r.emissionDai), 2)], ['터빈 매수', (r) => fmtN(toNum(r.turbineBuyDai), 2)], ['충당 매도 DAI', (r) => fmtN(toNum(r.coverSaleDai + r.reserveSaleDai), 2)],
    ['재소각 AiLGNS', (r) => fmtN(toNum(r.burnTokens), 4)], ['외부 투입', (r) => fmtN(toNum(r.externalTopup), 2)], ['외부 인출', (r) => fmtN(toNum(r.externalWithdrawal), 2)],
    ['누적 회수', (r) => fmtN(toNum(r.cumWithdrawal), 2)], ['순손익', (r) => fmtN(toNum(r.net), 2)], ['내부 DAI', (r) => fmtN(toNum(r.cash), 2)]];
  $('ledger').innerHTML = `<div class="ledger-nav"><button type="button" data-pg="-1" ${p === 0 ? 'disabled' : ''}>이전</button><span>${p + 1} / ${pages} 쪽 (${d.length}일)</span>
    <button type="button" data-pg="1" ${p >= pages - 1 ? 'disabled' : ''}>다음</button><span class="hint">행을 누르면 그래프 날짜 고정 · 전체 열은 CSV</span></div>
    <div class="tbl-wrap"><table><thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map((r) =>
      `<tr class="clickable${r.day === st.pinned ? ' selected' : ''}" tabindex="0" data-day="${r.day}">${cols.map((c) => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  $('ledger').querySelectorAll('[data-pg]').forEach((b) => { b.onclick = () => { st.ledgerPage = p + Number(b.dataset.pg); renderLedger(); }; });
  bindRowJump($('ledger'));
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) return null;
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function exportJson() {
  if (!st.inputValid || !st.out?.result) return;
  const payload = buildExport({ ...st.out, snapshot: st.snapshot, changelog: st.changelog, market: st.market });
  const body = JSON.stringify(payload, jsonReplacer);
  payload.sha256 = await sha256Hex(body); payload.sha256Note = 'sha256 필드를 뺀 본문 JSON의 해시';
  download(`helix-sim-${st.out.scenario.startDate}-${st.out.scenario.horizonYears}y.json`, JSON.stringify(payload, jsonReplacer, 2), 'application/json');
}
function exportCsv() {
  if (!st.inputValid || !st.out?.result) return;
  download(`helix-sim-ledger-${st.out.scenario.startDate}-${st.out.scenario.horizonYears}y.csv`, ledgerToCsv(st.out.result.daily), 'text/csv;charset=utf-8');
}

// ---- 운전자금: 최소 필요액 탐색(총 비교예산 안) · 예시값 ----
/** findMinReserve 결과 → 한국어 설명. */
export function minReserveText(r, budget) {
  const b = fmtDai(budget?.value);
  if (!r) return '';
  if (r.status === 'OK') return `필요 운전자금(탐색값) ${fmtDai(r.minReserve)} — ${r.label}. 비교 예산 ${b} 안에서 보류 없이 장부가 끝난 조건부 추정값입니다.`;
  if (r.status === 'COST_UNKNOWN') return '원금이 미확정이라 계산할 수 없습니다(LGNS 순매도 견적 또는 매입원가 필요).';
  if (r.status === 'NOT_EXECUTABLE') return `운전자금과 무관하게 장부가 완료되지 않습니다(${r.failed?.reason ?? '진입/편입 대기'}). 경로 상태를 확인하세요.`;
  const day = r.failed?.day != null ? ` 정산 ${r.failed.day + 1}회차에서 부족(${r.failed.reason ?? ''})` : '';
  return `비교 예산 ${b} 안에서는 부족합니다(운전자금으로 쓸 수 있는 최대 ${fmtDai(r.maxReserve)}).${day} 총 초기예산을 늘려 입력한 뒤 다시 계산하세요.`;
}
function doMinReserve() {
  const box = $('minreserve-out');
  if (!st.inputValid || !st.out?.scenario) { box.textContent = '먼저 입력 오류를 해결하세요.'; return; }
  box.textContent = '계산 중… (여러 번 장부를 다시 실행합니다)';
  const out = st.out;
  setTimeout(() => {
    if (st.out !== out || !st.inputValid) { box.textContent = '입력이 바뀌어 계산을 취소했습니다.'; return; }
    try {
      if (!cashResultReady(out)) {
        const p = autoReservePlan(out, st.snapshot);
        if (p.status === 'OK') {
          box.innerHTML = `운전자금 추정 ${fmtDai(p.reserveDai)} · 현재보다 별도 추가 ${fmtDai(p.additionalReserve)} · 적용 후 총투입 ${fmtDai(p.projectedTotal)}. 현재 ${esc(policyReadable(out.policy))} 경로·선택 기간 전체 재실행 완료, 외부 추가 입금 0. 모든 전략의 최소값이나 실제 필요액 보장은 아닙니다. <button type="button" id="btn-apply-reserve">이 값 적용</button>`;
          const btn = document.getElementById('btn-apply-reserve');
          btn.onclick = () => { if (!st.inputValid || st.out !== out) return; setField('reserveMode', 'MANUAL'); st.reserveAuto.dirty = false; setField('reserveDai', formatUnits(p.reserveDai, 18)); recompute(); };
        } else box.textContent = '현재 정책과 선택 기간에서는 운전자금 추정값을 만들지 못했습니다. 경로 상태나 다른 전략을 확인하세요.';
        return;
      }
      if (out.budget?.value == null) { box.textContent = '비교 예산이 미확정이라 계산할 수 없습니다.'; return; }
      const r = findMinReserve(withBudget(out.scenario, out.budget), st.snapshot, out.policy);
      box.innerHTML = esc(minReserveText(r, out.budget)) + (r.status === 'OK' ? ' <button type="button" id="btn-apply-reserve">이 값 적용</button>' : '');
      const btn = document.getElementById('btn-apply-reserve');
      if (btn) btn.onclick = () => { if (!st.inputValid || st.out !== out) return; setField('reserveMode', 'MANUAL'); st.reserveAuto.dirty = false; setField('reserveDai', formatUnits(r.minReserve, 18)); recompute(); };
    } catch (e) { box.textContent = `계산 불가: ${e.message}`; }
  }, 30);
}
function applyExample() {
  for (const [k, v] of Object.entries(EXAMPLE_VALUES)) setField(k, v);
  setField('reserveMode', 'AUTO'); st.reserveAuto.dirty = true;
  logChange(['예시 조건 다시 적용: 운전자금 20 DAI · Anubis 가스 보유 40 DAI(예시, 측정값 아님) · 가스 부족 시 내부 DAI 보충(환전·가스비 가정) · 즉시 수령 5000bps']);
  recompute();
}

// ---- 시작 ----
async function loadSavedSnapshot() {
  let json = null;
  const tag = document.getElementById('snapshot-data');
  if (tag) { try { json = JSON.parse(tag.textContent); } catch { json = null; } }
  if (!json) { try { const r = await fetch('../evidence/snapshot.json'); if (r.ok) json = await r.json(); } catch { json = null; } }
  if (!json) return validateSnapshot({ schemaVersion: 'helix-sim-snapshot/1', mode: 'MANUAL', meta: {}, values: {} }).snapshot;
  return snapshotFromEvidence(json.rawEvidence ?? json);
}

export async function init() {
  setField('startDate', todayKst());
  // 첫 화면 0 결과 방지: 예시 조건을 처음 한 번만 적용(이후 사용자 입력을 덮지 않음).
  for (const [k, v] of Object.entries(EXAMPLE_VALUES)) setField(k, v);
  st.changelog.push({ at: new Date().toISOString(), text: '처음 화면 예시 조건 적용: 운전자금 20 · 가스 40 DAI(측정값 아님) · 가스 부족 시 내부 DAI 보충(환전·가스비 가정) · 즉시 수령 5000bps' });
  // 저장 파일은 계약 주소·메서드 목록으로만 사용하고, 첫 계산 전 실시간 조회한다.
  st.snapshot = await loadSavedSnapshot();
  renderDataBar();

  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-open-settings]');
    if (b) { e.preventDefault(); openSettings(b.dataset.openSettings); }
    if (e.target.closest?.('[data-minreserve]')) { $('input-details').open = true; $('settings').open = true; doMinReserve(); $('minreserve-out').scrollIntoView({ block: 'center' }); }
    if (e.target.closest?.('[data-apply-auto-reserve]')) {
      e.preventDefault();
      const a = st.reserveAdvice, p = a.plan;
      if (!st.inputValid || a.out !== st.out || a.status !== 'ready' || p?.status !== 'OK') return;
      setField('reserveMode', 'MANUAL'); st.reserveAuto.dirty = false; setField('reserveDai', formatUnits(p.reserveDai, 18));
      logChange([`운전자금 추정값 적용: ${fmtDai(p.currentReserve)} → ${fmtDai(p.reserveDai)} (별도 추가 ${fmtDai(p.additionalReserve)}, 적용 후 총투입 ${fmtDai(p.projectedTotal)})`]);
      recompute();
    }
  });
  // 원화 금액·LGNS 수량 쉼표: 입력·붙여넣기·통화 전환 때 서식, 한글 조합 중에는 건드리지 않음. 통화 전환 시 금액 환산은 하지 않는다.
  const amountEl = $('inputs').elements.amount;
  const usesGrouping = () => ['KRW', 'LGNS'].includes(readForm().asset);
  const fmtAmount = () => {
    const caret = amountEl.selectionStart ?? amountEl.value.length;
    const r = reformatWithCaret(amountEl.value, caret, usesGrouping());
    if (r.value !== amountEl.value) {
      amountEl.value = r.value;
      if (document.activeElement === amountEl) { try { amountEl.setSelectionRange(r.caret, r.caret); } catch { /* 일부 input 유형 미지원 */ } }
    }
  };
  amountEl.addEventListener('input', (e) => { if (!e.isComposing) fmtAmount(); });
  amountEl.addEventListener('compositionend', fmtAmount);
  $('inputs').querySelectorAll('[name="currency"], [name="assetGroup"]').forEach((r) => r.addEventListener('change', fmtAmount));
  $('inputs').querySelectorAll('[data-switch]').forEach((b) => { b.onclick = () => { setField('switchDay', b.dataset.switch); recompute(); }; });
  let t = null;
  const prepareReserveEdit = (target) => {
    if (target?.name === 'startDate') st.startDateEdited = true;
    if (target?.name === 'reserveDai') { setField('reserveMode', 'MANUAL'); st.reserveAuto.dirty = false; return; }
    if (target?.name === 'reserveMode') { st.reserveAuto.dirty = target.value === 'AUTO'; return; }
    if (reserveModeOf(readForm()) === 'AUTO') st.reserveAuto.dirty = true;
  };
  $('inputs').addEventListener('input', (e) => {
    prepareReserveEdit(e.target);
    st.inputValid = false; st.opt.applied = null; resetBaselinePolicy(); invalidateReserveAdvice();
    cancelOptimizer('입력 변경으로 이전 추천을 지웠습니다.');
    document.querySelectorAll('.results > .card:not(.results-summary):not(.strategy)').forEach((c) => c.classList.add('stale-result'));
    $('quick-summary').innerHTML = '<p class="qs-pending">입력 반영 중 · 이전 추천을 지웠습니다.</p>';
    renderCompare(); clearTimeout(t); t = setTimeout(recompute, 300);
  });
  $('inputs').addEventListener('change', (e) => { prepareReserveEdit(e.target); clearTimeout(t); recompute(); });
  document.querySelectorAll('[name="horizonYears"][form="inputs"]').forEach((r) => r.addEventListener('change', () => {
    const rerun = st.opt.hasRun;
    if (reserveModeOf(readForm()) === 'AUTO') st.reserveAuto.dirty = true;
    clearTimeout(t); const valid = recompute();
    if (rerun && valid) st.opt.rerunTimer = setTimeout(runOptimizer, 250);
  }));
  $('inputs').addEventListener('submit', (e) => e.preventDefault());
  $('btn-live').onclick = doLive;
  $('btn-apply').onclick = applyPending;
  $('d-ledger').addEventListener('toggle', () => { if ($('d-ledger').open && st.out?.result) renderLedger(); });
  $('btn-json').onclick = exportJson; $('btn-csv').onclick = exportCsv;
  $('btn-minreserve').onclick = doMinReserve; $('btn-example').onclick = applyExample;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.pinned !== null) st.charts?.pin(null); });
  // Expiration is checked even without user input; visibility resume immediately refreshes.
  setInterval(() => {
    renderDataBar();
    if (st.inputValid && (liveCalculationErrors(st.snapshot).length || applyMarket(readForm(), st.market).errors.length)) recompute({ preserveOptimizer: true });
  }, 1000);
  setInterval(() => { if (document.visibilityState === 'visible') doLive(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { recompute({ preserveOptimizer: true }); doLive(); }
  });
  const liveReady = doLive();
  recompute();
  await liveReady;
}

if (typeof document !== 'undefined' && document.getElementById('inputs')) init();
