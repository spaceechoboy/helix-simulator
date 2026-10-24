// Task 2 엔진 테스트. 실측 표본 대조(실거래)는 아직 없음 → 실제모드 값은 ASSUMED 조건부.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatUnits, wad } from '../src/decimal.js';
import { normalizeInput } from '../src/schema.js';
import { snapshotFromEvidence } from '../src/data.js';
import { simulate, findMinReserve } from '../src/engine.js';
import { addMonths, isValidDate, milestones, firstBoundary, kstDate } from '../src/dates.js';

const saved = JSON.parse(readFileSync(new URL('../evidence/snapshot.json', import.meta.url), 'utf8'));
const fx = JSON.parse(readFileSync(new URL('./fixtures/regression.json', import.meta.url), 'utf8'));
const snap = snapshotFromEvidence(saved.rawEvidence);
const num = (x) => Number(formatUnits(x));
const base = (o = {}) => normalizeInput({ asset: 'DAI', amount: '1000', startDate: '2026-10-23', ...o, engine: { gas: { anubisNativeDai: '100' }, ...(o.engine ?? {}) } });

test('dates: 말일 clamp·윤년·실제 날짜·마일스톤·프로토콜 경계', () => {
  assert.equal(addMonths('2026-08-31', 6), '2027-02-28');
  assert.equal(addMonths('2027-11-30', 3), '2028-02-29');
  assert.equal(isValidDate('2026-02-30'), false);
  assert.deepEqual(milestones('2026-10-23', 1).map((m) => m.day), [92, 182, 365]);
  assert.deepEqual(milestones('2026-10-23', 3, 'FIXED_DAYS').map((m) => m.day), [90, 180, 365, 730, 1095]);
  const b = firstBoundary('2026-10-23', 1792684800 % 86400, 86400);
  assert.equal(kstDate(b), '2026-10-23');
  assert.equal(b % 86400, 57600); // 01:00 KST, 자정 하드코딩 아님
});

test('schema: 음수·비정상 날짜·수수료 범위 거부', () => {
  assert.throws(() => base({ amount: '-1' }), /음수/);
  assert.throws(() => base({ startDate: '2026-02-30' }), /startDate/);
  assert.throws(() => base({ engine: { poolFeeBps: 20000 } }), /poolFeeBps/);
});

for (const c of fx.cases) {
  test(`회귀 fixture(가정 전용, 실행 불가): ${c.name}`, () => {
    const r = simulate(base(), snap, c.policy, { regression: true, horizonDays: c.horizonDays });
    assert.equal(r.summary.executable, false);
    assert.ok(Math.abs(num(r.summary.W) - c.expectedW) <= fx.toleranceDai, `W=${formatUnits(r.summary.W)}`);
  });
}

test('운전자금 0: 보상 크레딧만으로 무료 활성화 불가, strict 실패', () => {
  const sc = base({ reserveDai: '0' });
  const r = simulate(sc, snap, { recycleBps: 0 }, { horizonDays: 30 });
  assert.equal(r.daily[1].turbineBuyDai, 0n);
  assert.ok(r.daily[1].heldCredits > 0n);
  assert.equal(r.summary.completed, false);
  assert.equal(r.summary.W, 0n);
  const s = simulate(sc, snap, { recycleBps: 0 }, { horizonDays: 30, strict: true });
  assert.equal(s.failed.day, 1);
  assert.equal(s.failed.reason, 'CASH');
});

test('운전자금 사용: 24h 잠금, 매도 대금 중 인출만 W, 분모=원금+운전자금+가스', () => {
  const r = simulate(base({ reserveDai: '50' }), snap, { recycleBps: 0 });
  assert.equal(r.summary.completed, true);
  // 기본 immediateBps 5000: 터빈 산출 2Q 중 Q 즉시, Q 24h 잠금(ASSUMED)
  assert.ok(r.daily[1].immediateTokens > 0n);
  assert.equal(r.daily[1].lockedAilgns, r.daily[1].immediateTokens);
  assert.ok(r.daily[2].spendableAilgns >= 0n);
  assert.equal(r.summary.I, wad('1150'));
  const sumW = r.daily.reduce((s, d) => s + d.externalWithdrawal, 0n);
  assert.equal(sumW, r.summary.W);
  assert.ok(!r.warnings.some((w) => w.startsWith('CONSERVATION')), r.warnings.join('|'));
});

