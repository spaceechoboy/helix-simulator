// UI 순수 함수·번들러 테스트. 실행: node --test tests/ui.test.js (DOM 불필요)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formToRaw, formToPolicy, compute, chartModel, ledgerToCsv, mergeLive, derive, fmtDai, fmtBpsPct, roiBpsOf, routesFor, jsonReplacer, buildExport, LEDGER_COLUMNS,
  withBudget, recordTiming, EXAMPLE_VALUES, minReserveText, optimizeRequest, flattenOptimizeResult, candidateToFields, makeWorkerHandle, OPTIMIZER_PROTOCOL, resultStatus, resultStatusText,
  applySimpleForm, reserveSummary, singleChartModel, milestoneCards, applyMarket, quickSummaryRows, quickSummaryBasis, krwRate,
  groupDigits, stripGrouping, reformatWithCaret, explainBlocking, blockingText, noWinnerMessage, optGroupsHtml, policyReadable,
  conversionSummary, daySampleRows, switchPlanView, cashAiEquivalent, cashResultReady, cashPresentation, autoReservePlan, reserveModeOf } from '../src/ui.js';
import { formatUnits } from '../src/decimal.js';
import { snapshotFromEvidence } from '../src/data.js';
import { daysBetween } from '../src/dates.js';
import { optimize, createOptimizerClient } from '../src/strategies.js';
import { indexAt, niceTicks } from '../src/charts.js';
import { bundle } from '../build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = snapshotFromEvidence(JSON.parse(readFileSync(join(ROOT, 'evidence/snapshot.json'), 'utf8')).rawEvidence);
const BASE = {
  asset: 'DAI', amount: '1000', startDate: '2026-10-23', funding: 'SELF', reserveDai: '0', horizonYears: '1', periodMode: 'CALENDAR',
  priceModel: 'LINEAR', policyType: 'ratio', recyclePct: '0', 'gas.anubisNativeDai': '1', 'gas.polygonNativeDai': '0.5',
  'engine.entryLagDays': '1', 'engine.reburnLagDays': '1', 'engine.poolFeeBps': '30', 'engine.immediateBps': '0', 'engine.returnCashAtEnd': true,
};
const F = (o = {}) => ({ ...BASE, ...o });

// ---- 원화 쉼표·시작 자산 그룹 ----
test('원화 쉼표: 그룹·소수·음수·붙여넣기·형식 밖 값', () => {
  assert.equal(groupDigits('10000000'), '10,000,000');
  assert.equal(groupDigits(''), '');
  assert.equal(groupDigits('1234.5'), '1,234.5');
  assert.equal(groupDigits('1234.'), '1,234.');
  assert.equal(groupDigits('0.001'), '0.001');
  assert.equal(groupDigits('-1234'), '-1,234');               // 부호 유지(검증이 음수를 막음)
  assert.equal(groupDigits('1,2,3,4'), '1,234');               // 잘못 끼운 쉼표 정리
  assert.equal(groupDigits('12a'), '12a');                     // 숫자 형식 밖은 그대로
  assert.equal(groupDigits('-'), '-');
  assert.equal(stripGrouping('10,000,000'), '10000000');
});

test('원화 쉼표: 커서는 쉼표 아닌 글자 수 기준으로 복원', () => {
  assert.deepEqual(reformatWithCaret('1234567', 4, true), { value: '1,234,567', caret: 5 });   // 1234|567 → 1,234|,567
  assert.deepEqual(reformatWithCaret('1,234,56', 8, true), { value: '123,456', caret: 7 });     // 삭제 후 끝
  assert.deepEqual(reformatWithCaret('1,000', 0, true), { value: '1,000', caret: 0 });
  assert.deepEqual(reformatWithCaret('1,234,567', 5, false), { value: '1234567', caret: 4 });  // DAI로 전환 시 쉼표 제거
});

test('쉼표 금액은 그대로 계산, 음수는 양수로 바뀌지 않고 오류', () => {
  const ok = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, assetGroup: 'cash', currency: 'KRW', amount: '1,500,000', 'fx.daiKrw': '1,400' })), SNAP);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.scenario.amount, 1500000n * 10n ** 18n);
  const neg = compute(applySimpleForm(F({ assetGroup: 'cash', currency: 'KRW', amount: '-1,000', 'fx.daiKrw': '1400' })), SNAP);
  assert.ok(neg.errors.some((e) => /음수|양수/.test(e)));
  assert.equal(neg.scenario, undefined);
});

test('시작 자산 그룹: DAI·원화/LGNS → 엔진 asset, 통화 기억, 기존 asset 계약 유지', () => {
  assert.equal(applySimpleForm(F({ assetGroup: 'cash', currency: 'KRW' })).asset, 'KRW');
  assert.equal(applySimpleForm(F({ assetGroup: 'cash', currency: 'DAI' })).asset, 'DAI');
  assert.equal(applySimpleForm(F({ assetGroup: 'cash' })).asset, 'DAI');
  assert.equal(applySimpleForm(F({ assetGroup: 'LGNS', currency: 'KRW' })).asset, 'LGNS');     // 통화 값은 남아 있어 다시 현금으로 오면 원화
  assert.equal(applySimpleForm(F({ asset: 'KRW' })).asset, 'KRW');
  const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
  assert.match(html, /aria-labelledby="lbl-asset"/); assert.match(html, /aria-label="입력 통화"/);
  assert.match(html, /<option value="anubis" selected>/);
  assert.deepEqual(routesFor('anubis')[0], 'ANUBIS_LGNS_BURN');
  assert.deepEqual(routesFor('polygon')[0], 'POLYGON_FIXED');
  // 후보 적용은 자산·통화를 바꾸지 않음
  const g = applySimpleForm({ ...F({ assetGroup: 'cash', currency: 'KRW' }), ...candidateToFields({ policy: { recycleBps: null, switchDay: 60 }, horizonYears: 2, funding: 'SELF' }) });
  assert.equal(g.asset, 'KRW'); assert.equal(g.policyType, 'switch'); assert.equal(g.usage, 'switch');
  assert.deepEqual(formToPolicy(g, 730).policy, { switchDay: 60 });
});

// ---- 막힘 원인·전략 비교 안내 ----
const SHORT = () => compute(F({ ...EXAMPLE_VALUES, amount: '7486.31' }), SNAP);
test('운전자금 부족 재현: 첫 터빈 보류 금액을 사건에서 정확히 읽음', () => {
  const out = SHORT();
  assert.deepEqual(out.errors, []);
  assert.equal(out.result.summary.I, 754631n * 10n ** 16n);
  const hold = out.result.events.find((e) => e.type === 'TURBINE_HOLD');
  const x = explainBlocking(out);
  assert.equal(x.kind, 'CASH_SHORTAGE');
  assert.equal(x.first, true);
  assert.equal(x.needDai, hold.needDai);
  assert.equal(x.cashDai, hold.cash);
  assert.equal(x.cashDai, 20n * 10n ** 18n);
  assert.equal(String(x.needDai), '53769985728184921804');
  if (out.result.summary.executedSellTokens === 0n) assert.equal(x.returnedOnly, out.result.summary.W === out.result.summary.endReturnDai);
  const t = blockingText(x);
  assert.equal(t.main, '첫 터빈 처리에 약 53.77 DAI가 필요한데 운전자금은 20 DAI입니다.');
  assert.ok(t.notes.some((n) => /최소액이나 보장이 아닙니다/.test(n)));
  if (x.returnedOnly) assert.ok(t.notes.some((n) => /준비금이며 수익이 아닙니다/.test(n)));
});

