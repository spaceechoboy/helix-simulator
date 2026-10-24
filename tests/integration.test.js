// Task 5(계산측) 통합·독립 검산 테스트. 실거래 대조는 아직 없음(SUSPECT) — evidence/calculation-verification.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wad, formatUnits } from '../src/decimal.js';
import { normalizeInput, STATUS } from '../src/schema.js';
import { snapshotFromEvidence, validateSnapshot } from '../src/data.js';
import { getEntryQuote } from '../src/quotes.js';
import { simulate } from '../src/engine.js';
import { optimize, makePolicy, deriveBudget } from '../src/strategies.js';

const saved = JSON.parse(readFileSync(new URL('../evidence/snapshot.json', import.meta.url), 'utf8'));
const snap = snapshotFromEvidence(saved.rawEvidence);
const num = (x) => Number(formatUnits(x));
const base = (o = {}) => normalizeInput({ asset: 'DAI', amount: '1000', startDate: '2026-10-23', reserveDai: '50', ...o, engine: { gas: { anubisNativeDai: '100' }, ...(o.engine ?? {}) } });
const COARSE = { ratioStep: 2500, refineStep: 500, refineSpan: 1000, switchStride: 60, yieldEvery: 50 };
const withValue = (k, patch) => { const s = structuredClone(snap); Object.assign(s.values[k], patch); return validateSnapshot(s, { now: Date.parse(saved.rawEvidence.fetchedAt) }).snapshot; };

// ---- 독립 검산(폐쇄형, Number) — 엔진 장부와 별개 구현 ----
function closedForm(N, s) {
  const r = 1.02 / 365, q = 1 - r, c = 2 * 0.97 - 1.025, k = 2.5 * (2 - 1.025 / 0.97), g = q + k * r;
  const sw = Math.min(s, N), Ps = 2500 * g ** sw;
  return c * Ps * (1 - q ** (N - sw));
}

test('독립 검산: 회귀 모드 장부 = 폐쇄형(임의 전환일, 최적일 하드코딩 아님)', () => {
  for (const [N, s] of [[90, 0], [180, 40], [365, 100], [730, 300], [1095, 600]]) {
    const r = simulate(base({ reserveDai: '0' }), snap, makePolicy({ type: 'switch', switchDay: s }), { regression: true, horizonDays: N });
    assert.ok(Math.abs(num(r.summary.W) - closedForm(N, s)) <= 0.01, `N=${N} s=${s} engine=${num(r.summary.W)} cf=${closedForm(N, s)}`);
    assert.equal(r.summary.liveExecutable, false);
    assert.equal(r.summary.resultClass, 'REGRESSION');
  }
});

test('핵심값 CONFLICT/UNAVAILABLE: override 없으면 계산 중단, 기본 수수료 대체 없음', () => {
  const conf = withValue('turbineFeeBps', { status: STATUS.CONFLICT });
  const a = simulate(base(), conf, makePolicy({ type: 'sell' }));
  assert.equal(a.summary.resultClass, 'BLOCKED');
  assert.equal(a.summary.I, null);
  assert.ok(a.failed.keys.includes('turbineFeeBps:CONFLICT'));
  const b = simulate(base({ engine: { turbineFeeBps: 250 } }), conf, makePolicy({ type: 'sell' }), { horizonDays: 10 });
  assert.notEqual(b.summary.resultClass, 'BLOCKED');
  const nul = withValue('sellFeeBps', { value: null });
  assert.equal(simulate(base(), nul, makePolicy({ type: 'sell' })).summary.resultClass, 'BLOCKED');
  const px = withValue('oracleTwapDaiPerAilgns', { value: '' });
  assert.ok(simulate(base(), px, makePolicy({ type: 'sell' })).failed.keys.includes('oracleTwapDaiPerAilgns:UNAVAILABLE'));
  assert.equal(simulate(base({ engine: { annualRateBps: 3650001 } }), snap, makePolicy({ type: 'sell' })).summary.resultClass, 'BLOCKED');
});

test('DAI 일일 한도 0 → 진입 없음(임의 활성화 금지)', () => {
  const s = structuredClone(snap); s.values.dailyDaiPowerCap.value = '0';
  const r = simulate(base(), s, makePolicy({ type: 'sell' }), { horizonDays: 20 });
  assert.ok(r.daily.every((d) => d.activePowerEnd === 0n));
  assert.equal(r.summary.modelCompleted, false);
});

