// 데이터 계층: 저장 증거 → snapshot, 검증, 공개 API/RPC 읽기 전용 갱신. DESIGN §9.
// 자동 LIVE_VERIFIED 금지: 함수 의미 검증 전 체인 값은 OBSERVED.
import { STATUS, ev } from './schema.js';

export const ANUBIS_CHAIN_ID = null; // 저장 증거에 chainId 없음(SUSPECT) — eth_chainId 결과로만 채운다.
export const RPC_URLS = ['https://rpc4.anubispace.org'];
export const API_BASE = 'https://awakehelix.io/api/v1';
export const RPC_ALLOWED_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode', 'eth_getStorageAt']);
export const STALE_SECONDS = 300; // UI 기준(프로토콜 규칙 아님)
export const TIMEOUT_MS = 10000;
export const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// 체인 읽기 목록: 증거 JSON의 chain 키 → snapshot 키, 단위, 메모.
export const CHAIN_READS = [
  ['powerRateBps', 'daiPowerRateBps', 'bps', 'DAI→Power 25000bps=2.5배'],
  ['ailgnsTwapRateBps', 'ailgnsPowerRateBps', 'bps', 'AiLGNS→Power 재소각 배수(Production NFT 3배와 별개)'],
  ['annualRateBps_unnamedGetter', 'annualRateBps', 'bps', 'unnamed getter — 의미 미검증'],
  ['lgnsPowerRate', 'lgnsPowerRate', 'wad', 'LGNS→Power 비율 후보; 시세>1 규칙 미검증'],
  ['dailyBurnPowerCap', 'dailyBurnPowerCap', 'power-wad', 'LGNS 소각 일일 Power 한도(전체)'],
  ['dailyAilgnsBurnPowerCap', 'dailyAilgnsBurnPowerCap', 'power-wad', 'AiLGNS 소각 일일 한도(전체); 개인 접근 미확정'],
  ['dailyDaiPowerCap', 'dailyDaiPowerCap', 'power-wad', 'DAI 일일 한도(전체); 개인 배정 미확정'],
  ['depositsOpen', 'depositsOpen', 'bool', ''],
  ['turbineFeeBps', 'turbineFeeBps', 'bps', ''],
  ['lockSeconds', 'lockSeconds', 'seconds', '터빈 잠금'],
  ['totalSellFeeBps', 'sellFeeBps', 'bps', 'AiLGNS 매도세'],
  ['lastTwapPrice', 'oracleTwapDaiPerAilgns', 'dai-wad', 'Oracle TWAP — 정산가/spot/quote와 구분'],
];

// API 의존 필드: [snapshot 키, 경로, 응답 내 경로, 단위, 메모]. 갱신 시 전부 새로 채우거나 UNAVAILABLE.
export const API_FIELDS = [
  ['apiSellFeeBps', 'protocol', 'fees.sellFeeBps', 'bps'],
  ['apiTurbineFeeBps', 'protocol', 'fees.turbineFeeBps', 'bps'],
  ['apiTurbineBurnBps', 'protocol', 'fees.turbineBurnBps', 'bps', '수령자 영향 미확인 · 계산 미반영'],
  ['apiLockSeconds', 'protocol', 'fees.turbineLockSeconds', 'seconds'],
  ['daySeconds', 'protocol', 'clock.daySeconds', 'seconds'],
  ['daiTokenAddress', 'protocol', 'contracts.DAI_ADDRESS', 'address', 'API 주소록 후보 — 코드/구현 대조 전'],
  ['ailgnsDaiPair', 'protocol', 'contracts.AILGNS_DAI_PAIR', 'address', 'API 주소록 후보'],
  ['dappDay', 'emission', 'clock.currentDay', 'day'],
  ['dayStart', 'emission', 'clock.dayStart', 'unix'],
  ['factorBps', 'emission', 'factor.factorBps', 'bps', '개인 배출률에 직접 곱하지 않음'],
  ['communityBudgetToday', 'emission', 'community.budgetToday', 'ailgns'],
  ['communityActualToday', 'emission', 'community.actualToday', 'ailgns', 'null=미정산(0 아님)'],
  ['totalActivePower', 'power', 'totalActivePower', 'power'],
];
// 현재 공개 응답 최상위 키(2026-10-23 증거 기준).
export const API_TOP_KEYS = { protocol: ['fees', 'clock', 'contracts'], emission: ['clock', 'community', 'factor'], power: ['totalActivePower'] };
const OPTIONAL_NULL = new Set(['communityActualToday', 'apiTurbineBurnBps']);
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

