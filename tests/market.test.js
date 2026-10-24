// 시장 시세 모듈 테스트. 가짜 fetch로 RPC/업비트 응답을 재현(네트워크 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMarket, MARKET, SEL, decodeString, decodeReserves, decodeAddress, spotPriceWad, mergeMarket, usableLeg, legFreshness, deriveFx } from '../src/market.js';

const E18 = 10n ** 18n;
const NOW = Date.UTC(2026, 9, 23, 9, 0, 0);
const hex64 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const resv = (r0, r1, t = 0) => '0x' + [r0, r1, t].map((x) => BigInt(x).toString(16).padStart(64, '0')).join('');
const strHex = (s) => { const h = [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); return '0x' + hex64(32).slice(2) + hex64(s.length).slice(2) + h.padEnd(64, '0'); };

const A = MARKET.anubis.tokens, AP = MARKET.anubis.pairs, P = MARKET.polygon;
const PLGNS = P.tokens.LGNS.address; // 검증된 Polygon LGNS(풀 token1)

/** 기본 정상 세계. 테스트별로 덮어쓴다. */
function world(o = {}) {
  const tok = (addr, dec, sym) => ({ [`${addr}:${SEL.decimals}`]: hex64(dec), [`${addr}:${SEL.symbol}`]: strHex(sym) });
  const pair = (p, t0, t1, r) => ({ [`${p}:${SEL.token0}`]: addrWord(t0), [`${p}:${SEL.token1}`]: addrWord(t1), [`${p}:${SEL.getReserves}`]: r });
  const anubis = {
    ...tok(A.DAI.address, 18, 'DAI'), ...tok(A.USDT.address, 6, 'USDT'), ...tok(A.LGNS.address, 9, 'LGNS'), ...tok(A.AILGNS.address, 18, 'AiLGNS'),
    ...pair(AP.AILGNS_DAI.address, A.AILGNS.address, A.DAI.address, resv(1000n * E18, 800000n * E18)),   // 800 DAI
    ...pair(AP.LGNS_DAI.address, A.DAI.address, A.LGNS.address, resv(5000n * E18, 10000n * 10n ** 9n)),  // 역순: 0.5 DAI
    ...pair(AP.DAI_USDT.address, A.DAI.address, A.USDT.address, resv(1000n * E18, 999n * 10n ** 6n)),    // 0.999 USDT
    ...(o.anubis ?? {}),
  };
  const polygon = {
    ...tok(P.tokens.DAI.address, 18, 'DAI'), ...tok(PLGNS, 9, 'LGNS'),
    ...pair(P.pairs.LGNS_DAI.address, P.tokens.DAI.address, PLGNS, resv(1000n * E18, 2000n * 10n ** 9n)), // 실제 순서 token0 DAI, token1 LGNS → 0.5 DAI
    ...(o.polygon ?? {}),
  };
  const nowSec = Math.floor(NOW / 1000);
  const chains = { anubis: { id: o.anubisChainId ?? '0x1a3a', ts: o.anubisTs ?? nowSec - 5, calls: anubis }, polygon: { id: '0x89', ts: nowSec - 3, calls: polygon } };
  const ticker = Object.hasOwn(o, 'ticker') ? o.ticker : [{ market: 'KRW-USDT', trade_price: 1335, timestamp: NOW - 2000 }];
  const calls = (o.log ??= []);
  return async (url, init) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    calls.push(url);
    if (url === MARKET.upbit.url) return o.upbitHttp ? { ok: false, status: o.upbitHttp, json: async () => ({}) } : ok(ticker);
    const c = url.includes('anubispace') ? chains.anubis : chains.polygon;
    if (o.down?.includes(url)) throw new Error('network');
    const { method, params } = JSON.parse(init.body);
    if (method === 'eth_chainId') return ok({ result: c.id });
    if (method === 'eth_blockNumber') return ok({ result: '0x100' });
    if (method === 'eth_getBlockByNumber') { assert.equal(params[0], '0x100'); return ok({ result: { timestamp: '0x' + c.ts.toString(16) } }); }
    if (method === 'eth_call') {
      assert.equal(params[1], '0x100', '같은 블록 고정');
      const k = `${params[0].to.toLowerCase()}:${params[0].data}`;
      return k in c.calls ? ok({ result: c.calls[k] }) : ok({ error: { message: 'execution reverted' } });
    }
    return ok({ error: { message: 'unexpected' } });
  };
}
const run = (o) => fetchMarket({ fetchImpl: world(o), now: () => NOW, timeoutMs: 1000 });