test('중간 마일스톤은 같은 장부, reserve 반환은 종료일 1회', () => {
  const r = simulate(base({ reserveDai: '50' }), snap, { recycleBps: 0 });
  const [m3, m6, m12] = r.summary.milestones;
  assert.equal(m3.record.endReturnDai, undefined);
  assert.equal(m6.record.endReturnDai, undefined);
  assert.ok(m12.record.endReturnDai > 0n);
  assert.equal(r.events.filter((e) => e.type === 'END_RETURN').length, 1);
});

test('재소각 2.5배는 pending → 다음 정산 편입(당일 복리 없음)', () => {
  const r = simulate(base({ reserveDai: '50' }), snap, { recycleBps: 10000 }, { horizonDays: 10 });
  const burn = r.events.find((e) => e.type === 'REBURN');
  assert.ok(burn);
  const act = r.events.find((e) => e.type === 'ACTIVATE' && e.route === 'reburn');
  assert.equal(act.day, burn.day + 1);
  const rec = r.daily[burn.day];
  assert.equal(rec.newPendingPower, (burn.tokens * rec.price / wad('1')) * 25000n / 10000n);
});

test('외부 DAI: 한도까지만 투입, 분모에 누적, 소진 후 보류', () => {
  const sc = base({ funding: 'EXTERNAL', externalBudget: { dailyDai: '10', totalDai: '20' } });
  const r = simulate(sc, snap, { recycleBps: 0 }, { horizonDays: 30 });
  assert.equal(r.summary.topups, wad('20'));
  assert.equal(r.summary.I, wad('1120'));
  assert.equal(r.summary.completed, false);
});

test('기존 토큰 선매도로 첫 활성화 가능 / 선행 가스 부족이면 실패', () => {
  // entryLagDays 0: 첫날 정산 크레딧 발생 → 보유 AiLGNS 선매도로 비용 충당(가정 시나리오)
  const eng = (gas) => ({ entryLagDays: 0, initialAilgns: '1', initialAilgnsCostDai: '803', gas: { anubisNativeDai: gas } });
  const ok = simulate(base({ engine: eng('100') }), snap, { recycleBps: 0 }, { horizonDays: 5 });
  assert.ok(ok.daily[0].coverSaleDai > 0n);
  assert.ok(ok.daily[0].turbineBuyDai > 0n);
  assert.equal(ok.summary.I, wad('1903'));
  const bad = simulate(base({ engine: eng('0') }), snap, { recycleBps: 0 }, { horizonDays: 5 });
  assert.equal(bad.daily[0].turbineBuyDai, 0n);
  assert.equal(bad.daily[0].gasShort, true);
});

test('Anubis LGNS cap0: Power 0·회수 미도달, 재개는 사용자 시나리오일 때만', () => {
  const lg = (engine = {}) => normalizeInput({ asset: 'LGNS', lgnsChain: 'anubis', amount: '100', lgnsPriceDai: '1', startDate: '2026-10-23', engine: { gas: { anubisNativeDai: '100' }, ...engine } });
  const r = simulate(lg(), snap, { recycleBps: 0 }, { horizonDays: 30 });
  assert.ok(r.daily.every((d) => d.activePowerEnd === 0n));
  assert.equal(r.summary.paybackDay, null);
  assert.equal(r.summary.unrealized.lgnsWaiting, 100n * 10n ** 9n);
  const o = simulate(lg({ lgnsBurnOpenFromDay: 10, lgnsPowerPerLgns: '2' }), snap, { recycleBps: 0 }, { horizonDays: 30 });
  assert.equal(o.events.find((e) => e.type === 'HELIX_LGNS_BURN').day, 10);
  assert.equal(o.daily[11].newActivePower, wad('200'));
});

test('소각 한도 제외 가정은 LGNS·AiLGNS만 열고 관측 cap0·실행 미검증 상태를 보존', () => {
  const unavailableCaps = structuredClone(snap);
  for (const k of ['dailyBurnPowerCap', 'dailyAilgnsBurnPowerCap']) { unavailableCaps.values[k].value = null; unavailableCaps.values[k].status = 'UNAVAILABLE'; }
  const lg = normalizeInput({ asset: 'LGNS', lgnsChain: 'anubis', amount: '100', lgnsPriceDai: '1', startDate: '2026-10-23', reserveDai: '50',
    engine: { ignoreBurnCaps: true, gas: { anubisNativeDai: '100' } } });
  const r = simulate(lg, unavailableCaps, { recycleBps: 0 }, { horizonDays: 30, strict: true });
  assert.equal(r.events.find((e) => e.type === 'HELIX_LGNS_BURN').day, 0);
  assert.equal(r.daily[1].newActivePower, wad('200'));
  assert.equal(r.summary.entryState, 'DONE');
  assert.equal(r.summary.liveExecutable, false);
  assert.ok(r.summary.liveBlockers.includes('BURN_CAPS_IGNORED'));

  const closed = structuredClone(snap); closed.values.depositsOpen.value = '0';
  const dai = base({ reserveDai: '50', engine: { ignoreBurnCaps: true, gas: { anubisNativeDai: '100' } } });
  assert.equal(simulate(dai, closed, { recycleBps: 0 }, { horizonDays: 5 }).summary.entryState, 'ENTRY_NOT_EXECUTED');
});