function assumedValues() {
  return {
    poolFeeBps: ev('30', 'bps', { status: STATUS.ASSUMED, notes: '0.3% pair/router 미검증' }),
    tieBreakOrder: ev('unlock>eligible>settlement>turbine>sale/burn', 'order', { status: STATUS.ASSUMED, notes: '계약 순서 미검증' }),
  };
}

/** 원본 공개 증거(live-evidence JSON) → 저장 snapshot. 모든 값 mode=SAVED, 자동 LIVE 아님. */
export function snapshotFromEvidence(raw) {
  const values = {};
  for (const [src, key, unit, notes] of CHAIN_READS) {
    const c = raw.chain?.[src];
    values[key] = ev(c ? c.integer : null, unit, {
      chainId: ANUBIS_CHAIN_ID, contract: c?.address ?? null, method: c?.selector ?? null,
      blockNumber: raw.block, fetchedAt: raw.fetchedAt, sourceUrl: raw.rpc,
      status: c ? STATUS.OBSERVED : STATUS.UNAVAILABLE, confidence: c ? 'medium' : 'none', notes,
    });
  }
  for (const [key, path, p, unit, notes] of API_FIELDS) {
    const v = getPath(raw.api?.[path]?.sample, p);
    values[key] = ev(v ?? null, unit, { fetchedAt: raw.fetchedAt, sourceUrl: `${API_BASE}/${path}`, status: v == null ? STATUS.UNAVAILABLE : STATUS.OBSERVED, confidence: 'medium', notes: 'dApp 서버 관측(블록 없음) ' + (notes ?? '') });
  }
  Object.assign(values, assumedValues());
  const snap = { schemaVersion: 'helix-sim-snapshot/1', mode: 'SAVED', meta: { blockNumber: raw.block, fetchedAt: raw.fetchedAt, rpc: raw.rpc, chainId: null, blockHash: null, fingerprint: null }, values, issues: [] };
  return validateSnapshot(snap).snapshot;
}

// 도메인 규칙
const BPS_KEYS = ['turbineFeeBps', 'sellFeeBps', 'apiSellFeeBps', 'apiTurbineFeeBps', 'apiTurbineBurnBps', 'poolFeeBps', 'factorBps'];
const POSITIVE_KEYS = ['daiPowerRateBps', 'ailgnsPowerRateBps', 'annualRateBps', 'oracleTwapDaiPerAilgns', 'daySeconds', 'lgnsPowerRate'];
const NONNEG_KEYS = ['lockSeconds', 'apiLockSeconds', 'dailyBurnPowerCap', 'dailyAilgnsBurnPowerCap', 'dailyDaiPowerCap', 'dayStart', 'dappDay', 'communityBudgetToday', 'communityActualToday', 'totalActivePower'];
function domainError(k, v) {
  if (k === 'depositsOpen') return v === '0' || v === '1' ? null : '0/1 아님';
  if (k === 'daiTokenAddress' || k === 'ailgnsDaiPair') return /^0x[0-9a-fA-F]{40}$/.test(v) ? null : '주소 형식 아님';
  const all = [...BPS_KEYS, ...POSITIVE_KEYS, ...NONNEG_KEYS];
  if (!all.includes(k)) return null;
  if (!/^-?\d+(\.\d+)?$/.test(v)) return '숫자 아님';
  const neg = v.startsWith('-'), zero = /^-?0+(\.0+)?$/.test(v);
  if (neg && !zero) return '음수';
  if (POSITIVE_KEYS.includes(k) && zero) return '0 불가';
  if (BPS_KEYS.includes(k) && (!/^\d+$/.test(v) || Number(v) > 10000)) return '0~10000 정수 bps 아님';
  return null;
}