test('모형 완료 ≠ 실제 실행 가능', () => {
  const r = simulate(base(), snap, makePolicy({ type: 'sell' }));
  assert.equal(r.summary.modelCompleted, true);
  assert.equal(r.summary.resultClass, 'CONDITIONAL_MODEL');
  assert.equal(r.summary.liveExecutable, false);
  assert.equal(r.summary.executable, false);
  assert.ok(r.summary.liveBlockers.includes('ROUTE_NOT_LIVE_VERIFIED'));
});

test('종료 반환: transfer 가스 차감 후 순액, 중간 반환 없음, 가스 불가 시 미반환', () => {
  const r = simulate(base(), snap, makePolicy({ type: 'sell' }));
  const last = r.daily.at(-1);
  assert.equal(last.endReturnGasDai, wad('0.005'));
  assert.equal(r.summary.unrealized.cashNotReturned, 0n);
  for (const m of r.summary.milestones.slice(0, -1)) assert.equal(m.record.endReturnDai, undefined);
  assert.equal(r.events.filter((e) => e.type === 'END_RETURN').length, 1);
  const no = simulate(base({ engine: { gas: { anubisNativeDai: '100', unitDai: { transfer: '1000' } } } }), snap, makePolicy({ type: 'sell' }), { horizonDays: 30 });
  assert.equal(no.summary.endReturnDai, 0n);
  assert.ok(no.summary.unrealized.cashNotReturned > 0n);
  assert.ok(no.warnings.some((w) => w.includes('종료 반환 가스 부족')));
});

test('reserve 목표에 활성화 가스 충전분 포함(자동충전)', () => {
  const a = simulate(base({ engine: { gas: { anubisNativeDai: '0', autoRefillFromCash: true } } }), snap, makePolicy({ type: 'sell' }), { horizonDays: 3 });
  const b = simulate(base(), snap, makePolicy({ type: 'sell' }), { horizonDays: 3 });
  assert.equal(a.daily[0].reserveTargetDai - b.daily[0].reserveTargetDai, wad('0.035'));
});

test('전액 재소각 1년: 재소각 편입분까지 reserve 재계산, 음수·보존식 위반 없음', () => {
  const r = simulate(base(), snap, makePolicy({ type: 'reburn' }));
  assert.ok(!r.warnings.some((w) => w.startsWith('CONSERVATION')));
  assert.ok(r.daily.every((d) => d.cash >= 0n && d.nativeAnubis >= 0n));
});

test('수수료 변경 일정 적용(사용자 시나리오)', () => {
  const r = simulate(base({ engine: { feeSchedule: [{ fromDay: 5, turbineFeeBps: 500 }] } }), snap, makePolicy({ type: 'sell' }), { horizonDays: 8 });
  const d4 = r.daily[4], d6 = r.daily[6];
  assert.equal(d4.turbineFeeDai, d4.turbineBuyDai * 250n / 10000n);
  assert.equal(d6.turbineFeeDai, d6.turbineBuyDai * 500n / 10000n);
});

test('총 초기예산 미입력 → 고정 합계 도출, 최적화 결과는 조건부 모형 라벨', async () => {
  const sc = base();
  assert.deepEqual(deriveBudget(sc, snap), { budgetDai: wad('1150'), budgetSource: 'DERIVED_FROZEN' });
  const res = await optimize({ scenario: sc, snapshot: snap, years: [1] }, { search: COARSE });
  assert.equal(res.metadata.budgetSource, 'DERIVED_FROZEN');
  assert.equal(res.metadata.totalBudgetDai, wad('1150'));
  const w = res.results[0].winners.maxNet;
  assert.ok(w);
  assert.equal(w.winner.liveExecutable, false);
  assert.ok(res.results[0].label.includes('조건부 모형'));
  assert.equal(res.results[0].replays[w.replayKey].verified, true);
});

test('종단: 저장 스냅샷 → 입력 → 진입 견적 → 장부 → 최적화 승자 재실행 일치', async () => {
  const sc = base({ totalBudgetDai: '1150' });
  const q = getEntryQuote(sc, snap);
  assert.equal(q.powerPreview, wad('2500'));
  const res = await optimize({ scenario: sc, snapshot: snap, years: [1, 2] }, { search: COARSE });
  for (const r of res.results) for (const k of ['maxNet', 'maxRoi']) {
    const w = r.winners[k]; if (!w) continue;
    const full = simulate({ ...sc, horizonYears: r.horizonYears }, snap, w.winner.policy);
    assert.equal(full.summary.net, w.winner.net);
    assert.equal(full.summary.I, w.winner.I);
  }
});