test('검수1 재현: 가스 자동충전 포함 사전검사 — 음수 현금·거짓 완료 없음', () => {
  const sc = normalizeInput({ asset: 'DAI', amount: '1000', startDate: '2026-10-23', reserveDai: '7.18',
    engine: { annualRateBps: 10200, priceDaiPerAilgns: '1', poolFeeBps: 0, entryLagDays: 0, gas: { anubisNativeDai: '0', autoRefillFromCash: true, unitDai: { deposit: '0', approve: '0' } } } });
  const r = simulate(sc, snap, { recycleBps: 0 });
  assert.ok(r.daily.every((d) => d.cash >= 0n));
  assert.equal(r.daily[0].turbineBuyDai, 0n); // 매수+수수료 7.161 + 가스충전 0.03 > 7.18 → 보류(이전엔 실행 후 -0.016)
  assert.equal(r.summary.completed, false);
  assert.ok(!r.warnings.some((w) => w.startsWith('CONSERVATION')));
});

test('검수2 재현: depositsOpen=0 → 진입 없음, completed false, 최소자금 NOT_EXECUTABLE', () => {
  const closed = structuredClone(snap);
  closed.values.depositsOpen.value = '0';
  const r = simulate(base({ reserveDai: '50' }), closed, { recycleBps: 0 }, { horizonDays: 30 });
  assert.ok(r.daily.every((d) => d.activePowerEnd === 0n));
  assert.equal(r.summary.completed, false);
  assert.equal(r.summary.entryState, 'ENTRY_NOT_EXECUTED');
  assert.equal(findMinReserve(base({ totalBudgetDai: '1200' }), closed, { recycleBps: 0 }).status, 'NOT_EXECUTABLE');
  const lg = normalizeInput({ asset: 'LGNS', lgnsChain: 'anubis', amount: '100', startDate: '2026-10-23', costBasis: 'ACQUISITION', acquisitionCostDai: '50', engine: { gas: { anubisNativeDai: '100' } } });
  assert.equal(simulate(lg, snap, { recycleBps: 0 }, { horizonDays: 30 }).summary.completed, false); // cap0 유휴 성공 금지
});

test('검수3 재현: 진입 approve+deposit 가스 없으면 pending 미생성', () => {
  const r = simulate(base({ reserveDai: '50', engine: { gas: { anubisNativeDai: '0' } } }), snap, { recycleBps: 0 }, { horizonDays: 10 });
  assert.ok(!r.events.some((e) => e.type === 'ENTRY_DAI'));
  assert.ok(r.daily.every((d) => d.pendingPower === 0n && d.activePowerEnd === 0n));
  assert.equal(r.summary.completed, false);
  const ok = simulate(base({ reserveDai: '50' }), snap, { recycleBps: 0 }, { horizonDays: 3 });
  assert.equal(ok.daily[0].gasDai, wad('0.025')); // approve 0.005 + deposit 0.02
});

test('최소 운전자금: 전체 활성화 성공 기준, 예산 고정, 부족 시 0 성공 처리 금지', () => {
  const sc = base({ totalBudgetDai: '1200' });
  const m = findMinReserve(sc, snap, { recycleBps: 0 }, { stepDai: wad('0.01') });
  assert.equal(m.status, 'OK');
  assert.ok(m.minReserve > 0n && m.minReserve <= wad('100'));
  assert.equal(simulate({ ...sc, reserveDai: m.minReserve }, snap, { recycleBps: 0 }, { strict: true }).summary.completed, true);
  const poor = findMinReserve(base({ totalBudgetDai: '1100' }), snap, { recycleBps: 0 });
  assert.equal(poor.status, 'INSUFFICIENT_BUDGET');
});

