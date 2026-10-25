// Task 1 테스트. 증거 출처: evidence/snapshot.json (Anubis block 17,213,594, fetchedAt 2026-10-23T08:53:08Z, block hash 미기록).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUnits, formatUnits, rescale, wad } from '../src/decimal.js';
import { normalizeInput, ROUTES, STATUS } from '../src/schema.js';
import { snapshotFromEvidence, validateSnapshot, rpcCall, refreshLive } from '../src/data.js';
import { getEntryQuote, quoteBuyAilgns, quoteSellAilgns, makeDayPool, findDoubleDebits, krwToDai } from '../src/quotes.js';

const saved = JSON.parse(readFileSync(new URL('../evidence/snapshot.json', import.meta.url), 'utf8'));
const FETCHED_MS = Date.parse(saved.rawEvidence.fetchedAt);
const snap = () => snapshotFromEvidence(saved.rawEvidence);

test('decimal: 원단위 보존과 자리수 변환', () => {
  assert.equal(formatUnits(parseUnits('1463.815984')), '1463.815984');
  assert.equal(parseUnits('1', 9), 1_000_000_000n);
  assert.equal(rescale(parseUnits('2.5', 9), 9, 18), wad('2.5'));
  assert.throws(() => parseUnits(null));
});

test('저장 snapshot: 자동 LIVE 금지, null≠0, cap0 보존', () => {
  const s = snap();
  assert.equal(s.mode, 'SAVED');
  for (const v of Object.values(s.values)) assert.notEqual(v.status, STATUS.LIVE_VERIFIED);
  assert.equal(s.values.communityActualToday.value, null);
  assert.equal(s.values.communityActualToday.status, STATUS.UNAVAILABLE);
  assert.equal(s.values.dailyBurnPowerCap.value, '0');
  assert.equal(s.values.dailyBurnPowerCap.status, STATUS.OBSERVED);
  assert.equal(s.values.poolFeeBps.status, STATUS.ASSUMED);
  assert.equal(s.meta.blockNumber, 17213594);
  assert.ok(s.issues.some((i) => i.code === 'LGNS_CAP0'));
});

test('validateSnapshot: stale·conflict·LIVE 강등', () => {
  const base = snap();
  const fresh = validateSnapshot(base, { now: FETCHED_MS + 60_000 }).snapshot;
  assert.equal(fresh.stale, false);
  assert.equal(validateSnapshot(base, { now: FETCHED_MS + 301_000 }).snapshot.stale, true);

  const bad = structuredClone(base);
  bad.values.apiSellFeeBps.value = '500';
  const r = validateSnapshot(bad, { now: FETCHED_MS });
  assert.equal(r.snapshot.values.sellFeeBps.status, STATUS.CONFLICT);
  assert.ok(r.issues.some((i) => i.code === 'CONFLICT'));

  const fake = structuredClone(base);
  fake.values.turbineFeeBps.status = STATUS.LIVE_VERIFIED;
  assert.equal(validateSnapshot(fake, { now: FETCHED_MS }).snapshot.values.turbineFeeBps.status, STATUS.OBSERVED);

  const miss = structuredClone(base);
  miss.values.turbineFeeBps.value = '';
  const m = validateSnapshot(miss, { now: FETCHED_MS });
  assert.equal(m.snapshot.values.turbineFeeBps.value, null);
  assert.ok(m.issues.some((i) => i.code === 'MISSING'));
});

test('normalizeInput: KRW 환율 미입력은 오류, 임의 환율 없음', () => {
  assert.throws(() => normalizeInput({ asset: 'KRW', amount: '1000000', startDate: '2026-10-23' }), /환율/);
  assert.throws(() => normalizeInput({ asset: 'KRW', amount: '1000000', startDate: '2026-10-23', fx: { mode: 'CROSS', daiUsd: '1' } }), /usdKrw/);
  const s = normalizeInput({ asset: 'KRW', amount: '1400000', startDate: '2026-10-23', fx: { mode: 'MANUAL', daiKrw: '1400' } });
  const q = getEntryQuote(s, snap());
  assert.equal(formatUnits(q.economicCostDai), '1000');
  assert.equal(q.fx.fxStatus, STATUS.ASSUMED);
});

test('KRW 교차환율: 스프레드·출금비용은 순 DAI에서만 차감', () => {
  const r = krwToDai(wad('1400000'), { mode: 'CROSS', daiUsd: wad('1'), usdKrw: wad('1400'), spreadBps: 100, withdrawFeeKrw: wad('14000') });
  assert.equal(formatUnits(r.grossDai), '1000');
  assert.ok(r.netDai < r.grossDai);
});