test('금액별 운전자금 자동 산정: 완료값만 제안하고 현재 수동값·SELF·원금을 보존', () => {
  const normal = compute(F({ ...EXAMPLE_VALUES, amount: '1000' }), SNAP);
  assert.equal(cashResultReady(normal), true);
  assert.equal(autoReservePlan(normal, SNAP).status, 'NOT_NEEDED');
  assert.equal(normal.scenario.reserveDai, 20n * E18);

  for (const years of ['1', '3']) {
    const large = compute(F({ ...EXAMPLE_VALUES, amount: '7471', horizonYears: years }), SNAP);
    assert.equal(large.result.summary.completed, false);
    assert.equal(large.result.summary.W, 20n * E18);                 // 버그 재현: 종료 반환뿐
    assert.equal(large.result.summary.roiBps, -9973);
    assert.deepEqual(cashPresentation(large).key, 'INCOMPLETE');     // UI는 정상 ROI로 제시하지 않음
    assert.equal(quickSummaryRows(large), null);                     // quick summary 숫자 노출 금지
    const before = large.scenario.reserveDai;
    const p = autoReservePlan(large, SNAP);
    assert.equal(p.status, 'OK');
    assert.equal(large.scenario.reserveDai, before);                 // 제안만, 수동 입력 자동 덮기 없음
    assert.ok(p.reserveDai > 53n * E18 && p.reserveDai < 54n * E18);
    assert.equal(p.additionalReserve, p.reserveDai - before);
    assert.equal(p.projectedTotal, p.baseCost + p.reserveDai);
    assert.equal(p.replay.summary.completed, true);
    assert.equal(p.replay.summary.topups, 0n);
    assert.equal(p.replay.summary.I, p.projectedTotal);
  }

  const zero = compute(F({ ...EXAMPLE_VALUES, amount: '1000', reserveDai: '0' }), SNAP);
  const zp = autoReservePlan(zero, SNAP);
  assert.equal(zp.status, 'OK');
  assert.equal(zp.currentReserve, 0n);
  assert.ok(zp.reserveDai > 7n * E18 && zp.reserveDai < 8n * E18);
  assert.equal(zero.scenario.reserveDai, 0n);                         // 사용자가 넣은 0 보존
  assert.equal(zp.replay.summary.topups, 0n);
});

test('AUTO 운전자금 기본: 금액만 넣어도 DAI 1천·7471·10만과 LGNS 1만을 검산 완료값으로 연결', () => {
  const autoRun = (fields) => {
    const form = applySimpleForm(F({ ...EXAMPLE_VALUES, reserveMode: 'AUTO', ...fields }));
    const baseline = compute(form, SNAP);
    const plan = autoReservePlan(baseline, SNAP);
    const final = plan.status === 'OK'
      ? compute({ ...form, reserveDai: formatUnits(plan.reserveDai, 18) }, SNAP)
      : baseline;
    return { form, baseline, plan, final };
  };
  const cases = [
    [{ amount: '1000' }, [20n, 21n]],
    [{ amount: '7471' }, [53n, 54n]],
    [{ amount: '100000' }, [718n, 719n]],
    [{ asset: 'LGNS', amount: '10000', lgnsChain: 'anubis', route: 'ANUBIS_LGNS_BURN', 'market.lgns': 'MANUAL', lgnsPriceDai: '0.5' }, [57n, 58n]],
  ];
  for (const [fields, [lo, hi]] of cases) {
    const x = autoRun(fields);
    assert.equal(reserveModeOf(x.form), 'AUTO');
    assert.ok(x.final.result.summary.completed);
    assert.equal(x.final.result.summary.topups, 0n);
    assert.ok(x.final.scenario.reserveDai >= lo * E18 && x.final.scenario.reserveDai < hi * E18);
    if (x.plan.status === 'OK') assert.equal(x.final.result.summary.I, x.plan.projectedTotal);
  }
});

test('MANUAL 운전자금 0은 보존하고 구조적 차단은 AUTO 증액 대상으로 만들지 않는다', () => {
  const manual = applySimpleForm(F({ ...EXAMPLE_VALUES, reserveMode: 'MANUAL', reserveDai: '0' }));
  const blocked = compute(manual, SNAP);
  assert.equal(reserveModeOf(manual), 'MANUAL');
  assert.equal(blocked.scenario.reserveDai, 0n);
  assert.equal(blocked.result.summary.completed, false);

  const fixed = applySimpleForm(F({ ...EXAMPLE_VALUES, reserveMode: 'AUTO', asset: 'LGNS', amount: '100', lgnsChain: 'polygon', route: 'POLYGON_FIXED' }));
  const structural = compute(fixed, SNAP);
  assert.equal(structural.result.summary.entryState, 'FIXED_UNVERIFIED');
  assert.equal(autoReservePlan(structural, SNAP).status, 'NOT_APPLICABLE');
});

test('원화 1천만원 준비금 보류: 환산 원금 유지, 별도 추가금·총투입 및 명시 예산 부족을 구분', () => {
  const out = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, asset: 'KRW', amount: '10000000', 'fx.daiKrw': '1338', totalBudgetDai: '7500' })), SNAP);
  assert.equal(out.result.summary.completed, false);
  assert.equal(explainBlocking(out).kind, 'CASH_SHORTAGE');
  const originalBudget = out.scenario.totalBudgetDai;
  const p = autoReservePlan(out, SNAP);
  assert.equal(p.status, 'OK');
  assert.ok(p.reserveDai > 53n * E18 && p.reserveDai < 54n * E18);
  assert.equal(p.additionalReserve, p.reserveDai - 20n * E18);
  assert.equal(p.replay.summary.topups, 0n);
  assert.equal(p.replay.summary.I, p.projectedTotal);
  assert.ok(p.explicitBudgetShortfall > 0n);
  assert.equal(out.scenario.totalBudgetDai, originalBudget);         // 직접 입력 예산도 자동 변경 없음
});

test('막힘 원인 구분: 정상 장부는 null, FIXED 검증대기는 부족으로 부르지 않음', () => {
  const normal = compute(F({ ...EXAMPLE_VALUES }), SNAP);
  if (normal.result.summary.completed) assert.equal(explainBlocking(normal), null);
  else assert.notEqual(explainBlocking(normal), null);
  const fx = compute(F({ ...EXAMPLE_VALUES, asset: 'LGNS', amount: '100', lgnsChain: 'polygon', lgnsNetSaleDai: '50' }), SNAP);
  if (!fx.errors.length) {
    const k = explainBlocking(fx)?.kind;
    assert.ok(k !== 'CASH_SHORTAGE', `FIXED는 ${k}`);
    assert.equal(k, 'FIXED_UNVERIFIED');
  }
  assert.equal(explainBlocking(null), null);
  assert.equal(blockingText(null), null);
});

const NO_WIN = { label: '검색한 전략 중 최적', gate: { ok: true, reasons: [] }, metadata: {}, notes: [], results: [1, 2, 3].map((y) => ({
  horizonYears: y, funding: 'SELF', candidatesEvaluated: 10,
  winners: { maxNet: null, maxRoi: null, fastestPayback: null, leastTopup: null, nearBest: null },
  conditional: { count: 10, byReason: { 'INCOMPLETE:HOLD/GAS/INVARIANT': 10 }, bestConditional: { policy: { recycleBps: 0, switchDay: null, key: 'r:0' }, I: 1n, W: 20n, net: -7526n * 10n ** 18n, roiBps: -9973 } } })) };

test('정상 후보 없음: 원인 문장·조치 버튼, 조건부 최고는 클릭 불가로 닫힌 진단에만', () => {
  const out = SHORT();
  const m = noWinnerMessage(out, NO_WIN);
  assert.equal(m.headline, '완료 가능한 전략을 찾지 못했습니다.');
  assert.equal(m.allEmpty, true);
  assert.equal(m.current.label, '현재 선택한 전략의 확인 사항');
  assert.equal(m.current.main, '첫 터빈 처리에 약 53.77 DAI가 필요한데 운전자금은 20 DAI입니다.');
  const html = optGroupsHtml(NO_WIN, out);
  assert.ok(html.includes('현재 선택한 전략의 확인 사항') && html.includes('53.77 DAI') && html.includes('20 DAI'));
  assert.equal((html.match(/이 기간에는 추천할 수 있는 전략이 없습니다/g) ?? []).length, 3);
  assert.ok(!html.includes('data-target'));                       // 조건부 후보 적용 불가
  assert.ok(html.includes('data-minreserve') && html.includes('data-open-settings="reserveDai"'));
  const diag = html.slice(html.indexOf('<details class="diag">'));
  assert.ok(html.indexOf('-99.73%') > html.indexOf('<details class="diag">'));   // -99%는 진단 안에만
  assert.ok(diag.includes('추천 아님'));
  assert.ok(!/<details class="diag"[^>]*open/.test(html));
  assert.ok(!/INCOMPLETE/.test(html.slice(0, html.indexOf('<details class="diag">'))));   // 코드명은 진단 밖에 없음
  assert.match(html, /총투입도 늘어납니다/);
});