/** 검증: null/0 구분, 도메인, 필드별 stale, chain↔API 불일치, 필수값 누락. now(ms) 주입 가능. */
export function validateSnapshot(raw, { now = Date.now(), staleSeconds = STALE_SECONDS } = {}) {
  const issues = [];
  if (!raw || !raw.values) return { snapshot: null, issues: [{ level: 'error', code: 'NO_VALUES', msg: 'snapshot.values 없음' }] };
  const live = raw.mode === 'LIVE';
  const values = {};
  for (const [k, v] of Object.entries(raw.values)) {
    const e = { ...v };
    if (e.value === undefined || e.value === '') e.value = null;
    if (e.value !== null) {
      const de = domainError(k, String(e.value));
      if (de) { issues.push({ level: 'error', code: 'DOMAIN', key: k, msg: `${k}=${e.value} ${de}` }); e.notes = `${e.notes ?? ''} [도메인 오류: ${de}, 원값 ${e.value}]`; e.value = null; e.status = STATUS.UNAVAILABLE; }
    }
    if (e.value === null && e.status !== STATUS.UNAVAILABLE) { e.status = STATUS.UNAVAILABLE; issues.push({ level: 'warn', code: 'NULL', key: k, msg: `${k} 미조회(null) — 0으로 대체하지 않음` }); }
    if (e.status === STATUS.LIVE_VERIFIED && !live) { e.status = STATUS.OBSERVED; issues.push({ level: 'warn', code: 'DOWNGRADE', key: k, msg: '저장값은 LIVE_VERIFIED로 표시하지 않음' }); }
    if (live && e.status === STATUS.OBSERVED) {
      const t = e.fetchedAt ? Date.parse(e.fetchedAt) : NaN;
      if (!Number.isFinite(t) || (now - t) / 1000 > staleSeconds) { e.status = STATUS.STALE; issues.push({ level: 'warn', code: 'FIELD_STALE', key: k, msg: `${k} 조회시각 오래됨/없음` }); }
    }
    values[k] = e;
  }
  for (const k of ['daiPowerRateBps', 'turbineFeeBps', 'sellFeeBps', 'lockSeconds', 'oracleTwapDaiPerAilgns'])
    if (!values[k] || values[k].value === null) issues.push({ level: 'error', code: 'MISSING', key: k, msg: `${k} 필수값 없음` });
  for (const [a, b] of [['sellFeeBps', 'apiSellFeeBps'], ['turbineFeeBps', 'apiTurbineFeeBps'], ['lockSeconds', 'apiLockSeconds']]) {
    const x = values[a], y = values[b];
    if (x?.value != null && y?.value != null && x.value !== y.value) {
      x.status = STATUS.CONFLICT; y.status = STATUS.CONFLICT;
      issues.push({ level: 'error', code: 'CONFLICT', key: a, msg: `${a} 체인 ${x.value} ≠ API ${y.value}` });
    }
  }
  const fetchedMs = raw.meta?.fetchedAt ? Date.parse(raw.meta.fetchedAt) : NaN;
  const ageSeconds = Number.isFinite(fetchedMs) ? Math.floor((now - fetchedMs) / 1000) : null;
  const stale = ageSeconds === null || ageSeconds > staleSeconds;
  if (stale) issues.push({ level: 'info', code: 'STALE', msg: `조회 후 ${ageSeconds ?? '?'}초 경과 — 실시간 아님` });
  if (values.dailyBurnPowerCap?.value === '0') issues.push({ level: 'warn', code: 'LGNS_CAP0', msg: 'LGNS 소각 한도 0 — 재개 자동 가정 금지' });
  const snapshot = { ...raw, values, ageSeconds, stale, issues };
  if (live) {
    const incomplete = Object.entries(values).some(([k, e]) => e.status !== STATUS.ASSUMED && !OPTIONAL_NULL.has(k) && e.status !== STATUS.OBSERVED);
    if (raw.meta?.verification === 'PENDING_VERIFICATION') snapshot.mode = 'PENDING_VERIFICATION';
    else if (stale) snapshot.mode = 'STALE';
    else if (incomplete) { snapshot.mode = 'PARTIAL'; issues.push({ level: 'warn', code: 'PARTIAL', msg: '일부 필드 미갱신/불일치 — 실시간 아님' }); }
  }
  return { snapshot, issues };
}

// ---- 읽기 전용 갱신(코드만; 실행·CORS 검증은 브라우저에서 별도) ----
async function withTimeout(fetchImpl, url, init, ms) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let t2;
  const t = setTimeout(() => ac?.abort(), ms);
  try {
    const r = await Promise.race([
      fetchImpl(url, { ...init, signal: ac?.signal }),
      new Promise((_, rej) => { t2 = setTimeout(() => rej(new Error('timeout')), ms + 5); }),
    ]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); clearTimeout(t2); }
}

export async function rpcCall(fetchImpl, url, method, params, ms = TIMEOUT_MS) {
  if (!RPC_ALLOWED_METHODS.includes(method)) throw new Error(`허용되지 않은 RPC 메서드: ${method}`);
  const j = await withTimeout(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, ms);
  if (j.error) throw new Error(`RPC 오류 ${j.error.message ?? ''}`);
  return j.result;
}

/** 비암호 지문(FNV-1a 64). 변경 감지 전용 — 보안 해시 아님. */
export function fnv1a64(s) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}

