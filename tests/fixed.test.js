// Task 2 FIXED 테스트. FIXED 규칙 자체는 오늘 미검증(ASSUMED) — 계산 계약만 검증.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wad } from '../src/decimal.js';
import { normalizeInput } from '../src/schema.js';
import { snapshotFromEvidence } from '../src/data.js';
import { getEntryQuote } from '../src/quotes.js';
import { createFixedState, fixedAccrual, fixedRemainingDai } from '../src/fixed.js';
import { simulate } from '../src/engine.js';

const saved = JSON.parse(readFileSync(new URL('../evidence/snapshot.json', import.meta.url), 'utf8'));
const snap = snapshotFromEvidence(saved.rawEvidence);
const L = 10n ** 9n;
const P = 43200;
const sc = (fixed = {}, engine = {}) => normalizeInput({
  asset: 'LGNS', lgnsChain: 'polygon', amount: '100', startDate: '2026-10-23', costBasis: 'ACQUISITION', acquisitionCostDai: '40', lgnsPriceDai: '0.3',
  fixed: { recognizedDaiPerLgns: '1', totalPayoutCapBps: 20000, payoutBpsPerPeriod: 50, periodSeconds: P, payoutPriceDai: '0.5', ...fixed },
  engine: { gas: { anubisNativeDai: '1', polygonNativeDai: '0.5' }, ...engine },
});
const st = (fixed) => createFixedState(getEntryQuote(sc(fixed), snap).fixed, 0);

test('주기 지급: 인정액×비율÷지급가 = LGNS(9자리)', () => {
  const { state, events } = fixedAccrual(st(), { type: 'tick', at: 2 * P });
  assert.equal(events.filter((e) => e.type === 'FIXED_PAYOUT').length, 2);
  assert.equal(state.accruedLgns, 2n * L); // 0.5 DAI / 0.5 = 1 LGNS × 2
  assert.equal(state.unclaimedLgns, 2n * L);
});

test('지급가 변경 시 수령 개수 변화, 9자리 버림 보존', () => {
  let s = fixedAccrual(st(), { type: 'tick', at: P }).state;
  s = fixedAccrual(s, { type: 'price', price: wad('0.25') }).state;
  s = fixedAccrual(s, { type: 'tick', at: 2 * P }).state;
  assert.equal(s.accruedLgns, 3n * L);
  const t = fixedAccrual(st({ payoutPriceDai: '0.3' }), { type: 'tick', at: P }).state;
  assert.equal(t.accruedLgns, 1666666666n);
});

test('총 지급상한 도달 후 중단', () => {
  const { state } = fixedAccrual(st({ payoutBpsPerPeriod: 10000 }), { type: 'tick', at: 10 * P });
  assert.equal(state.paidDai, wad('200'));
  assert.equal(state.capReached, true);
  assert.equal(fixedRemainingDai(state), 0n);
});

test('지급 중단일 이후 지급 없음, 청구로 미청구→청구', () => {
  let s = fixedAccrual(st(), { type: 'stop', at: 3 * P }).state;
  s = fixedAccrual(s, { type: 'tick', at: 10 * P }).state;
  assert.equal(s.accruedLgns, 2n * L);
  assert.equal(s.stopped, true);
  s = fixedAccrual(s, { type: 'claim', at: 10 * P }).state;
  assert.equal(s.unclaimedLgns, 0n);
  assert.equal(s.claimedLgns, 2n * L);
});

test('검수7 재현: 소수 bps 33.34(0.3334%) 반올림 없이 지원, 초과 정밀도 거부', () => {
  const s = st({ payoutBpsPerPeriod: '33.34' });
  assert.equal(s.payoutRateWad, 3334n * 10n ** 12n);
  const { state } = fixedAccrual(s, { type: 'tick', at: P });
  assert.equal(state.paidDai, wad('0.3334'));
  assert.equal(state.accruedLgns, 666800000n); // 0.3334 / 0.5 = 0.6668 LGNS
  assert.throws(() => sc({ payoutBpsPerPeriod: '0.000000000000001' }), /정밀도/); // 1e-15 bps → WAD 분수 정수 불가
  assert.throws(() => sc({ payoutBpsPerPeriod: '-1' }), /음수/);
});

test('파라미터 미입력 → 검증대기, 과거값 자동 채움 없음', () => {
  const q = getEntryQuote(normalizeInput({ asset: 'LGNS', lgnsChain: 'polygon', amount: '100', startDate: '2026-10-23' }), snap);
  const s = createFixedState(q.fixed, 0);
  assert.equal(s.enabled, false);
  assert.equal(s.status, 'PENDING_VERIFICATION');
  assert.equal(fixedAccrual(s, { type: 'tick', at: 100 * P }).events.length, 0);
});

test('ROI 분모는 원가(40)+가스, 인정액(100) 아님; cap0이면 LGNS 대기·Power 0·현금 0', () => {
  const r = simulate(sc(), snap, { recycleBps: 0 }, { horizonDays: 30 });
  assert.equal(r.summary.I, wad('41.5'));
  assert.equal(r.summary.fixed.principalRecognizedDai, wad('100'));
  assert.ok(r.summary.unrealized.lgnsWaiting > 0n);
  assert.ok(r.daily.every((d) => d.activePowerEnd === 0n));
  assert.equal(r.summary.W, 0n);
  assert.ok(r.events.some((e) => e.type === 'FIXED_BURN_POLYGON'));
  assert.ok(!r.events.some((e) => e.type === 'HELIX_LGNS_BURN'));
});

test('지급 중단과 HELIX 소각 재개는 독립', () => {
  const r = simulate(sc({ stopDate: '2026-10-26' }, { lgnsBurnOpenFromDay: 10, lgnsPowerPerLgns: '2' }), snap, { recycleBps: 0 }, { horizonDays: 20 });
  const lastPayout = Math.max(...r.events.filter((e) => e.type === 'FIXED_PAYOUT').map((e) => e.day));
  assert.ok(lastPayout < 10);
  const burn = r.events.find((e) => e.type === 'HELIX_LGNS_BURN');
  assert.equal(burn.day, 10);
  assert.ok(r.daily[11].newActivePower > 0n);
  assert.equal(r.summary.unrealized.lgnsWaiting, 0n);
});