test('일부 기간만 후보 없음: 전체 "추천 없음"이 아니라 일부 기간 안내, 현재 전략 확인 사항은 별도 라벨', () => {
  const w = { policy: { recycleBps: 0, switchDay: null, key: 'r:0' }, I: 10n, W: 12n, net: 2n, roiBps: 2000, paybackDay: 100 };
  const mixed = { ...NO_WIN, results: NO_WIN.results.map((g) => (g.horizonYears === 1
    ? { ...g, replays: {}, winners: { ...g.winners, maxNet: { winner: w, ties: ['r:0'], tieCount: 1 } } } : g)) };
  const out = SHORT();
  const m = noWinnerMessage(out, mixed);
  assert.equal(m.headline, '일부 기간에 완료 가능한 전략이 없습니다.');
  assert.equal(m.allEmpty, false);
  assert.deepEqual(m.emptyYears, [2, 3]);
  const html = optGroupsHtml(mixed, out);
  assert.ok(html.includes('일부 기간에 완료 가능한 전략이 없습니다.'));
  assert.ok(!html.includes('완료 가능한 전략을 찾지 못했습니다'));
  assert.ok(!/<b>추천할 수 있는 전략이 없습니다/.test(html));                    // 전체 단정 문구 없음
  assert.equal((html.match(/이 기간에는 추천할 수 있는 전략이 없습니다/g) ?? []).length, 2);
  assert.equal((html.match(/data-target=/g) ?? []).length, 1);                  // 1년 정상 후보만 적용 가능
  // 현재 전략 확인 사항은 라벨을 달아서만 표시
  const i = html.indexOf('첫 터빈 처리에');
  assert.ok(i > html.indexOf('현재 선택한 전략의 확인 사항'));
  // 모든 기간에 후보가 있으면 안내 자체가 없음
  const full = { ...NO_WIN, results: NO_WIN.results.map((g) => ({ ...g, replays: {}, winners: { ...g.winners, maxNet: { winner: w, ties: ['r:0'], tieCount: 1 } } })) };
  assert.equal(noWinnerMessage(out, full), null);
});

test('정상 후보: 쉬운 지표 이름·읽을 수 있는 정책·선택 기간 강조, 적용 대상 포함', () => {
  const w = { policy: { recycleBps: null, switchDay: 90, key: 's:90' }, I: 1060n * 10n ** 18n, W: 1500n * 10n ** 18n, net: 440n * 10n ** 18n, roiBps: 4150, paybackDay: 200 };
  const res = { ...NO_WIN, results: [1, 2].map((y) => ({ horizonYears: y, funding: 'SELF', candidatesEvaluated: 5, replays: {},
    winners: { maxNet: { winner: w, ties: ['s:90'], tieCount: 1 }, maxRoi: null, fastestPayback: null, leastTopup: null, nearBest: null }, conditional: { count: 0, byReason: {} } })) };
  const out = compute(F({ ...EXAMPLE_VALUES, horizonYears: '2' }), SNAP);
  const html = optGroupsHtml(res, out);
  assert.ok(html.includes('순이익 가장 큼'));
  assert.ok(html.includes('처음 90일 재투자 → 이후 매일 받기'));
  assert.equal((html.match(/data-target=/g) ?? []).length, 2);
  assert.match(html, /opt-group current"><h3>2년/);
  assert.ok(html.includes('내 기간(1/2/3년)을 고른 뒤'));
  assert.ok(!html.includes('추천할 수 있는 전략이 없습니다'));
  assert.equal(policyReadable({ recycleBps: 0 }), '매일 받기');
  assert.equal(policyReadable({ recycleBps: 10000 }), '보상 전부 재투자');
  assert.equal(policyReadable({ recycleBps: 2510 }), '보상 25.1% 재투자 · 나머지 받기');
  assert.equal(policyReadable({ switchDay: 0 }), '매일 받기');
});

// ---- 시장 시세 적용 ----
const E18 = 10n ** 18n;
const NOWM = Date.now();
const okLeg = (key, v, extra = {}) => ({ key, status: 'OK', value: v.toString(), fetchedAt: new Date(NOWM).toISOString(), source: { blockNumber: 256 }, ...extra });
const MKT = { mode: 'MARKET', fetchedAt: new Date(NOWM).toISOString(), legs: {
  ailgns: okLeg('ailgns', 700n * E18), lgnsAnubis: okLeg('lgnsAnubis', E18 / 2n), lgnsPolygon: okLeg('lgnsPolygon', E18 / 4n),
  daiUsdt: okLeg('daiUsdt', 999n * E18 / 1000n), upbit: okLeg('upbit', 1335n * E18), fx: okLeg('fx', 999n * 1335n * E18 / 1000n) } };
const AUTO = { 'market.fx': 'AUTO', 'market.ailgns': 'AUTO', 'market.lgns': 'AUTO' };

test('원화 AUTO: 실시간 교차 환율로 계산, 요약은 원화 우선·같은 장부', () => {
  const out = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, ...AUTO, asset: 'KRW', amount: '1500000', 'fx.daiKrw': '9999' })), SNAP, MKT, NOWM);
  assert.deepEqual(out.errors, []);
  assert.equal(out.scenario.fx.mode, 'DIRECT');                           // 파생 DAI/KRW 하나만, USD 칸 사용 안 함
  assert.equal(out.scenario.fx.daiKrw, BigInt(MKT.legs.fx.value));
  assert.equal(out.scenario.fx.daiUsd, null); assert.equal(out.scenario.fx.usdKrw, null);
  assert.equal(krwRate(out.scenario), BigInt(MKT.legs.fx.value));         // 수동칸 9999는 쓰지 않음
  assert.match(out.raw.fx.source, /Anubis DAI\/USDT × 업비트 USDT\/KRW/);
  assert.equal(out.marketUse.fx.status, 'OK');
  assert.equal(out.marketUse.fx.components.daiUsdt.unit, 'USDT/DAI');
  assert.equal(out.marketUse.fx.components.usdtKrw.unit, 'KRW/USDT');
  // 원본 폼 값(수동 입력)은 바뀌지 않음
  const form = applySimpleForm(F({ ...AUTO, asset: 'KRW', amount: '1500000', 'fx.daiKrw': '9999' }));
  applyMarket(form, MKT, NOWM);
  assert.equal(form['fx.daiKrw'], '9999');
  // 수익률 분모: summary.I, 원화 시작은 원화 표시
  const basis = quickSummaryBasis(out);
  assert.equal(basis.I, out.result.summary.I);
  assert.equal(basis.initial, out.result.summary.initialCapitalDai);
  assert.match(basis.text, /수익률 기준 총투입 .*원/);
  const rows = quickSummaryRows(out);
  assert.equal(rows.length, 3);
  const cards = milestoneCards(out.result);
  rows.forEach((r, i) => {
    assert.equal(r.cashDai, cards[i].record.cumWithdrawal);
    assert.equal(r.roiBps, roiBpsOf(cards[i].record.net, cards[i].record.I));
    assert.match(r.primary, /원$/); assert.match(r.secondary, /DAI$/);
  });
});