export function fingerprintComplete(f) {
  const contracts = Object.values(f?.contracts ?? {});
  return Number.isInteger(f?.chainId) && f.chainId > 0 && contracts.length > 0
    && contracts.every(c => typeof c.codeHash === 'string' && c.codeHash.length > 0 && typeof c.impl === 'string' && /^0x[0-9a-f]+$/i.test(c.impl));
}

/** Adopt current observations only. Optional null is not a failed historical-value merge. */
export function acceptLiveSnapshot(fresh, now = Date.now()) {
  const snapshot = validateSnapshot(fresh, {now}).snapshot;
  snapshot.issues = [...new Map([...(fresh.issues ?? []), ...snapshot.issues].map(i => [`${i.code}:${i.key ?? ''}:${i.msg}`, i])).values()];
  return snapshot;
}

/** 기준 지문과 비교. 변경된 항목 목록 반환(기준 없으면 null). */
export function compareFingerprint(base, cur) {
  if (!fingerprintComplete(base) || !fingerprintComplete(cur)) return null;
  const diff = [];
  if (base.chainId !== cur.chainId) diff.push('chainId');
  for (const [addr, b] of Object.entries(base.contracts ?? {})) {
    const c = cur.contracts?.[addr];
    if (!c || c.codeHash !== b.codeHash) diff.push(`${addr}:code`);
    if (!c || c.impl !== b.impl) diff.push(`${addr}:impl`);
  }
  return diff;
}

/**
 * 공개 API/RPC 갱신. 같은 blockTag로 체인 값을 읽고, 모든 API 의존 필드를 새로 채운다(실패=UNAVAILABLE).
 * chainId·block hash·코드/EIP1967 구현 지문을 기록; 기준과 다르면 PENDING_VERIFICATION.
 * 반환 {snapshot, issues, errors}. 실패 시 호출측이 이전 snapshot과 나이를 유지해야 한다.
 */
