// 공개 시장 시세(읽기 전용). Anubis/Polygon 풀 reserve spot + 업비트 USDT/KRW.
// 엔진 계산 규칙과 무관한 입력 공급자. 실행 가능 견적이 아니며 미래 가격 예측도 아니다.
// 각 체인 읽기는 같은 블록에 고정하고, 다리(leg)별로 실패를 분리한다. 실패한 다리는 값 없이 UNAVAILABLE.
import { WAD, wmul, rescale } from './decimal.js';

export const MARKET = Object.freeze({
  anubis: {
    chainId: '0x1a3a', rpcs: ['https://rpc4.anubispace.org'],
    tokens: {
      DAI: { address: '0x83fd06f0846d9d90b3016bf670efe2e0b11cde14', decimals: 18 },
      USDT: { address: '0xdfb6a28bc6dc51fed17c27c880f2c66cdd040a3e', decimals: 6 },
      LGNS: { address: '0x4d1d808a081fdac440703b3765fc61f8028c06b8', decimals: 9 },
      AILGNS: { address: '0x256edb652db43e721ec6a12b6b51b6967d3bb8cb', decimals: 18 },
    },
    pairs: {
      AILGNS_DAI: { address: '0x0a1cce65d995c6c5100e6f5ba3c388ef34cecaf0', base: 'AILGNS', quote: 'DAI' },
      LGNS_DAI: { address: '0x32a4586797e3f561f41c0f47ca57ed08d64f3dc0', base: 'LGNS', quote: 'DAI' },
      DAI_USDT: { address: '0xf14c0e3da42fc36a416e6036dc4c7ca0375b734f', base: 'DAI', quote: 'USDT' },
    },
  },
  polygon: {
    chainId: '0x89', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://1rpc.io/matic'],
    tokens: {
      DAI: { address: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', decimals: 18 },
      LGNS: { address: '0xeb51d9a39ad5eef215dc0bf39a8821ff804a0f01', decimals: 9 }, // 풀 token1로 확인된 주소
    },
    pairs: { LGNS_DAI: { address: '0x882df4b0fb50a229c3b4124eb18c759911485bfb', base: 'LGNS', baseIdentity: { symbol: 'LGNS' }, quote: 'DAI' } },
  },
  // 공식 API(Access-Control-Allow-Origin: * 확인). 갱신 1회당 1요청, 재시도 없음.
  upbit: { url: 'https://api.upbit.com/v1/ticker?markets=KRW-USDT', market: 'KRW-USDT' },
  maxBlockAgeSec: 300, maxTickerAgeSec: 300, maxFutureSec: 60, timeoutMs: 8000,
  minQuoteReserve: WAD, // DAI 쪽 1 DAI 미만이면 유동성 없음으로 거부
});

export const SEL = Object.freeze({ token0: '0x0dfe1681', token1: '0xd21220a7', getReserves: '0x0902f1ac', decimals: '0x313ce567', symbol: '0x95d89b41' });
export const FX_LABEL = '교차 환산 · Anubis DAI/USDT × 업비트 USDT/KRW (브리지/환전 비용 제외)';
const RPC_METHODS = ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call'];

// ---- ABI 디코딩(형식이 어긋나면 던진다) ----
const WORD = /^0x[0-9a-fA-F]{64}$/;
export function decodeUint(h) { if (!WORD.test(h ?? '')) throw new Error('uint 응답 형식 오류'); return BigInt(h); }
export function decodeAddress(h) {
  if (!WORD.test(h ?? '')) throw new Error('address 응답 형식 오류');
  if (BigInt('0x' + h.slice(2, 26)) !== 0n) throw new Error('address 상위 비트 오류');
  return '0x' + h.slice(26).toLowerCase();
}
export function decodeReserves(h) {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{192,}$/.test(h) || (h.length - 2) % 64) throw new Error('getReserves 응답 형식 오류');
  const w = (i) => BigInt('0x' + h.slice(2 + 64 * i, 66 + 64 * i));
  const r0 = w(0), r1 = w(1), last = w(2);
  const MAX112 = (1n << 112n) - 1n;
  if (r0 > MAX112 || r1 > MAX112) throw new Error('reserve 범위 오류');
  return { reserve0: r0, reserve1: r1, blockTimestampLast: Number(last) };
}
export function decodeString(h) {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]*$/.test(h) || (h.length - 2) % 64 || h.length < 66) throw new Error('string 응답 형식 오류');
  const hex = h.slice(2);
  const ascii = (x) => { let s = ''; for (let i = 0; i < x.length; i += 2) { const c = parseInt(x.slice(i, i + 2), 16); if (c === 0) break; s += String.fromCharCode(c); } return s; };
  if (hex.length === 64) return ascii(hex); // bytes32 symbol
  const off = Number(BigInt('0x' + hex.slice(0, 64))) * 2;
  if (off + 64 > hex.length) throw new Error('string offset 오류');
  const len = Number(BigInt('0x' + hex.slice(off, off + 64)));
  if (len > 64 || off + 64 + len * 2 > hex.length) throw new Error('string 길이 오류');
  return ascii(hex.slice(off + 64, off + 64 + len * 2));
}