test('원화 AUTO 실패: 계산을 막고 수동값으로 몰래 대체하지 않음, MANUAL은 직접 입력 사용', () => {
  const noFx = { ...MKT, legs: { ...MKT.legs, fx: { key: 'fx', status: 'UNAVAILABLE', value: null, error: 'x' } } };
  const out = compute(applySimpleForm(F({ ...AUTO, asset: 'KRW', amount: '1000000', 'fx.daiKrw': '1400' })), SNAP, noFx, NOWM);
  assert.ok(out.errors.some((e) => /DAI\/KRW/.test(e)));
  assert.equal(out.result, undefined);
  assert.equal(quickSummaryRows(out), null);                                // 입력 확인 필요(숫자 없음)
  const loading = compute(applySimpleForm(F({ ...AUTO, asset: 'KRW', amount: '1000000' })), SNAP, { loading: true, legs: {} }, NOWM);
  assert.ok(loading.errors.some((e) => /불러오는 중/.test(e)));
  const man = compute(applySimpleForm(F({ ...AUTO, 'market.fx': 'MANUAL', asset: 'KRW', amount: '1000000', 'fx.daiKrw': '1400' })), SNAP, noFx, NOWM);
  assert.deepEqual(man.errors, []);
  assert.equal(man.scenario.fx.daiKrw, 1400n * E18);
  // 300초 지난 시세·미래 조회시각·형식 오류 값은 쓰지 않음(예외 없이 차단)
  const base = applySimpleForm(F({ ...AUTO, asset: 'KRW', amount: '1000000' }));
  assert.deepEqual(compute(base, SNAP, MKT, NOWM + 299000).errors, []);
  assert.ok(compute(base, SNAP, MKT, NOWM + 301000).errors.length > 0);
  const fut = { ...MKT, legs: { ...MKT.legs, fx: { ...MKT.legs.fx, fetchedAt: new Date(NOWM + 120000).toISOString() } } };
  assert.ok(compute(base, SNAP, fut, NOWM).errors.length > 0);
  const bad = { ...MKT, legs: { ...MKT.legs, fx: { ...MKT.legs.fx, value: 'abc' } } };
  assert.doesNotThrow(() => compute(base, SNAP, bad, NOWM));
  assert.ok(compute(base, SNAP, bad, NOWM).errors.length > 0);
  // 만료된 AiLGNS spot은 저장 TWAP으로 대체하지 않고 중단
  assert.ok(compute(F({ ...EXAMPLE_VALUES, ...AUTO }), SNAP, MKT, NOWM + 301000).errors.some(x => x.includes('AiLGNS')));
});

test('AiLGNS: AUTO는 spot을 엔진 가격으로, 실패 시 중단, TWAP 증거는 그대로', () => {
  const twap = SNAP.values.oracleTwapDaiPerAilgns.value;
  const a = compute(F({ ...EXAMPLE_VALUES, ...AUTO }), SNAP, MKT, NOWM);
  assert.equal(a.scenario.engine.priceDaiPerAilgns, 700n * E18);
  assert.equal(a.marketUse.ailgns.source, 'SPOT');
  assert.equal(SNAP.values.oracleTwapDaiPerAilgns.value, twap);
  const b = compute(F({ ...EXAMPLE_VALUES, ...AUTO }), SNAP, { legs: {} }, NOWM);
  assert.ok(b.errors.some(x => x.includes('AiLGNS')));
  assert.equal(b.result, undefined);
  const s = compute(F({ ...EXAMPLE_VALUES, ...AUTO, 'market.ailgns': 'SNAPSHOT', 'engine.priceDaiPerAilgns': '5' }), SNAP, MKT, NOWM);
  assert.equal(s.scenario.engine.priceDaiPerAilgns, null);
  // 직접 입력은 시세 새로고침 값으로 덮지 않음
  const m = compute(F({ ...EXAMPLE_VALUES, ...AUTO, 'market.ailgns': 'MANUAL', 'engine.priceDaiPerAilgns': '650' }), SNAP, MKT, NOWM);
  assert.equal(m.scenario.engine.priceDaiPerAilgns, 650n * E18);
  assert.ok(compute(F({ ...AUTO, 'market.ailgns': 'MANUAL' }), SNAP, MKT, NOWM).errors.some((e) => /AiLGNS 가격/.test(e)));
  // 내보내기에 시세 출처 포함
  const j = JSON.parse(JSON.stringify(buildExport({ ...a, snapshot: SNAP, changelog: [], market: MKT }), jsonReplacer));
  assert.equal(j.marketUse.ailgns.source, 'SPOT');
  assert.equal(j.market.mode, 'MARKET');
  assert.equal(j.snapshot.mode, 'SAVED');                                   // 시장 시세가 프로토콜 데이터를 LIVE로 바꾸지 않음
});

test('LGNS AUTO: 선택 체인 spot을 시장 가격으로만, 순매도액은 여전히 미확정', () => {
  const p = compute(F({ ...AUTO, asset: 'LGNS', amount: '100', lgnsChain: 'polygon' }), SNAP, MKT, NOWM);
  const a = compute(F({ ...AUTO, asset: 'LGNS', amount: '100', lgnsChain: 'anubis', route: 'ANUBIS_LGNS_BURN' }), SNAP, MKT, NOWM);
  for (const [o, price] of [[p, E18 / 4n], [a, E18 / 2n]]) {
    if (o.errors.length) { assert.ok(o.errors.length > 0); continue; }
    assert.equal(o.scenario.lgnsPriceDai, price);
    assert.equal(o.quote.netSaleDai, null);
    assert.equal(o.quote.marketValueDai, price * 100n);
  }
  const g = applyMarket(F({ ...AUTO, asset: 'LGNS', lgnsChain: 'polygon', lgnsPriceDai: '9' }), { legs: {} }, NOWM);
  assert.equal(g.f.lgnsPriceDai, '');                                         // AUTO 실패 → 값 없음(수동값 대체 안 함)
  assert.equal(g.use.lgns.status, 'UNAVAILABLE');
  assert.equal(applyMarket(F({ ...AUTO, 'market.lgns': 'MANUAL', asset: 'LGNS', lgnsPriceDai: '9' }), MKT, NOWM).f.lgnsPriceDai, '9');
});

test('모드 필드 없는 이전 계약은 시세와 무관하게 그대로', () => {
  const g = applyMarket(F({ asset: 'KRW', 'fx.mode': 'MANUAL', 'fx.daiKrw': '1400', 'engine.priceDaiPerAilgns': '' }), MKT, NOWM);
  assert.equal(g.f['fx.mode'], 'MANUAL'); assert.equal(g.f['fx.daiKrw'], '1400'); assert.deepEqual(g.errors, []);
});

test('모바일 요약: 입력 오류면 이전 숫자 없이 null, DAI 시작은 DAI 우선', () => {
  assert.equal(quickSummaryRows({ errors: ['x'] }), null);
  assert.equal(quickSummaryRows(null), null);
  assert.equal(quickSummaryBasis({ errors: ['x'] }), null);
  const ext = compute(F({ ...EXAMPLE_VALUES, funding: 'EXTERNAL', 'ext.dailyDai': '50', 'ext.totalDai': '500' }), SNAP);
  const eb = quickSummaryBasis(ext);
  assert.equal(eb.I, ext.result.summary.I);
  assert.equal(eb.I, ext.result.summary.initialCapitalDai + ext.result.summary.topups);
  assert.match(eb.text, /추가 입금/);
  const out = compute(F(EXAMPLE_VALUES), SNAP);
  const rows = quickSummaryRows(out);
  assert.match(rows[0].primary, /DAI$/); assert.equal(rows[0].secondary, '');
  assert.equal(rows[2].roi, fmtBpsPct(roiBpsOf(milestoneCards(out.result)[2].record.net, milestoneCards(out.result)[2].record.I)));
});

test('HTML: 금액 다음에 비교 요약, 환산·시세는 접힌 상세, 시세 모드 기본 AUTO', () => {
  const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
  const a = html.indexOf('name="amount"'), c = html.indexOf('id="conversion-summary"'), q = html.indexOf('id="quick-summary"');
  assert.ok(a > 0 && c > a && q > html.indexOf('class="results"') && q < html.indexOf('id="charts"'));
  assert.ok(html.indexOf('id="input-details"') < c);
  assert.ok(html.indexOf('id="charts"') < html.indexOf('id="kpi"'));
  assert.ok(html.includes('id="market-strip"'));
  assert.match(html, /type="hidden" name="market\.fx" value="AUTO"/);
  for (const n of ['market.ailgns', 'market.lgns']) assert.match(html, new RegExp(`name="${n.replace('.', '\\.')}"[\\s\\S]*?<option value="AUTO" selected>`));
});