test('DAI 1,000 → Power 2,500 (25000bps), 원금=1,000', () => {
  const s = normalizeInput({ asset: 'DAI', amount: '1000', startDate: '2026-10-23', reserveDai: '50' });
  const q = getEntryQuote(s, snap());
  assert.equal(formatUnits(q.powerPreview), '2500');
  assert.equal(formatUnits(q.initialCapitalDai), '1050');
});

test('LGNS 체인 필수, Polygon 기본 경로 = FIXED', () => {
  assert.throws(() => normalizeInput({ asset: 'LGNS', amount: '10', startDate: '2026-10-23' }), /체인/);
  const s = normalizeInput({ asset: 'LGNS', amount: '10', startDate: '2026-10-23', lgnsChain: 'polygon' });
  assert.equal(s.route, ROUTES.POLYGON_FIXED);
  assert.throws(() => normalizeInput({ asset: 'LGNS', amount: '10', startDate: '2026-10-23', lgnsChain: 'polygon', route: ROUTES.ANUBIS_LGNS_BURN }));
});

test('FIXED 인정액과 경제적 원가는 별개, ROI 분모는 원가', () => {
  const s = normalizeInput({ asset: 'LGNS', amount: '100', startDate: '2026-10-23', lgnsChain: 'polygon',
    costBasis: 'ACQUISITION', acquisitionCostDai: '40', lgnsPriceDai: '0.3',
    fixed: { recognizedDaiPerLgns: '1', totalPayoutCapBps: 20000, payoutBpsPerPeriod: 50, periodSeconds: 43200, payoutPriceDai: '0.3' } });
  const q = getEntryQuote(s, snap());
  assert.equal(formatUnits(q.economicCostDai), '40');
  assert.equal(formatUnits(q.fixed.acquisitionCostDai), '40');
  assert.equal(formatUnits(q.fixed.principalRecognizedDai), '100');
  assert.equal(formatUnits(q.marketValueDai), '30');
  assert.equal(q.routeStatus, 'PENDING_VERIFICATION');
});

test('FIXED 파라미터 미입력 → null 검증대기(과거값 자동 채움 없음)', () => {
  const s = normalizeInput({ asset: 'LGNS', amount: '100', startDate: '2026-10-23', lgnsChain: 'polygon' });
  const q = getEntryQuote(s, snap());
  assert.equal(q.fixed.principalRecognizedDai, null);
  assert.equal(q.economicCostDai, null); // 가격 미입력 → 원가 미확정
  assert.ok(q.issues.some((m) => m.includes('FIXED 인정 비율')));
});

test('Anubis LGNS 직접 소각: cap0이면 차단, Power 확정 없음', () => {
  const s = normalizeInput({ asset: 'LGNS', amount: '10', startDate: '2026-10-23', lgnsChain: 'anubis', lgnsPriceDai: '1.2' });
  const q = getEntryQuote(s, snap());
  assert.equal(q.routeStatus, 'BLOCKED_CAP0');
  assert.equal(q.powerPreview, null);
  assert.equal(formatUnits(q.marketValueDai), '12');
  assert.equal(q.netSaleDai, null); // 시장가 ≠ 순매도액
  assert.equal(formatUnits(q.economicCostDai), '12');
  assert.equal(q.economicCostSource, 'MARKET_VALUE/ASSUMED'); // 직접 소각 ROI 원가는 현재 시가, 순매도 견적은 여전히 null
});

test('소각 한도 제외 시나리오: 관측 cap0은 보존하고 계산 경로만 ASSUMED로 연다', () => {
  const s = normalizeInput({ asset: 'LGNS', amount: '10', startDate: '2026-10-23', lgnsChain: 'anubis', lgnsPriceDai: '1.2',
    engine: { ignoreBurnCaps: true } });
  const q = getEntryQuote(s, snap());
  assert.equal(q.routeStatus, STATUS.ASSUMED);
  assert.equal(q.burnCaps.lgns.value, '0');
  assert.equal(q.burnCaps.lgns.status, STATUS.OBSERVED);
  assert.equal(q.burnCaps.ignoredForCalculation, true);
  assert.equal(formatUnits(q.assumedPowerPreview), '20');
  assert.equal(q.powerPreview, null);
});

test('LGNS 순매도: 명시 견적 또는 수동 가정(세금·풀·가스)만, 경로 ASSUMED', () => {
  const b = { asset: 'LGNS', amount: '10', startDate: '2026-10-23', lgnsChain: 'anubis', route: ROUTES.ANUBIS_LGNS_SELL_DAI, lgnsPriceDai: '1.2' };
  const none = getEntryQuote(normalizeInput(b), snap());
  assert.equal(none.netSaleDai, null);
  assert.equal(none.powerPreview, null);
  assert.equal(none.routeStatus, 'PENDING_VERIFICATION');
  const man = getEntryQuote(normalizeInput({ ...b, lgnsSaleAssumption: { taxBps: 0, poolFeeBps: 30, gasDai: '0.1' } }), snap());
  assert.equal(formatUnits(man.netSaleDai), '11.864');
  assert.equal(man.netSaleSource, STATUS.ASSUMED);
  assert.equal(man.routeStatus, STATUS.ASSUMED);
  const usr = getEntryQuote(normalizeInput({ ...b, lgnsNetSaleDai: '11.5' }), snap());
  assert.equal(formatUnits(usr.netSaleDai), '11.5');
  assert.equal(usr.netSaleSource, 'USER_QUOTE');
  assert.throws(() => normalizeInput({ ...b, lgnsSaleAssumption: { taxBps: 0 } }), /모두 필수/);
});