/** base 토큰 1개의 quote 가격(WAD). 두 reserve를 18자리로 맞춘 뒤 나눈다. */
export function spotPriceWad(baseReserve, baseDecimals, quoteReserve, quoteDecimals) {
  const b = rescale(baseReserve, baseDecimals, 18), q = rescale(quoteReserve, quoteDecimals, 18);
  if (b <= 0n || q <= 0n) throw new Error('reserve 0 — 유동성 없음');
  return (q * WAD) / b;
}

// ---- 전송 ----
async function getJson(fetchImpl, url, init, timeoutMs) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let t1, t2;
  try {
    t1 = setTimeout(() => ac?.abort(), timeoutMs);
    const r = await Promise.race([
      fetchImpl(url, { ...init, signal: ac?.signal }),
      new Promise((_, rej) => { t2 = setTimeout(() => rej(new Error('timeout')), timeoutMs + 5); }),
    ]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t1); clearTimeout(t2); }
}
export async function rpc(fetchImpl, url, method, params, timeoutMs = MARKET.timeoutMs) {
  if (!RPC_METHODS.includes(method)) throw new Error(`허용되지 않은 RPC 메서드 ${method}`);
  const j = await getJson(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, timeoutMs);
  if (j?.error) throw new Error(`RPC 오류 ${j.error.message ?? ''}`.trim());
  if (j?.result === undefined || j?.result === null) throw new Error(`RPC 결과 없음 (${method})`);
  return j.result;
}

/** 체인 세션: chainId 확인 → 블록 고정 → 블록 시각 검사(미래/오래됨 거부). 첫 RPC 실패 시 다음 RPC 1회. */
export async function openSession(chain, { fetchImpl, nowMs, timeoutMs }) {
  const errs = [];
  for (const url of chain.rpcs.slice(0, 2)) {
    try {
      const id = await rpc(fetchImpl, url, 'eth_chainId', [], timeoutMs);
      if (String(id).toLowerCase() !== chain.chainId) throw new Error(`체인 불일치 ${id} ≠ ${chain.chainId}`);
      const blockHex = await rpc(fetchImpl, url, 'eth_blockNumber', [], timeoutMs);
      if (!/^0x[0-9a-fA-F]+$/.test(blockHex)) throw new Error('블록 번호 형식 오류');
      const blk = await rpc(fetchImpl, url, 'eth_getBlockByNumber', [blockHex, false], timeoutMs);
      if (!blk || !/^0x[0-9a-fA-F]+$/.test(blk.timestamp ?? '')) throw new Error('블록 시각 없음');
      const ts = Number(BigInt(blk.timestamp)), nowSec = Math.floor(nowMs / 1000);
      if (ts > nowSec + MARKET.maxFutureSec) throw new Error('블록 시각이 미래');
      if (nowSec - ts > MARKET.maxBlockAgeSec) throw new Error(`블록이 오래됨(${nowSec - ts}초)`);
      return { url, chainId: chain.chainId, blockHex, blockNumber: Number(BigInt(blockHex)), blockTimestamp: ts };
    } catch (e) { errs.push(`${url}: ${e.message}`); }
  }
  throw new Error(errs.join(' / '));
}

const call = (s, ctx, to, data) => rpc(ctx.fetchImpl, s.url, 'eth_call', [{ to, data }, s.blockHex], ctx.timeoutMs);