test('새 흐름 HTML: 환율·정책·외부자금 수동 UI 없이 AUTO/SELF 고정, 기간은 하단 폼 연결', () => {
  const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
  const ui = readFileSync(join(ROOT, 'src/ui.js'), 'utf8');
  assert.doesNotMatch(html, /<select name="market\.fx"/);
  assert.doesNotMatch(html, /name="fx\.daiKrw"/);
  assert.doesNotMatch(html, /name="ext\.(dailyDai|totalDai)"/);
  assert.doesNotMatch(html, /보상 사용법|일부 재투자|DAI 추가 입금/);
  assert.match(html, /type="hidden" name="market\.fx" value="AUTO"/);
  assert.match(html, /type="hidden" name="funding" value="SELF"/);
  assert.match(html, /name="engine\.ignoreBurnCaps" checked/);
  assert.match(html, /name="reserveMode" value="AUTO" checked/);
  assert.match(html, /name="reserveMode" value="MANUAL"/);
  assert.match(html, /name="horizonYears" value="1"[^>]*form="inputs"/);
  assert.ok(html.indexOf('id="compare"') < html.indexOf('name="horizonYears"'));
  assert.match(html, /id="chart-status"/);
  assert.match(ui, /data-apply-auto-reserve/);
  assert.match(ui, /plan\?\.status === 'OK' && reserveModeOf\(readForm\(\)\) === 'AUTO'/);
  assert.match(ui, /recompute\(\{ preserveOptimizer: true \}\)/);
  assert.match(ui, /처리가 끝나기 전의 현금·순이익·ROI는 정상 성과로 표시하지 않습니다/);
});

test('DAI도 AUTO 환율을 표시용으로 받고 실패하면 DAI 계산은 유지하되 원화값은 만들지 않는다', () => {
  const live = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, ...AUTO, asset: 'DAI' })), SNAP, MKT, NOWM);
  assert.deepEqual(live.errors, []);
  assert.equal(live.marketUse.fx.status, 'OK');
  assert.equal(krwRate(live.scenario), BigInt(MKT.legs.fx.value));
  const noFx = { ...MKT, legs: { ...MKT.legs, fx: { key: 'fx', status: 'UNAVAILABLE', value: null, error: 'x' } } };
  const unavailable = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, ...AUTO, asset: 'DAI' })), SNAP, noFx, NOWM);
  assert.deepEqual(unavailable.errors, []);
  assert.equal(unavailable.marketUse.fx.status, 'UNAVAILABLE');
  assert.equal(krwRate(unavailable.scenario), null);
});

test('진입 변환 요약은 관측 cap0을 별도 표시하고 계산 한도 제외의 활성·대기 POWER와 구분한다', () => {
  const dai = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, ...AUTO, asset: 'DAI' })), SNAP, MKT, NOWM);
  const d = conversionSummary(dai);
  assert.equal(d.potentialPower, dai.quote.powerPreview);
  assert.equal(d.activePower, dai.result.daily[0].activePowerEnd);
  assert.equal(d.pendingPower, dai.result.daily[0].pendingPower);
  assert.equal(d.activePower, 0n);
  assert.ok(d.pendingPower > 0n);
  assert.equal(d.capIgnored, false);
  assert.match(d.powerNote, /다음 정산|대기/);

  const lg = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, ...AUTO, asset: 'LGNS', amount: '100', lgnsChain: 'anubis', route: 'ANUBIS_LGNS_BURN' })), SNAP, MKT, NOWM);
  const l = conversionSummary(lg);
  assert.equal(l.potentialPower, 200n * E18);
  assert.equal(l.activePower, 0n);
  assert.equal(l.blockedCap0, false);
  assert.equal(l.observedCap0, true);
  assert.equal(l.capIgnored, true);
  assert.ok(l.pendingPower > 0n);
  assert.match(l.powerNote, /관측.*한도.*0.*계산에서는 한도를 제외/);
  assert.equal(lg.result.summary.liveExecutable, false);
  assert.ok(lg.result.summary.liveBlockers.includes('BURN_CAPS_IGNORED'));

  const strict = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, ...AUTO, asset: 'LGNS', amount: '100', lgnsChain: 'anubis', route: 'ANUBIS_LGNS_BURN',
    'engine.ignoreBurnCaps': false })), SNAP, MKT, NOWM);
  assert.equal(strict.quote.routeStatus, 'BLOCKED_CAP0');
  assert.equal(conversionSummary(strict).blockedCap0, true);
});

test('LGNS 10,000: 1 DAI 고정 원가·cap0 별도 표시·준비금 제안 후 조건부 계산 완료', () => {
  const out = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, asset: 'LGNS', amount: '10000', lgnsChain: 'anubis', route: 'ANUBIS_LGNS_BURN',
    'market.lgns': 'MANUAL', lgnsPriceDai: '0.5' })), SNAP);
  assert.deepEqual(out.errors, []);
  assert.equal(out.scenario.engine.ignoreBurnCaps, true);
  assert.equal(out.quote.economicCostDai, 10000n * E18);
  assert.equal(out.quote.economicCostSource, 'FIXED_ONE_DAI/ASSUMED');
  assert.equal(out.quote.netSaleDai, null);
  assert.equal(out.quote.burnCaps.lgns.value, '0');
  assert.equal(out.result.summary.entryState, 'DONE');
  assert.equal(out.result.summary.completed, false);
  const p = autoReservePlan(out, SNAP);
  assert.equal(p.status, 'OK');
  assert.ok(p.reserveDai > 57n * E18 && p.reserveDai < 58n * E18);
  assert.equal(p.replay.summary.completed, true);
  assert.equal(p.replay.summary.topups, 0n);
  assert.equal(p.replay.summary.liveExecutable, false);
});

test('일자 표본은 지정 회차와 마지막 날을 중복 없이 사용하고 DAI·AiLGNS·현금을 분리한다', () => {
  const out = compute(F({ ...EXAMPLE_VALUES, horizonYears: '3' }), SNAP);
  const rows = daySampleRows(out.result);
  assert.deepEqual(rows.map((r) => r.day), [1, 30, 90, 180, 360, 600, 730, 1095, out.result.daily.length]);
  for (const row of rows) {
    const source = out.result.daily[row.day - 1];
    assert.equal(row.emissionDai, source.emissionDai);
    assert.equal(row.emissionAilgns, source.emissionAilgns);
    assert.equal(row.dailyCashDai, source.externalWithdrawal - (source.endReturnDai ?? 0n));
  }
});

test('switch 표시 날짜는 실제 재소각 사건과 첫 현금 인출 장부 행을 사용한다', () => {
  const out = compute(F({ ...EXAMPLE_VALUES, policyType: 'switch', switchDay: '30' }), SNAP);
  const v = switchPlanView(out.result, { switchDay: 30 });
  assert.equal(v.label, '처음 30일 재투자 → 이후 현금화');
  const burns = out.result.events.filter((e) => e.type === 'REBURN');
  if (burns.length) assert.equal(v.lastReburnDate, out.result.daily[burns.at(-1).day].date);
  const firstCash = out.result.daily.find((r) => r.externalWithdrawal - (r.endReturnDai ?? 0n) > 0n);
  assert.equal(v.firstCashDate, firstCash?.date ?? null);
});

test('누적 현금의 AiLGNS 환산은 현재 가격 참고값이며 현금과 별도 합산하지 않는다', () => {
  assert.equal(cashAiEquivalent(700n * E18, 700n * E18), E18);
  assert.equal(cashAiEquivalent(700n * E18, null), null);
});

test('빈 칸은 null로 남고 0으로 바뀌지 않는다', () => {
  const { raw } = formToRaw(applySimpleForm(F({ totalBudgetDai: '', 'engine.priceDaiPerAilgns': '  ' })));
  assert.equal(raw.totalBudgetDai, null);
  assert.equal(raw.engine.priceDaiPerAilgns, null);
  assert.equal(raw.engine.annualRateBps, null);
  assert.equal(raw.engine.ignoreBurnCaps, true);
  assert.equal(raw.fx, undefined);
  const blankAmount = compute(F({ amount: '' }), SNAP);
  assert.ok(blankAmount.errors.some((e) => /금액.*양수/.test(e)));
  assert.equal(blankAmount.result, undefined);
});