test('validateSnapshot 도메인: 음수 fee·가격 0·bps 범위·주소 형식', () => {
  const s = structuredClone(snap());
  s.values.sellFeeBps.value = '-1';
  s.values.oracleTwapDaiPerAilgns.value = '0';
  s.values.turbineFeeBps.value = '20000';
  s.values.daiTokenAddress.value = '0x123';
  const r = validateSnapshot(s, { now: FETCHED_MS });
  for (const k of ['sellFeeBps', 'oracleTwapDaiPerAilgns', 'turbineFeeBps', 'daiTokenAddress']) {
    assert.equal(r.snapshot.values[k].value, null, k);
    assert.ok(r.issues.some((i) => i.code === 'DOMAIN' && i.key === k), k);
  }
});

test('매도: 세금 단계 분리 후 풀 견적, quote 내포 fee 이중차감 없음', () => {
  const lin = quoteSellAilgns(wad('100'), { model: 'LINEAR', priceDaiPerAilgns: wad('800'), sellTaxBps: 300, poolFeeBps: 30, feeIncludedInQuote: true });
  assert.equal(formatUnits(lin.arrive), '97');
  assert.equal(formatUnits(lin.daiOut), '77600');
  assert.deepEqual(findDoubleDebits(lin.costs), []);
  const lin2 = quoteSellAilgns(wad('100'), { model: 'LINEAR', priceDaiPerAilgns: wad('800'), sellTaxBps: 300, poolFeeBps: 30, feeIncludedInQuote: false });
  assert.equal(formatUnits(lin2.daiOut), '77367.2');
});

test('AMM 일별 재구성: 일내 매수→매도 순서가 reserve를 갱신, fee는 quote 내포', () => {
  const pool = makeDayPool({ priceDaiPerAilgns: wad('800'), depthDai: wad('800000') });
  const b = quoteBuyAilgns(wad('10'), { model: 'AMM_DAILY_RESET', pool, poolFeeBps: 30 });
  assert.ok(b.daiIn > wad('8000'));
  assert.deepEqual(findDoubleDebits(b.costs), []);
  const s = quoteSellAilgns(wad('10'), { model: 'AMM_DAILY_RESET', pool: b.pool, sellTaxBps: 300, poolFeeBps: 30 });
  assert.ok(s.daiOut < b.daiIn);
  assert.equal(s.pool.rebuilt, false);
  const next = makeDayPool({ priceDaiPerAilgns: wad('800'), depthDai: wad('800000') });
  assert.equal(next.dai, pool.dai);
});

test('RPC 허용목록: 쓰기/서명 메서드 거부', async () => {
  await assert.rejects(rpcCall(async () => ({}), 'https://x', 'eth_sendRawTransaction', []), /허용되지 않은/);
  await assert.rejects(rpcCall(async () => ({}), 'https://x', 'personal_sign', []), /허용되지 않은/);
});

test('refreshLive 실패: 값은 UNAVAILABLE, 0으로 대체 없음, 오류 노출', async () => {
  const fail = async () => { throw new Error('network'); };
  const r = await refreshLive({ fetchImpl: fail, now: () => FETCHED_MS, timeoutMs: 20, base: snap() });
  assert.equal(r.snapshot.mode, 'UNAVAILABLE');
  assert.equal(r.snapshot.values.turbineFeeBps.value, null);
  assert.ok(r.errors.length > 0);
});

test('refreshLive timeout 처리', async () => {
  const hang = () => new Promise(() => {});
  const r = await refreshLive({ fetchImpl: hang, now: () => FETCHED_MS, timeoutMs: 20, base: snap() });
  assert.ok(r.errors.some((e) => e.includes('timeout') || e.includes('abort')));
});

