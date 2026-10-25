import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeInput } from '../src/schema.js';
import { snapshotFromEvidence } from '../src/data.js';
import { evaluateCandidate, makePolicy, optimize, pickWinners, snapshotGate } from '../src/strategies.js';

const saved = JSON.parse(readFileSync(new URL('../evidence/snapshot.json', import.meta.url), 'utf8'));
const snap = snapshotFromEvidence(saved.rawEvidence);
const base = (o = {}) => normalizeInput({
  asset: 'DAI', amount: '1000', startDate: '2026-10-23', reserveDai: '50', totalBudgetDai: '1200',
  ...o, engine: { gas: { anubisNativeDai: '100' }, ...(o.engine ?? {}) },
});

test('switch-only는 선택 기간 0..N만 평가하고 max cash ROI 승자를 전체 장부로 검산한다', async () => {
  const res = await optimize(
    { scenario: base(), snapshot: snap, years: [1], fundings: ['SELF'] },
    { search: { mode: 'switch-only', yieldEvery: 1000 } },
  );
  const g = res.results[0];
  assert.equal(g.searched.mode, 'switch-only');
  assert.equal(g.candidatesEvaluated, g.horizonDays + 1);
  assert.equal(g.searched.switchMin, 0);
  assert.equal(g.searched.switchMax, g.horizonDays);
  assert.equal(g.searched.ratioStep, null);
  const w = g.winners.maxRoi;
  assert.ok(w?.winner);
  assert.equal(w.winner.policy.type, 'switch');
  const replay = g.replays[w.replayKey];
  assert.equal(replay.verified, true);
  for (const k of ['I', 'W', 'net', 'paybackDay']) assert.equal(replay.full.summary[k], w.winner[k], k);
});

test('재소각 요청량이 실제 소각량보다 크면 완료처럼 보여도 추천 후보에서 제외한다', () => {
  const scenario = base({ engine: { ailgnsBurnOpen: false, gas: { anubisNativeDai: '100' } } });
  const gate = snapshotGate(scenario, snap);
  assert.equal(gate.ok, true);
  const c = evaluateCandidate(scenario, snap, makePolicy({ type: 'switch', switchDay: 30 }), gate);
  assert.ok(c.requestedRecycleTokens > c.executedBurnTokens);
  assert.equal(c.modelEligible, false);
  assert.ok(c.reasons.includes('POLICY_NOT_EXECUTED'));
});

test('소각 한도 제외 gate는 cap 두 키만 건너뛰고 DAI 예치 gate는 유지한다', () => {
  const missing = structuredClone(snap);
  for (const k of ['dailyBurnPowerCap', 'dailyAilgnsBurnPowerCap']) { missing.values[k].value = null; missing.values[k].status = 'UNAVAILABLE'; }
  const sc = base({ engine: { ignoreBurnCaps: true, gas: { anubisNativeDai: '100' } } });
  assert.equal(snapshotGate(sc, missing).ok, true);
  missing.values.depositsOpen.value = null; missing.values.depositsOpen.status = 'UNAVAILABLE';
  const gate = snapshotGate(sc, missing);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('SNAPSHOT:depositsOpen:UNAVAILABLE'));
});

test('switch 정책 ROI 동률은 입력 순서와 무관하게 가장 이른 전환일을 대표 승자로 삼는다', () => {
  const c = (day) => ({ policy: makePolicy({ type: 'switch', switchDay: day }), modelEligible: true, net: 10n, I: 100n, paybackDay: 20, topups: 0n });
  const w = pickWinners([c(9), c(2), c(5)]);
  assert.equal(w.maxRoi.winner.policy.switchDay, 2);
  assert.deepEqual(new Set(w.maxRoi.ties), new Set(['s:9', 's:2', 's:5']));
});

test('switch 라벨은 실제 소각 횟수가 아닌 정산일 시점 규칙으로 표기한다', () => {
  const p = makePolicy({ type: 'switch', switchDay: 30 });
  assert.ok(!/\d+회/.test(p.label), p.label);
  assert.ok(p.label.includes('0~29일차') && p.label.includes('30일차부터'), p.label);
  assert.ok(p.label.includes('요청'), p.label);
  const z = makePolicy({ type: 'switch', switchDay: 0 });
  assert.ok(!/\d+회/.test(z.label) && z.label.includes('0일차부터'), z.label);
  // 소각이 막혀도 같은 라벨: 요청 시점만 뜻하고 실행 횟수(executedBurnTokens)는 별도 지표
  const c = evaluateCandidate(base({ engine: { ailgnsBurnOpen: false, gas: { anubisNativeDai: '100' } } }), snap, p, { ok: true, reasons: [] });
  assert.equal(c.executedBurnTokens, 0n);
  assert.equal(c.policy.label, p.label);
});

test('6개월 코스: 달력·고정일 모두 정수 기간과 전체 전환일 검산', async () => {
  for (const [periodMode, expected] of [['CALENDAR', 182], ['FIXED_DAYS', 180]]) {
    const scenario = base({ horizonYears: 0.5, periodMode });
    const res = await optimize({ scenario, snapshot: snap, years: [0.5], fundings: ['SELF'] },
      { search: { mode: 'switch-only', yieldEvery: 1000 } });
    const g = res.results[0];
    assert.equal(g.horizonDays, expected);
    assert.equal(g.candidatesEvaluated, expected + 1);
    assert.equal(g.horizonYears, 0.5);
  }
});