/** 한 풀을 고정 블록에서 읽고 토큰 정체·자리수·유동성을 검사한다. */
export async function readPair(s, chain, pairKey, ctx) {
  const p = chain.pairs[pairKey];
  const [t0, t1, rv] = await Promise.all([call(s, ctx, p.address, SEL.token0), call(s, ctx, p.address, SEL.token1), call(s, ctx, p.address, SEL.getReserves)]);
  const token0 = decodeAddress(t0), token1 = decodeAddress(t1), res = decodeReserves(rv);
  const meta = async (addr) => {
    const [d, sy] = await Promise.all([call(s, ctx, addr, SEL.decimals), call(s, ctx, addr, SEL.symbol).catch(() => null)]);
    const decimals = Number(decodeUint(d));
    if (!(decimals >= 0 && decimals <= 36)) throw new Error('decimals 범위 오류');
    let symbol = null; try { symbol = sy ? decodeString(sy) : null; } catch { symbol = null; }
    return { address: addr, decimals, symbol };
  };
  const [m0, m1] = await Promise.all([meta(token0), meta(token1)]);
  const quoteT = chain.tokens[p.quote];
  const isQuote = (m) => m.address === quoteT.address;
  if (isQuote(m0) === isQuote(m1)) throw new Error(`${p.quote} 토큰이 풀에 정확히 하나 있어야 함`);
  const [qm, bm, qr, br] = isQuote(m0) ? [m0, m1, res.reserve0, res.reserve1] : [m1, m0, res.reserve1, res.reserve0];
  if (qm.decimals !== quoteT.decimals) throw new Error(`${p.quote} decimals ${qm.decimals} ≠ ${quoteT.decimals}`);
  const bt = chain.tokens[p.base];
  if (!bt) throw new Error(`${p.base} 토큰 주소록 없음`);
  if (bm.address !== bt.address) throw new Error(`${p.base} 주소 불일치 ${bm.address}`);
  if (bm.decimals !== bt.decimals) throw new Error(`${p.base} decimals ${bm.decimals} ≠ ${bt.decimals}`);
  if (p.baseIdentity?.symbol && (bm.symbol ?? '').toUpperCase() !== p.baseIdentity.symbol) throw new Error(`${p.base} symbol ${bm.symbol ?? '없음'} ≠ ${p.baseIdentity.symbol}`);
  // DAI_USDT는 DAI가 base: quote 기준 검사는 USDT가 quote이므로 DAI 쪽(base) reserve로 유동성 판단
  const daiSide = p.quote === 'DAI' ? rescale(qr, qm.decimals, 18) : rescale(br, bm.decimals, 18);
  if (br <= 0n || qr <= 0n) throw new Error('reserve 0 — 유동성 없음');
  if (daiSide < MARKET.minQuoteReserve) throw new Error('DAI 쪽 reserve 1 DAI 미만 — 유동성 없음');
  const price = spotPriceWad(br, bm.decimals, qr, qm.decimals);
  return {
    value: price.toString(),
    source: { chainId: s.chainId, rpc: s.url, blockNumber: s.blockNumber, blockTimestamp: s.blockTimestamp, pair: p.address, token0, token1,
      base: bm, quote: qm, baseReserve: br.toString(), quoteReserve: qr.toString(), daiLiquidity: daiSide.toString(), reserveTimestampLast: res.blockTimestampLast },
  };
}

const leg = (key, label, unit, o) => ({ key, label, unit, status: 'UNAVAILABLE', value: null, error: null, source: null, fetchedAt: null, ...o });

/** 업비트 KRW-USDT 체결가. 타임스탬프가 300초보다 오래되거나 미래면 거부. */
export async function readUpbit({ fetchImpl, nowMs, timeoutMs }) {
  const j = await getJson(fetchImpl, MARKET.upbit.url, { method: 'GET' }, timeoutMs);
  const t = Array.isArray(j) ? j.find((x) => x?.market === MARKET.upbit.market) : null;
  if (!t) throw new Error('KRW-USDT 응답 없음');
  const p = t.trade_price, ts = Number(t.timestamp);
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) throw new Error('trade_price 형식 오류');
  if (!Number.isFinite(ts)) throw new Error('timestamp 없음');
  if (ts > nowMs + MARKET.maxFutureSec * 1000) throw new Error('timestamp가 미래');
  if (nowMs - ts > MARKET.maxTickerAgeSec * 1000) throw new Error(`시세가 오래됨(${Math.round((nowMs - ts) / 1000)}초)`);
  const s = String(p);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('trade_price 형식 오류');
  const [ip, fp = ''] = s.split('.');
  const value = BigInt(ip) * WAD + BigInt((fp + '0'.repeat(18)).slice(0, 18));
  return { value: value.toString(), source: { url: MARKET.upbit.url, market: t.market, tradePrice: s, tickerTimestamp: ts } };
}

/** DAI/KRW = (USDT per DAI) × (KRW per USDT). 두 다리 모두 OK일 때만. */
export function deriveFx(daiUsdt, upbit) {
  const base = leg('fx', 'DAI/KRW', 'KRW/DAI', { label: FX_LABEL });
  if (daiUsdt?.status !== 'OK' || upbit?.status !== 'OK') return { ...base, error: `구성 시세 없음(${[daiUsdt?.status !== 'OK' && 'DAI/USDT', upbit?.status !== 'OK' && 'USDT/KRW'].filter(Boolean).join(', ')})` };
  const v = wmul(BigInt(daiUsdt.value), BigInt(upbit.value));
  if (v <= 0n) return { ...base, error: '환산값 0' };
  return { ...base, status: 'OK', value: v.toString(), fetchedAt: [daiUsdt.fetchedAt, upbit.fetchedAt].sort()[0], source: { daiUsdt: daiUsdt.source, upbit: upbit.source } };
}