const assertGasLedger = (r, initialNative) => {
  const refill = r.daily.reduce((sum, day) => sum + day.refillDai, 0n);
  assert.equal(initialNative + refill, r.summary.gasSpent + r.summary.unrealized.nativeGas.anubis);
  assert.ok(r.daily.every((day) => day.cash >= 0n && day.nativeAnubis >= 0n));
  assert.ok(!r.warnings.some((w) => w.startsWith('CONSERVATION')), r.warnings.join('|'));
};

test('SELF 장기 실행: 네이티브 가스 소진 뒤에도 1·2·3년 전환 정책을 끝까지 수행', () => {
  const initialNative = wad('40');
  const sc = normalizeInput({ asset: 'DAI', amount: '1000', startDate: '2026-10-24', reserveDai: '20',
    engine: { immediateBps: 5000, gas: { anubisNativeDai: '40', autoRefillFromCash: true } } });
  const cases = [
    { horizonDays: 365, switchDay: 365 },
    { horizonDays: 732, switchDay: 0 },
    { horizonDays: 732, switchDay: 164 },
    { horizonDays: 732, switchDay: 732 },
    { horizonDays: 1097, switchDay: 0 },
    { horizonDays: 1097, switchDay: 164 },
    { horizonDays: 1097, switchDay: 1097 },
  ];
  for (const c of cases) {
    const r = simulate(sc, snap, { switchDay: c.switchDay }, { horizonDays: c.horizonDays, strict: true });
    assert.equal(r.summary.completed, true, `${c.horizonDays}d/switch${c.switchDay}: ${r.failed?.reason ?? 'INCOMPLETE'}`);
    assert.equal(r.summary.daysSimulated, c.horizonDays);
    assert.equal(r.summary.topups, 0n);
    assert.equal(r.summary.I, wad('1060'));
    assert.ok(r.daily.every((day) => day.heldCredits === 0n));
    assertGasLedger(r, initialNative);
  }
});

test('부분 네이티브 가스: 선매도·활성화·후속 처분을 하나의 잔액에서 계획', () => {
  const initialNative = wad('0.05');
  const sc = normalizeInput({ asset: 'DAI', amount: '1000', startDate: '2026-10-24', reserveDai: '0',
    engine: { entryLagDays: 0, initialAilgns: '1', initialAilgnsCostDai: '803', immediateBps: 5000,
      gas: { anubisNativeDai: '0.05', autoRefillFromCash: true } } });
  const r = simulate(sc, snap, { switchDay: 0 }, { horizonDays: 3, strict: true });
  assert.equal(r.summary.completed, true, r.failed?.reason ?? 'INCOMPLETE');
  assert.ok(r.daily[0].coverSaleDai > 0n);
  assert.ok(r.daily[0].turbineBuyDai > 0n);
  assert.ok(r.daily[0].withdrawSaleTokens > 0n);
  assert.equal(r.summary.topups, 0n);
  assert.equal(r.summary.I, wad('1803.05'));
  assertGasLedger(r, initialNative);

  const noRefill = structuredClone(sc);
  noRefill.engine.gas.autoRefillFromCash = false;
  const blocked = simulate(noRefill, snap, { switchDay: 0 }, { horizonDays: 3, strict: true });
  assert.equal(blocked.summary.completed, false);
  assert.equal(blocked.failed?.reason, 'GAS');
  assert.ok(blocked.daily.every((day) => day.refillDai === 0n && day.cash >= 0n && day.nativeAnubis >= 0n));
});

test('가스 0·reserve 0: 미래 보상 매도대금으로 선행 가스를 차용하지 않음', () => {
  const sc = normalizeInput({ asset: 'DAI', amount: '1000', startDate: '2026-10-24', reserveDai: '0',
    engine: { entryLagDays: 0, initialAilgns: '1', initialAilgnsCostDai: '803', immediateBps: 5000,
      gas: { anubisNativeDai: '0', autoRefillFromCash: true,
        unitDai: { approve: '0', deposit: '0', sale: '0.02', claim: '0.01', activate: '0.02' } } } });
  const r = simulate(sc, snap, { switchDay: 0 }, { horizonDays: 2, strict: true });
  assert.equal(r.summary.completed, false);
  assert.equal(r.failed?.reason, 'GAS');
  assert.equal(r.summary.W, 0n);
  assert.equal(r.summary.topups, 0n);
  assert.equal(r.summary.gasSpent, 0n);
  assert.ok(!r.events.some((event) => event.type === 'SALE' || event.type === 'TURBINE'));
  assertGasLedger(r, 0n);
});