test('정상: 풀 spot·자리수 6/9/18·역순 reserve·교차 환율', async () => {
  const m = await run();
  assert.equal(m.mode, 'MARKET');
  const L = m.legs;
  assert.equal(L.ailgns.status, 'OK'); assert.equal(L.ailgns.value, (800n * E18).toString());
  assert.equal(L.lgnsAnubis.value, (E18 / 2n).toString()); // DAI가 token0인 역순 풀
  assert.equal(L.daiUsdt.value, (999n * E18 / 1000n).toString());
  assert.equal(L.upbit.value, (1335n * E18).toString());
  assert.equal(L.fx.status, 'OK'); assert.equal(L.fx.value, (999n * 1335n * E18 / 1000n).toString());
  assert.equal(L.lgnsPolygon.value, (E18 / 2n).toString());
  assert.equal(L.ailgns.source.blockNumber, 256);
  assert.equal(L.ailgns.source.chainId, '0x1a3a');
  assert.equal(L.lgnsAnubis.source.base.decimals, 9);
  assert.equal(L.daiUsdt.source.quote.decimals, 6);
});

test('잘못된 체인: Anubis 다리만 실패, Polygon·업비트는 개별 성공(전체 성공 표시 없음)', async () => {
  const m = await run({ anubisChainId: '0x1' });
  for (const k of ['ailgns', 'lgnsAnubis', 'daiUsdt']) { assert.equal(m.legs[k].status, 'UNAVAILABLE'); assert.match(m.legs[k].error, /체인 불일치/); assert.equal(m.legs[k].value, null); }
  assert.equal(m.legs.lgnsPolygon.status, 'OK');
  assert.equal(m.legs.upbit.status, 'OK');
  assert.equal(m.legs.fx.status, 'UNAVAILABLE');
  assert.equal(m.ok, undefined);
});

test('오래된/미래 블록 거부', async () => {
  const nowSec = Math.floor(NOW / 1000);
  assert.match((await run({ anubisTs: nowSec - 1000 })).legs.ailgns.error, /오래됨/);
  assert.match((await run({ anubisTs: nowSec + 600 })).legs.ailgns.error, /미래/);
});

test('업비트: 오래됨·미래·형식 오류·HTTP 실패는 거부하고 환율 미산출', async () => {
  const stale = await run({ ticker: [{ market: 'KRW-USDT', trade_price: 1335, timestamp: NOW - 301000 }] });
  assert.equal(stale.legs.upbit.status, 'UNAVAILABLE'); assert.equal(stale.legs.fx.status, 'UNAVAILABLE');
  assert.equal(stale.legs.ailgns.status, 'OK');
  assert.equal((await run({ ticker: [{ market: 'KRW-USDT', trade_price: 1335, timestamp: NOW + 600000 }] })).legs.upbit.status, 'UNAVAILABLE');
  for (const bad of [[{ market: 'KRW-USDT', trade_price: 0, timestamp: NOW }], [{ market: 'KRW-USDT', trade_price: '1335', timestamp: NOW }], [{ market: 'KRW-BTC', trade_price: 1, timestamp: NOW }], {}, null])
    assert.equal((await run({ ticker: bad })).legs.upbit.status, 'UNAVAILABLE');
  assert.equal((await run({ upbitHttp: 503 })).legs.upbit.status, 'UNAVAILABLE');
});

test('reserve 0·유동성 부족·형식 오류·revert는 해당 다리만 거부', async () => {
  const k = `${AP.AILGNS_DAI.address}:${SEL.getReserves}`;
  const zero = await run({ anubis: { [k]: resv(0n, 0n) } });
  assert.equal(zero.legs.ailgns.status, 'UNAVAILABLE'); assert.equal(zero.legs.lgnsAnubis.status, 'OK');
  assert.match((await run({ anubis: { [k]: resv(1000n * E18, E18 / 10n) } })).legs.ailgns.error, /유동성/);
  assert.match((await run({ anubis: { [k]: '0x1234' } })).legs.ailgns.error, /형식/);
  const t0 = `${AP.AILGNS_DAI.address}:${SEL.token0}`;
  assert.equal((await run({ anubis: { [t0]: '0xzz' } })).legs.ailgns.status, 'UNAVAILABLE');
  const dec = `${A.LGNS.address}:${SEL.decimals}`;
  assert.match((await run({ anubis: { [dec]: hex64(18) } })).legs.lgnsAnubis.error, /decimals/);
});