export async function refreshLive({ fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = TIMEOUT_MS, rpcUrls = RPC_URLS, base = { values: {} } } = {}) {
  const errors = [], issues0 = [];
  const deadline = Date.now() + timeoutMs;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new Error('전체 조회 timeout'); return ms; };
  const stamp = () => new Date(now()).toISOString();
  let rpc = null, blockHex = null;
  for (const url of rpcUrls.slice(0, 2)) {
    try { blockHex = await rpcCall(fetchImpl, url, 'eth_blockNumber', [], remaining()); rpc = url; break; }
    catch (e) { errors.push(`${url}: ${e.message}`); }
  }
  const call = async (m, p, label) => { try { return await rpcCall(fetchImpl, rpc, m, p, remaining()); } catch (e) { errors.push(`${label}: ${e.message}`); return null; } };
  const blockNumber = blockHex ? Number(BigInt(blockHex)) : null;
  let chainId = null, blockHash = null, blockTimestamp = null, fingerprint = null;
  if (rpc) {
    const cid = await call('eth_chainId', [], 'chainId'); chainId = cid ? Number(BigInt(cid)) : null;
    const blk = await call('eth_getBlockByNumber', [blockHex, false], 'block');
    blockHash = blk?.hash ?? null; blockTimestamp = blk?.timestamp ? Number(BigInt(blk.timestamp)) : null;
    fingerprint = { chainId, contracts: {} };
    const addrs = [...new Set(CHAIN_READS.map(([, k]) => base.values?.[k]?.contract).filter(Boolean))];
    for (const a of addrs) {
      const code = await call('eth_getCode', [a, blockHex], `code ${a}`);
      const impl = await call('eth_getStorageAt', [a, EIP1967_IMPL_SLOT, blockHex], `impl ${a}`);
      fingerprint.contracts[a] = { codeHash: code == null ? null : fnv1a64(code), impl: impl ?? null };
    }
  }
  const values = { ...assumedValues() };
  for (const [k, v] of Object.entries(base.values ?? {})) if (v.status === STATUS.ASSUMED) values[k] = v;
  for (const [, key, unit, notes] of CHAIN_READS) {
    const prev = base.values?.[key];
    const contract = prev?.contract, method = prev?.method;
    let v = null;
    if (rpc && contract && method) {
      try { v = BigInt(await rpcCall(fetchImpl, rpc, 'eth_call', [{ to: contract, data: method }, blockHex], remaining())).toString(); }
      catch (e) { errors.push(`${key}: ${e.message}`); }
    }
    values[key] = ev(v, unit, { chainId, contract, method, blockNumber, blockTimestamp, fetchedAt: stamp(), sourceUrl: rpc, status: v === null ? STATUS.UNAVAILABLE : STATUS.OBSERVED, confidence: v === null ? 'none' : 'medium', notes });
  }
  const resp = {};
  for (const p of Object.keys(API_TOP_KEYS)) {
    try {
      const j = await withTimeout(fetchImpl, `${API_BASE}/${p}`, { method: 'GET' }, remaining());
      const missing = API_TOP_KEYS[p].filter((k) => !(k in (j ?? {})));
      if (missing.length) { issues0.push({ level: 'error', code: 'API_SHAPE', msg: `api/${p} 최상위 키 없음: ${missing.join(',')}` }); }
      resp[p] = { body: j, fetchedAt: stamp() };
    } catch (e) { errors.push(`api/${p}: ${e.message}`); resp[p] = null; }
  }
  for (const [key, path, p, unit, notes] of API_FIELDS) {
    const r = resp[path], v = r ? getPath(r.body, p) : undefined;
    values[key] = ev(v ?? null, unit, { fetchedAt: r?.fetchedAt ?? null, sourceUrl: `${API_BASE}/${path}`, status: v == null ? STATUS.UNAVAILABLE : STATUS.OBSERVED, notes: 'dApp 서버 관측(블록 없음) ' + (notes ?? '') });
  }
  const completeFingerprint = fingerprintComplete(fingerprint);
  if (!completeFingerprint) issues0.push({level:'warn',code:'FINGERPRINT_UNAVAILABLE',msg:'코드 지문 조회 실패 — 구현 변경으로 판정하지 않음'});
  const diff = fingerprint ? compareFingerprint(base.meta?.fingerprint ?? null, fingerprint) : null;
  let verification = 'NO_BASELINE';
  if (diff === null) issues0.push({ level: 'info', code: 'NO_BASELINE', msg: '기준 지문 없음 — 이번 지문을 기준 후보로 기록(검증 아님)' });
  else if (diff.length) { verification = 'PENDING_VERIFICATION'; issues0.push({ level: 'error', code: 'IMPL_CHANGED', msg: `구현/코드/체인 변경: ${diff.join(', ')} — 경로 검증대기` }); }
  else verification = 'FINGERPRINT_MATCH';
  const raw = { schemaVersion: 'helix-sim-snapshot/1', mode: rpc ? (completeFingerprint ? 'LIVE' : 'PARTIAL') : 'UNAVAILABLE', meta: { blockNumber, blockHash, blockTimestamp, chainId, fetchedAt: stamp(), rpc, fingerprint, verification }, values };
  const { snapshot, issues } = validateSnapshot(raw, { now: now() });
  snapshot.issues = [...issues0, ...issues];
  return { snapshot, issues: snapshot.issues, errors };
}

/** Current-input gate for the public calculator. Historical/offline engine replay remains separate. */
export function liveCalculationErrors(snapshot, now = Date.now()) {
  const errors = [];
  const fresh = (iso) => { const age = now - Date.parse(iso); return Number.isFinite(age) && age >= -60000 && age <= STALE_SECONDS * 1000; };
  if (!snapshot || !['LIVE', 'PARTIAL'].includes(snapshot.mode) || !fresh(snapshot.meta?.fetchedAt))
    errors.push('최신 프로토콜 데이터를 조회해야 계산할 수 있습니다. 저장값·5분 지난 값은 사용하지 않습니다.');
  if (!fingerprintComplete(snapshot?.meta?.fingerprint)) errors.push('프로토콜 코드 지문을 다시 조회해야 합니다.');
  if (snapshot?.meta?.verification === 'PENDING_VERIFICATION') errors.push('프로토콜 구현이 변경되어 검증이 필요합니다.');
  const blockAge = now - Number(snapshot?.meta?.blockTimestamp) * 1000;
  if (snapshot?.meta?.chainId !== 6714 || !snapshot?.meta?.blockHash || !Number.isFinite(blockAge) || blockAge < -60000 || blockAge > STALE_SECONDS * 1000)
    errors.push('Anubis 체인·최신 블록 확인이 필요합니다.');
  const required = [...CHAIN_READS.map(([, key]) => key), 'daySeconds', 'dayStart', 'apiSellFeeBps', 'apiTurbineFeeBps', 'apiLockSeconds'];
  for (const key of required) {
    const v = snapshot?.values?.[key];
    if (!v || v.value == null || !['OBSERVED', 'LIVE_VERIFIED'].includes(v.status) || !fresh(v.fetchedAt))
      errors.push(`최신 값 확인 필요: ${key}`);
  }
  return errors;
}