const okR = (j) => ({ ok: true, status: 200, json: async () => j });
const API_OK = {
  protocol: { fees: { sellFeeBps: 250, turbineFeeBps: 250, turbineLockSeconds: 250 }, clock: { daySeconds: 86400 },
    contracts: { DAI_ADDRESS: '0x83fd06F0846d9D90B3016bF670Efe2E0B11cDe14', AILGNS_DAI_PAIR: '0x0a1Cce65d995C6C5100e6F5bA3c388Ef34CEcaf0' } },
  emission: { clock: { currentDay: 27, dayStart: 1792771200 }, factor: { factorBps: 3000 }, community: { budgetToday: '31500.0', actualToday: null } },
  power: { totalActivePower: '1' },
};
const makeMock = ({ code = '0x6080', api = API_OK, calls = [] } = {}) => async (url, init) => {
  if (init.method === 'POST') {
    const b = JSON.parse(init.body); calls.push(b);
    const res = { eth_blockNumber: '0x106a6e2', eth_chainId: '0x1', eth_getBlockByNumber: { hash: '0xabc', timestamp: '0x1' }, eth_getCode: code, eth_getStorageAt: '0x0' }[b.method]
      ?? (b.params[0].data === '0x549c4627' ? '0x1' : '0xfa');
    return okR({ result: res });
  }
  return okR(api[url.split('/').pop()]);
};

test('refreshLive: 의존 API 필드 누락 시 옛값 유지 금지 → UNAVAILABLE·PARTIAL', async () => {
  const api = { ...API_OK, protocol: { fees: API_OK.protocol.fees, contracts: API_OK.protocol.contracts } };
  const r = await refreshLive({ fetchImpl: makeMock({ api }), now: () => FETCHED_MS, timeoutMs: 50, base: snap() });
  assert.equal(r.snapshot.values.daySeconds.value, null);
  assert.equal(r.snapshot.mode, 'PARTIAL');
  assert.ok(r.issues.some((i) => i.code === 'API_SHAPE'));
});

test('refreshLive: 코드/구현 지문 변경 → PENDING_VERIFICATION', async () => {
  const first = await refreshLive({ fetchImpl: makeMock(), now: () => FETCHED_MS, timeoutMs: 50, base: snap() });
  assert.ok(first.issues.some((i) => i.code === 'NO_BASELINE'));
  const same = await refreshLive({ fetchImpl: makeMock(), now: () => FETCHED_MS, timeoutMs: 50, base: first.snapshot });
  assert.equal(same.snapshot.meta.verification, 'FINGERPRINT_MATCH');
  const changed = await refreshLive({ fetchImpl: makeMock({ code: '0x6081' }), now: () => FETCHED_MS, timeoutMs: 50, base: first.snapshot });
  assert.equal(changed.snapshot.mode, 'PENDING_VERIFICATION');
  assert.ok(changed.issues.some((i) => i.code === 'IMPL_CHANGED'));
});

test('refreshLive: 필드별 fetchedAt 오래되면 STALE', async () => {
  let t = FETCHED_MS;
  const r = await refreshLive({ fetchImpl: makeMock(), now: () => (t += 200_000), timeoutMs: 50, base: snap() });
  assert.notEqual(r.snapshot.mode, 'LIVE');
  assert.ok(r.issues.some((i) => i.code === 'FIELD_STALE'));
});

test('refreshLive 성공(모의): 같은 blockTag, OBSERVED만, LIVE_VERIFIED 없음', async () => {
  const calls = [];
  const r = await refreshLive({ fetchImpl: makeMock({ calls }), now: () => FETCHED_MS, timeoutMs: 50, base: snap() });
  assert.equal(r.snapshot.mode, 'LIVE', JSON.stringify(r.issues));
  assert.equal(r.snapshot.meta.chainId, 1);
  assert.equal(r.snapshot.meta.blockHash, '0xabc');
  assert.ok(calls.filter((c) => c.method === 'eth_call').every((c) => c.params[1] === '0x106a6e2'));
  for (const v of Object.values(r.snapshot.values)) assert.notEqual(v.status, STATUS.LIVE_VERIFIED);
  assert.equal(r.snapshot.values.turbineFeeBps.value, '250');
  assert.equal(r.snapshot.values.communityActualToday.value, null);
});

test('partial fingerprint RPC failure is unavailable, not a persistent implementation change', async()=>{
 const mock=makeMock();
 const broken=async(url,init)=>init.method==='POST' && JSON.parse(init.body).method==='eth_getCode' ? okR({error:{message:'temporary'}}) : mock(url,init);
 const good=await refreshLive({fetchImpl:mock,base:snap(),now:()=>FETCHED_MS});
 const failed=await refreshLive({fetchImpl:broken,base:good.snapshot,now:()=>FETCHED_MS});
 assert.notEqual(failed.snapshot.meta.verification,'PENDING_VERIFICATION');
 assert.notEqual(failed.snapshot.mode,'LIVE');
 const recovered=await refreshLive({fetchImpl:mock,base:failed.snapshot,now:()=>FETCHED_MS});
 assert.notEqual(recovered.snapshot.meta.verification,'PENDING_VERIFICATION');
});