test('KRW 시작에 환율이 없으면 오류 목록으로 표시(예외 없음, 임의 환율 없음)', () => {
  const out = compute(F({ asset: 'KRW', amount: '1000000' }), SNAP);
  assert.ok(out.errors.length > 0);
  assert.ok(out.errors.some((e) => /환율/.test(e)));
  assert.equal(out.result, undefined);
});

test('LGNS Polygon 기본 경로는 FIXED, 소수 bps 지급률 문자열 보존', () => {
  assert.deepEqual(routesFor('polygon')[0], 'POLYGON_FIXED');
  const { raw, uiErrors } = formToRaw(F({ asset: 'LGNS', amount: '100', lgnsChain: 'polygon', 'fixed.payoutBpsPerPeriod': '33.34', 'fixed.periodHours': '12' }));
  assert.equal(raw.route, 'POLYGON_FIXED');
  assert.equal(raw.fixed.payoutBpsPerPeriod, '33.34');
  assert.equal(raw.fixed.periodSeconds, 43200);
  assert.equal(raw.fixed.recognizedDaiPerLgns, null); // 과거 1개=1DAI 자동 입력 금지
  assert.deepEqual(uiErrors, []);
  const bad = formToRaw(F({ asset: 'LGNS', lgnsChain: 'polygon', 'fixed.payoutBpsPerPeriod': 'abc', 'fixed.periodHours': '-1' }));
  assert.equal(bad.uiErrors.length, 2);
});

test('정책: 비율 0.01% 단위 bps, 전환일 범위 검사', () => {
  assert.deepEqual(formToPolicy({ policyType: 'ratio', recyclePct: '12.34' }).policy, { recycleBps: 1234 });
  assert.deepEqual(formToPolicy({ policyType: 'switch', switchDay: '167' }, 365).policy, { switchDay: 167 });
  assert.equal(formToPolicy({ policyType: 'switch', switchDay: '400' }, 365).policy, null);
  assert.equal(formToPolicy({ policyType: 'ratio', recyclePct: '101' }).policy, null);
});

test('정수 입력 오류는 안전하게 보고', () => {
  const out = compute(F({ 'engine.entryLagDays': '1.5' }), SNAP);
  assert.ok(out.errors.some((e) => /진입 편입 지연/.test(e)));
});

test('DAI 기본 계산: 차트·마일스톤·CSV가 같은 단일 장부를 읽는다', () => {
  const out = compute(F(), SNAP);
  assert.deepEqual(out.errors, []);
  const { daily, summary } = out.result;
  assert.equal(daily.length, summary.horizonDays);
  const m = chartModel(out.result);
  assert.equal(m.n, daily.length);
  for (const c of m.charts) for (const s of c.series) assert.equal(s.values.length, daily.length);
  assert.deepEqual(summary.milestones.map((x) => x.label), ['3개월', '6개월', '1년']);
  for (const ms of summary.milestones) assert.equal(ms.record, daily[ms.day - 1]);
  // 종료 반환은 인출 막대에서 빼고 KPI(W)에만 포함
  const last = daily[daily.length - 1];
  assert.equal(m.charts[0].id, 'cash-power');
  assert.equal(m.charts[0].series.find(s => s.key === 'activePowerEnd').axis, 'right');
  assert.ok(Math.abs(m.charts[0].series.find(s => s.key === 'activePowerEnd').values.at(-1) - Number(last.activePowerEnd) / 1e18) < 1e-9);
  const bar = m.charts[1].series[1].values[daily.length - 1];
  assert.ok(Math.abs(bar - Number(last.externalWithdrawal - (last.endReturnDai ?? 0n)) / 1e18) < 1e-6);
  const csv = ledgerToCsv(daily);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, daily.length + 1);
  assert.equal(lines[0].split(',').length, LEDGER_COLUMNS.length);
  const d = derive(out.result);
  assert.equal(d.last, last);
});

test('ROI 3년 표는 24/36개월 행 포함, ROI 차트 전환', () => {
  const out = compute(F({ horizonYears: '3', policyType: 'switch', switchDay: '200' }), SNAP);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.result.summary.milestones.map((x) => x.label), ['3개월', '6개월', '1년', '1년 6개월', '2년', '3년']);
  const m = chartModel(out.result, { roiView: true });
  assert.equal(m.charts[2].id, 'roi');
});

test('내보내기 JSON은 BigInt를 문자열로 직렬화', () => {
  const out = compute(F(), SNAP);
  const j = JSON.parse(JSON.stringify(buildExport({ ...out, snapshot: SNAP, changelog: [] }), jsonReplacer));
  assert.equal(j.exportVersion, 'helix-sim-export/1');
  assert.equal(typeof j.summary.W, 'string');
  assert.equal(j.snapshot.mode, 'SAVED');
});

test('라이브 병합: 실패(null) 값은 마지막 정상값을 STALE·원 fetchedAt으로 유지, 스냅샷도 STALE', () => {
  const fresh = { schemaVersion: 'helix-sim-snapshot/1', mode: 'LIVE', meta: { fetchedAt: new Date().toISOString() },
    values: { ...SNAP.values, turbineFeeBps: { ...SNAP.values.turbineFeeBps, value: null, status: 'UNAVAILABLE', fetchedAt: new Date().toISOString() } } };
  const m = mergeLive(SNAP, fresh);
  assert.equal(m.snapshot.values.turbineFeeBps.value, '250');
  assert.equal(m.snapshot.values.turbineFeeBps.status, 'STALE');
  assert.equal(m.snapshot.values.turbineFeeBps.fetchedAt, SNAP.values.turbineFeeBps.fetchedAt);
  assert.ok(m.kept.includes('turbineFeeBps'));
  assert.equal(m.snapshot.mode, 'STALE');
  assert.ok(m.snapshot.issues.some((i) => i.code === 'PARTIAL_STALE'));
});

test('라이브 병합: 모든 필드를 새로 조회한 완전한 fixture는 LIVE, 그대로 복사한 옛 조회시각은 PARTIAL', () => {
  const nowIso = new Date().toISOString();
  // 완전한 fixture: 값이 있는 필드만, 관측 필드는 이번 조회시각으로 갱신
  const present = Object.fromEntries(Object.entries(SNAP.values).filter(([, v]) => v.value !== null));
  const lastGood = { ...SNAP, values: present };
  const freshValues = Object.fromEntries(Object.entries(present).map(([k, v]) => [k, v.status === 'ASSUMED' ? v : { ...v, fetchedAt: nowIso }]));
  const ok = mergeLive(lastGood, { schemaVersion: 'helix-sim-snapshot/1', mode: 'LIVE', meta: { fetchedAt: nowIso }, values: freshValues });
  assert.equal(ok.kept.length, 0);
  assert.equal(ok.snapshot.mode, 'LIVE');
  // 옛 fetchedAt 그대로면 필드별 STALE → validator가 PARTIAL로 낮춘다(타당한 하향)
  const old = mergeLive(lastGood, { schemaVersion: 'helix-sim-snapshot/1', mode: 'LIVE', meta: { fetchedAt: nowIso }, values: present });
  assert.equal(old.kept.length, 0);
  assert.equal(old.snapshot.mode, 'PARTIAL');
});

test('결과 상태 문구: resultClass 기반, 구현 용어 없음', () => {
  assert.equal(resultStatus({ resultClass: 'CONDITIONAL_MODEL', modelCompleted: true, liveExecutable: false }).text, '조건부 계산 완료');
  assert.equal(resultStatus({ resultClass: 'INCOMPLETE', modelCompleted: false, liveExecutable: false }).text, '일부 보류');
  assert.equal(resultStatus(null).text, '입력 확인 필요');
  const t = resultStatusText({ resultClass: 'CONDITIONAL_MODEL', liveExecutable: false });
  assert.match(t, /실측 경로 미검증/);
  assert.doesNotMatch(t, /모형 적격|엔진 미제공|modelEligible/);
  const out = compute(F(EXAMPLE_VALUES), SNAP);
  const s = out.result.summary;
  assert.equal(s.modelCompleted, s.completed);
  assert.equal(s.liveExecutable, false);
  assert.ok(['CONDITIONAL_MODEL', 'INCOMPLETE'].includes(s.resultClass));
  assert.equal(resultStatus(s).key, s.resultClass);
});