/**
 * 시장 시세 전체. 반환 {mode:'MARKET', fetchedAt, legs:{ailgns, lgnsAnubis, daiUsdt, upbit, lgnsPolygon, fx}}.
 * 다리별 status OK/UNAVAILABLE. 전체 성공 플래그는 없다(부분 실패를 숨기지 않음).
 */
export async function fetchMarket({ fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = MARKET.timeoutMs } = {}) {
  const nowMs = now(), fetchedAt = new Date(nowMs).toISOString();
  const ctx = { fetchImpl, nowMs, timeoutMs };
  const done = (l, r) => (r.status === 'fulfilled' ? { ...l, status: 'OK', value: r.value.value, source: r.value.source, fetchedAt } : { ...l, error: String(r.reason?.message ?? r.reason) });
  const anubis = (async () => {
    const s = await openSession(MARKET.anubis, ctx);
    const [a, l, d] = await Promise.allSettled(['AILGNS_DAI', 'LGNS_DAI', 'DAI_USDT'].map((k) => readPair(s, MARKET.anubis, k, ctx)));
    return { a, l, d };
  })();
  const polygon = (async () => { const s = await openSession(MARKET.polygon, ctx); return readPair(s, MARKET.polygon, 'LGNS_DAI', ctx); })();
  const [an, po, up] = await Promise.allSettled([anubis, polygon, readUpbit(ctx)]);
  const fromAnubis = (k) => (an.status === 'fulfilled' ? an.value[k] : { status: 'rejected', reason: an.reason });
  const legs = {
    ailgns: done(leg('ailgns', 'AiLGNS (Anubis 풀 spot)', 'DAI/AiLGNS'), fromAnubis('a')),
    lgnsAnubis: done(leg('lgnsAnubis', 'LGNS (Anubis 풀 spot)', 'DAI/LGNS'), fromAnubis('l')),
    daiUsdt: done(leg('daiUsdt', 'DAI/USDT (Anubis 풀 spot)', 'USDT/DAI'), fromAnubis('d')),
    lgnsPolygon: done(leg('lgnsPolygon', 'LGNS (Polygon 풀 spot)', 'DAI/LGNS'), po),
    upbit: done(leg('upbit', 'USDT/KRW (업비트)', 'KRW/USDT'), up),
  };
  legs.fx = deriveFx(legs.daiUsdt, legs.upbit);
  return { mode: 'MARKET', fetchedAt, legs, note: '풀 reserve spot·체결가 — 실행 견적 아님, 미래 가격은 이 값으로 고정 가정' };
}

/** 새 조회 병합: 새 다리가 실패하면 이전 성공값은 previous로만 보관(계산에는 쓰지 않음). */
export function mergeMarket(old, fresh) {
  const legs = {};
  for (const [k, l] of Object.entries(fresh?.legs ?? {})) {
    const prev = old?.legs?.[k];
    legs[k] = l.status === 'OK' ? l : { ...l, previous: prev?.status === 'OK' ? prev : prev?.previous ?? null };
  }
  return { ...fresh, legs };
}

export const MARKET_USE_MAX_AGE_SEC = 300;
/** 다리 신선도: 'OK' | 'EXPIRED'(300초 초과) | 'FUTURE'(조회시각이 60초 넘게 미래) | 'INVALID' | 'UNAVAILABLE'. */
export function legFreshness(l, nowMs = Date.now()) {
  if (!l || l.status !== 'OK' || l.value === null || l.value === undefined) return 'UNAVAILABLE';
  let v; try { v = BigInt(l.value); } catch { return 'INVALID'; }
  if (v <= 0n) return 'INVALID';
  const t = Date.parse(l.fetchedAt);
  if (!Number.isFinite(t)) return 'INVALID';
  if (t - nowMs > MARKET.maxFutureSec * 1000) return 'FUTURE';
  if ((nowMs - t) / 1000 > MARKET_USE_MAX_AGE_SEC) return 'EXPIRED';
  return 'OK';
}
/** 계산에 쓸 수 있는 다리: OK + 조회 후 300초 이내 + 값 형식 정상. 던지지 않는다. */
export const usableLeg = (l, nowMs = Date.now()) => legFreshness(l, nowMs) === 'OK';