test('토큰 정체 검사: 다른 토큰이 섞인 풀·DAI 없는 풀·Polygon symbol 불일치 거부', async () => {
  const other = '0x' + 'cd'.repeat(20);
  const t0 = `${AP.AILGNS_DAI.address}:${SEL.token0}`;
  const w = await run({ anubis: { [t0]: addrWord(other), [`${other}:${SEL.decimals}`]: hex64(18), [`${other}:${SEL.symbol}`]: strHex('AiLGNS') } });
  assert.match(w.legs.ailgns.error, /주소 불일치/);
  const t1 = `${AP.AILGNS_DAI.address}:${SEL.token1}`;
  assert.match((await run({ anubis: { [t1]: addrWord(A.AILGNS.address) } })).legs.ailgns.error, /정확히 하나/);
  // Polygon: decimals 9·symbol LGNS여도 고정 주소가 아니면 거부
  const fake = '0x' + 'ab'.repeat(20), pt1 = `${P.pairs.LGNS_DAI.address}:${SEL.token1}`;
  const wp = await run({ polygon: { [pt1]: addrWord(fake), [`${fake}:${SEL.decimals}`]: hex64(9), [`${fake}:${SEL.symbol}`]: strHex('LGNS') } });
  assert.match(wp.legs.lgnsPolygon.error, /주소 불일치/);
  const ps = `${PLGNS}:${SEL.symbol}`;
  assert.match((await run({ polygon: { [ps]: strHex('FAKE') } })).legs.lgnsPolygon.error, /symbol/);
  const pd = `${PLGNS}:${SEL.decimals}`;
  assert.match((await run({ polygon: { [pd]: hex64(18) } })).legs.lgnsPolygon.error, /decimals/);
});

test('Polygon 첫 RPC 실패 시 대체 RPC 1회', async () => {
  const m = await run({ down: [MARKET.polygon.rpcs[0]] });
  assert.equal(m.legs.lgnsPolygon.status, 'OK');
  assert.equal(m.legs.lgnsPolygon.source.rpc, MARKET.polygon.rpcs[1]);
});

test('디코더와 가격 계산', () => {
  assert.equal(decodeString(strHex('LGNS')), 'LGNS');
  assert.equal(decodeString('0x' + Buffer.from('DAI').toString('hex').padEnd(64, '0')), 'DAI'); // bytes32
  assert.throws(() => decodeString('0x12'));
  assert.throws(() => decodeAddress('0x' + '1'.repeat(64)));
  assert.throws(() => decodeReserves(resv(1n << 113n, 1n)));
  assert.equal(spotPriceWad(10n ** 9n, 9, E18, 18), E18);           // 1 LGNS(9) = 1 DAI
  assert.equal(spotPriceWad(E18, 18, 10n ** 6n, 6), E18);            // 1 DAI = 1 USDT(6)
  assert.throws(() => spotPriceWad(0n, 18, E18, 18));
});

test('교차 환율은 두 다리가 모두 OK일 때만', () => {
  const ok = { status: 'OK', value: E18.toString(), fetchedAt: new Date(NOW).toISOString() };
  assert.equal(deriveFx(ok, { status: 'UNAVAILABLE' }).status, 'UNAVAILABLE');
  assert.equal(deriveFx(ok, { ...ok, value: (1335n * E18).toString() }).value, (1335n * E18).toString());
});

test('업비트는 공식 API 주소로 조회 1회당 1요청', async () => {
  assert.equal(MARKET.upbit.url, 'https://api.upbit.com/v1/ticker?markets=KRW-USDT');
  const o = {};
  await run(o);
  assert.equal(o.log.filter((u) => u === MARKET.upbit.url).length, 1);
  assert.ok(!o.log.some((u) => u.includes('awake-market-api')));
});

test('병합: 새 조회 실패 다리는 이전 성공값을 previous로만 보관(계산 불가)', async () => {
  const good = await run();
  const bad = await run({ anubisChainId: '0x1' });
  const m = mergeMarket(good, bad);
  assert.equal(m.legs.ailgns.status, 'UNAVAILABLE');
  assert.equal(m.legs.ailgns.previous.value, good.legs.ailgns.value);
  assert.equal(usableLeg(m.legs.ailgns, NOW), false);
});

test('신선도: 300초 만료·60초 넘는 미래 조회시각·형식 오류는 사용 불가(던지지 않음)', async () => {
  const g = (await run()).legs.ailgns;
  assert.equal(legFreshness(g, NOW), 'OK'); assert.equal(usableLeg(g, NOW), true);
  assert.equal(legFreshness(g, NOW + 300000), 'OK');
  assert.equal(legFreshness(g, NOW + 301000), 'EXPIRED'); assert.equal(usableLeg(g, NOW + 301000), false);
  assert.equal(legFreshness({ ...g, fetchedAt: new Date(NOW + 61000).toISOString() }, NOW), 'FUTURE');
  assert.equal(legFreshness({ ...g, fetchedAt: new Date(NOW + 30000).toISOString() }, NOW), 'OK');
  for (const value of ['0', '-5', 'abc', '1.5', '']) assert.equal(usableLeg({ ...g, value }, NOW), false);
  assert.equal(usableLeg({ ...g, fetchedAt: 'not-a-date' }, NOW), false);
  assert.equal(usableLeg(null, NOW), false);
});