test('빈 장부(차단 결과)에서도 표시 함수가 오류 없이 동작', () => {
  const empty = { daily: [], events: [], warnings: [], failed: { day: 0, reason: 'BLOCKED' },
    summary: { milestones: [], resultClass: 'INCOMPLETE', modelCompleted: false, liveExecutable: false, paybackDay: null } };
  const m = chartModel(empty);
  assert.equal(m.n, 0);
  for (const c of m.charts) for (const s of c.series) assert.equal(s.values.length, 0);
  const d = derive(empty);
  assert.equal(d.last, null);
  assert.equal(d.payback, null);
  assert.equal(ledgerToCsv([]).trim().split('\n').length, 1);
  // 필수값이 빠진 스냅샷: 예외 대신 오류 목록 또는 결과
  const broken = { ...SNAP, values: { ...SNAP.values, oracleTwapDaiPerAilgns: { ...SNAP.values.oracleTwapDaiPerAilgns, value: null, status: 'UNAVAILABLE' } } };
  const out = compute(F(), broken);
  assert.ok(out.errors.length > 0 || Array.isArray(out.result?.daily));
  if (out.result) assert.doesNotThrow(() => chartModel(out.result));
});

test('비교 예산: 미입력이면 원금+운전자금+가스 합으로 고정, 입력하면 입력값', () => {
  const a = compute(F({ reserveDai: '20', 'gas.anubisNativeDai': '40' }), SNAP);
  assert.deepEqual(a.errors, []);
  assert.equal(a.budget.derived, true);
  assert.equal(a.budget.value, a.result.summary.initialCapitalDai);
  assert.equal(a.budget.value, 1060n * 10n ** 18n);
  const b = compute(F({ totalBudgetDai: '1500' }), SNAP);
  assert.equal(b.budget.derived, false);
  assert.equal(b.budget.value, 1500n * 10n ** 18n);
  assert.equal(withBudget(a.scenario, a.budget).totalBudgetDai, a.budget.value);
});

test('달력 마일스톤: 목표일(m.date)과 기준 정산 행 날짜를 구분, 정산 회차·실제 경과일', () => {
  const out = compute(F(), SNAP);
  const ms = out.result.summary.milestones[0];
  assert.equal(ms.date, '2027-01-23');
  assert.ok(ms.record.date <= ms.date);
  const t = recordTiming(ms.record, '2026-10-23');
  assert.equal(t.settlementNo, ms.record.day + 1);
  assert.equal(t.elapsed, daysBetween('2026-10-23', ms.record.date));
  const first = recordTiming(out.result.daily[0], '2026-10-23');
  assert.equal(first.settlementNo, 1);
  // 차트 표식은 마일스톤이 읽는 장부 행에 위치
  const m = chartModel(out.result);
  assert.equal(m.markers[0].day - 1, ms.record.day);
});

test('예시값: 운전자금 20·가스 40·즉시 5000bps 적용 시 입력 오류 없음', () => {
  assert.deepEqual(EXAMPLE_VALUES, { reserveDai: '20', 'gas.anubisNativeDai': '40', 'gas.autoRefillFromCash': true, 'engine.immediateBps': '5000' });
  const out = compute(F(EXAMPLE_VALUES), SNAP);
  assert.deepEqual(out.errors, []);
  assert.equal(out.scenario.engine.immediateBps, 5000);
});

test('필요 운전자금 설명: 상태별 문구, 0 성공 처리 없음', () => {
  const budget = { value: 1001n * 10n ** 18n };
  assert.match(minReserveText({ status: 'OK', minReserve: 5n * 10n ** 18n, label: '이분 탐색' }, budget), /필요 운전자금\(탐색값\) 5\.00 DAI/);
  assert.match(minReserveText({ status: 'INSUFFICIENT_BUDGET', maxReserve: 0n, failed: { day: 1, reason: 'CASH' } }, budget), /부족/);
  assert.match(minReserveText({ status: 'NOT_EXECUTABLE', failed: { reason: 'FIXED_UNVERIFIED' } }, budget), /완료되지 않습니다/);
  assert.match(minReserveText({ status: 'COST_UNKNOWN' }, budget), /원금이 미확정/);
});

test('최적화 연결: optimizeRequest·contract 결과 매핑·후보 클릭 필드', async () => {
  const out = compute(applySimpleForm(F({ reserveDai: '20', 'gas.anubisNativeDai': '40' })), SNAP);
  const req = optimizeRequest(out, SNAP);
  assert.deepEqual(req.fundings, ['SELF']);
  assert.equal(req.scenario.totalBudgetDai, out.budget.value);
  assert.deepEqual(req.horizons, [1]);
  assert.equal(req.scenario.funding, 'SELF');
  assert.equal(req.scenario.engine.ignoreBurnCaps, true);
  assert.deepEqual(req.search, { mode: 'switch-only' });
  const ext = compute(F({ funding: 'EXTERNAL', 'ext.dailyDai': '50', 'ext.totalDai': '500' }), SNAP);
  assert.deepEqual(optimizeRequest(ext, SNAP).fundings, ['SELF']);
  assert.equal(optimizeRequest(ext, SNAP).scenario.funding, 'SELF');

  const res = await optimize({ scenario: req.scenario, snapshot: SNAP, years: [1], fundings: req.fundings },
    { search: { ratioStep: 5000, refineStep: 5000, switchStride: 120, yieldEvery: 1000 } });
  const groups = flattenOptimizeResult(res);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].horizonYears, 1);
  assert.equal(groups[0].funding, 'SELF');
  for (const r of groups[0].rows) {
    assert.ok(['maxNet', 'fastestPayback', 'maxRoi', 'leastTopup'].includes(r.metric));
    assert.equal(r.cand, res.results[0].winners[r.metric].winner);
    assert.deepEqual(r.target.policy, r.cand.policy);
    assert.doesNotThrow(() => JSON.stringify(r.target)); // data 속성 직렬화(BigInt 없음)
  }
  assert.equal(flattenOptimizeResult({ results: { not: 'array' } }).length, 0);
  assert.deepEqual(candidateToFields({ policy: { recycleBps: null, switchDay: 40 }, horizonYears: 2, funding: 'EXTERNAL' }),
    { horizonYears: '2', funding: 'EXTERNAL', usage: 'switch', policyType: 'switch', switchDay: '40' });
  assert.deepEqual(candidateToFields({ policy: { recycleBps: 2510, switchDay: null }, horizonYears: 3, funding: 'SELF' }),
    { horizonYears: '3', funding: 'SELF', usage: 'partial', policyType: 'ratio', recyclePct: '25.1' });
  assert.equal(candidateToFields({ policy: { recycleBps: 0 } }).usage, 'sell');
  // 후보 필드를 간단 화면 프리셋으로 다시 읽어도 같은 정책
  const back = formToPolicy(applySimpleForm({ ...BASE, ...candidateToFields({ policy: { recycleBps: 2510, switchDay: null } }) })).policy;
  assert.deepEqual(back, { recycleBps: 2510 });
});

test('간단 화면 프리셋: 보상 사용법 → 기존 비율/전환 정책 정확 매핑', () => {
  const p = (o) => formToPolicy(applySimpleForm(F(o)), 365).policy;
  assert.deepEqual(p({ usage: 'sell', recyclePct: '70' }), { recycleBps: 0 });
  assert.deepEqual(p({ usage: 'partial', recyclePct: '35' }), { recycleBps: 3500 });
  assert.deepEqual(p({ usage: 'switch', switchDay: '90' }), { switchDay: 90 });
  // usage가 없으면 기존 policyType 계약 그대로
  assert.deepEqual(p({ policyType: 'ratio', recyclePct: '12' }), { recycleBps: 1200 });
  // 같은 결과: 프리셋 경로와 직접 정책 경로
  const a = compute(applySimpleForm(F({ ...EXAMPLE_VALUES, usage: 'switch', switchDay: '120' })), SNAP);
  const b = compute(F({ ...EXAMPLE_VALUES, policyType: 'switch', switchDay: '120' }), SNAP);
  assert.equal(a.result.summary.W, b.result.summary.W);
});

test('원화: 직접 입력 DAI/KRW만 필요, 없으면 막고 임의 환율을 만들지 않음', () => {
  const none = compute(applySimpleForm(F({ asset: 'KRW', amount: '1000000' })), SNAP);
  assert.ok(none.errors.length > 0 && none.errors.some((e) => /환율|daiKrw/.test(e)));
  const g = applySimpleForm(F({ asset: 'KRW', amount: '1000000', 'fx.daiKrw': '1400' }));
  assert.equal(g['fx.mode'], 'MANUAL');
  const ok = compute(g, SNAP);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.scenario.fx.mode, 'MANUAL');
  // 사용자가 고른 방식은 유지
  assert.equal(applySimpleForm(F({ asset: 'KRW', 'fx.mode': 'CROSS' }))['fx.mode'], 'CROSS');
  // DAI 시작은 환율을 강제로 넣지 않음
  assert.equal(applySimpleForm(F())['fx.mode'], undefined);
});

test('예시 조건 요약: 준비금 60 DAI(20+40), 수정하면 예시 표시 해제', () => {
  const ex = reserveSummary(F(EXAMPLE_VALUES));
  assert.deepEqual([ex.reserve, ex.gas, ex.total, ex.isExample], [20, 40, 60, true]);
  const edited = reserveSummary(F({ ...EXAMPLE_VALUES, reserveDai: '30' }));
  assert.equal(edited.isExample, false);
  assert.equal(edited.total, 70);
  assert.equal(reserveSummary(F()).isExample, false);
});

test('메인 그래프 탭 1개·3/6/12 카드: 같은 장부, 커서 모델 유지', () => {
  const out = compute(F({ ...EXAMPLE_VALUES, horizonYears: '3' }), SNAP);
  const full = chartModel(out.result);
  for (const t of [0, 1, 2]) {
    const m = singleChartModel(full, t);
    assert.equal(m.charts.length, 1);
    assert.equal(m.charts[0], full.charts[t]);
    assert.equal(m.n, full.n);
    assert.deepEqual(m.markers, full.markers);
  }
  assert.equal(singleChartModel(full, 9).charts[0], full.charts[2]);
  const cards = milestoneCards(out.result);
  assert.deepEqual(cards.map((c) => c.label), ['3개월', '6개월', '1년', '1년 6개월', '2년']);
  cards.forEach((c, i) => assert.equal(c.record, out.result.summary.milestones[i].record));
});

test('간단 화면 HTML: 세부 설정은 닫힌 하나의 접기, 기간은 하단에 연결, 이름 중복 없음', () => {
  const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
  const s = html.indexOf('<details id="settings"');
  assert.ok(s > 0 && !/<details id="settings"[^>]*\bopen\b/.test(html));
  const e = html.indexOf('</details>', html.indexOf('name="engine.returnCashAtEnd"'));
  for (const n of ['fixed.recognizedDaiPerLgns', 'reserveDai', 'gas.anubisNativeDai', 'engine.poolFeeBps', 'startDate', 'route', 'costBasis']) {
    const i = html.indexOf(`name="${n}"`);
    assert.ok(i > s && i < e, `${n}는 세부 설정 안`);
  }
  for (const n of ['amount', 'asset', 'usage', 'funding', 'lgnsChain']) assert.ok(html.indexOf(`name="${n}"`) < s, `${n}는 기본 화면`);
  assert.ok(html.indexOf('name="horizonYears"') > html.indexOf('id="compare"'));
  assert.doesNotMatch(html, /name="fx\.(daiKrw|daiUsd|usdKrw)"/);
  const names = [...html.matchAll(/<(?:input|select)\b(?![^>]*type="radio")[^>]*name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  assert.ok(html.includes('type="hidden" name="usage" value="sell"'));
  assert.ok(html.includes('현금 회수와 POWER 변화') && html.includes('id="btn-apply"'));
  assert.ok(!html.includes('id="chart-tabs"') && !html.includes('id="roi-toggle"'));
});

test('Worker 핸들: Blob URL worker, terminate 시 URL revoke, 번들에 worker 없으면 null', () => {
  const made = [], revoked = [];
  class FakeWorker { constructor(url) { this.url = url; this.terminated = false; made.push(this); } postMessage() {} terminate() { this.terminated = true; } }
  const urlApi = { createObjectURL: () => 'blob:test-1', revokeObjectURL: (u) => revoked.push(u) };
  globalThis.__HELIX_WORKER_SRC__ = 'self.onmessage=()=>{}';
  try {
    const h = makeWorkerHandle({ WorkerCtor: FakeWorker, urlApi });
    assert.equal(made[0].url, 'blob:test-1');
    h.terminate(); h.terminate();
    assert.equal(made[0].terminated, true);
    assert.deepEqual(revoked, ['blob:test-1']);
    globalThis.__HELIX_WORKER_SRC__ = null;
    assert.equal(makeWorkerHandle({ WorkerCtor: FakeWorker, urlApi }), null);
  } finally { delete globalThis.__HELIX_WORKER_SRC__; }
});

test('최적화 client: 취소·재실행 시 이전 jobId 결과 배제', () => {
  const workers = [];
  const createWorker = () => { const w = { posted: [], terminated: false, postMessage(m) { this.posted.push(m); }, terminate() { this.terminated = true; } }; workers.push(w); return w; };
  const got = [];
  const c = createOptimizerClient({ createWorker, onResult: (m) => got.push(m.jobId) });
  const id1 = c.run({ scenario: {}, snapshot: {} });
  const id2 = c.run({ scenario: {}, snapshot: {} });
  assert.equal(workers[0].terminated, true);
  workers[0].onmessage({ data: { protocol: OPTIMIZER_PROTOCOL, type: 'result', jobId: id1, results: {} } });
  workers[1].onmessage({ data: { protocol: OPTIMIZER_PROTOCOL, type: 'result', jobId: id2, results: {} } });
  assert.deepEqual(got, [id2]);
  assert.equal(workers[1].posted[0].type, 'run');
});

test('서식: null은 N/A, ROI 분모 0은 N/A', () => {
  assert.equal(fmtDai(null), 'N/A');
  assert.equal(fmtBpsPct(null), 'N/A');
  assert.equal(roiBpsOf(10n, 0n), null);
  assert.equal(roiBpsOf(-5n, 100n), -500);
});

test('차트 커서: 가장 가까운 일별 index, 눈금은 0 포함', () => {
  assert.equal(indexAt(58, 600, 365), 0);
  assert.equal(indexAt(588, 600, 365), 364);
  assert.equal(indexAt(-50, 600, 365), 0);
  const t = niceTicks(-120, 980);
  assert.ok(t.ticks.includes(0) && t.lo <= -120 && t.hi >= 980);
});

test('번들러: engine 모듈 묶음이 import/export 없이 실행되고 같은 결과', async () => {
  const b = bundle(join(ROOT, 'src/engine.js'));
  assert.ok(!/^\s*(import|export)\s/m.test(b.code));
  const mods = new Function(`${b.code}\nreturn __mods;`)();
  const out = compute(F(), SNAP);
  const r = mods['engine.js'].simulate(out.scenario, SNAP, out.policy);
  assert.equal(r.summary.W, out.result.summary.W);
});

test('index.html은 외부 CDN 없이 로컬 태그만', () => {
  const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
  assert.ok(html.includes('<script type="module" src="./ui.js"></script>'));
  assert.ok(!/(src|href)=["']https?:/i.test(html));
});


test('LGNS 직접 소각: 시가와 무관하게 1 LGNS = 1 DAI 원금', () => {
 const a = compute(F({ asset: 'LGNS', lgnsChain: 'anubis', amount: '10000', lgnsPriceDai: '0.17', ...EXAMPLE_VALUES }), SNAP);
 const b = compute(F({ asset: 'LGNS', lgnsChain: 'anubis', amount: '10000', lgnsPriceDai: '0.9', ...EXAMPLE_VALUES }), SNAP);
 assert.equal(a.quote.economicCostDai, 10000n * 10n ** 18n);
 assert.equal(a.quote.economicCostDai, b.quote.economicCostDai);
 assert.equal(a.result.summary.I, b.result.summary.I);
 assert.equal(a.result.summary.roiBps, b.result.summary.roiBps);
});
