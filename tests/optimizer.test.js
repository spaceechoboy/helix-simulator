// Task 3 최적화 테스트. 미래 조건은 ASSUMED 시나리오 — 결과는 '검색한 전략 중 최적'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeInput, STATUS } from '../src/schema.js';
import { snapshotFromEvidence } from '../src/data.js';
import { simulate } from '../src/engine.js';
import { makePolicy, optimize, pickWinners, snapshotGate, createOptimizerClient, SEARCH_LABEL, FUTURE_NOTE, OPTIMIZER_PROTOCOL } from '../src/strategies.js';
import { handleMessage } from '../src/optimizer.worker.js';

const saved = JSON.parse(readFileSync(new URL('../evidence/snapshot.json', import.meta.url), 'utf8'));
const snap = snapshotFromEvidence(saved.rawEvidence);
const base = (o = {}) => normalizeInput({ asset: 'DAI', amount: '1000', startDate: '2026-10-23', reserveDai: '50', totalBudgetDai: '1200', ...o, engine: { gas: { anubisNativeDai: '100' }, ...(o.engine ?? {}) } });
const COARSE = { ratioStep: 2500, refineStep: 500, refineSpan: 1000, switchStride: 60, yieldEvery: 5 };

test('makePolicy: 유형·검증·키', () => {
  assert.equal(makePolicy({ type: 'sell' }).recycleBps, 0);
  assert.equal(makePolicy({ type: 'reburn' }).recycleBps, 10000);
  assert.equal(makePolicy({ type: 'ratio', ratio: 2510 }).key, 'r:2510');
  assert.equal(makePolicy({ type: 'switch', switchDay: 40 }).key, 's:40');
  assert.throws(() => makePolicy({ type: 'ratio', ratio: 10001 }));
  assert.throws(() => makePolicy({ type: 'switch', switchDay: -1 }));
});

test('이전 회귀 최적일(167/532/897) 하드코딩 없음', () => {
  const src = readFileSync(new URL('../src/strategies.js', import.meta.url), 'utf8');
  assert.ok(!/\b(167|532|897)\b/.test(src));
});

test('summaryOnly는 전체 장부와 동일 결과', () => {
  const p = makePolicy({ type: 'switch', switchDay: 100 });
  const a = simulate(base(), snap, p).summary, b = simulate(base(), snap, p, { summaryOnly: true });
  for (const k of ['I', 'W', 'net', 'roiBps', 'paybackDay', 'reUnrecovered', 'topups', 'completed', 'daysSimulated', 'endReturnDai']) assert.equal(b.summary[k], a[k], k);
  assert.equal(b.events.length, 0);
  assert.equal(b.daily.length, a.milestones.length);
  a.milestones.forEach((m, i) => assert.equal(b.summary.milestones[i].record.cumWithdrawal, m.record.cumWithdrawal));
});

test('1년 기본 격자: 1% 전수 + 0.1% 세분 + 모든 전환일, 승자 재실행 일치', async () => {
  const sc = base();
  const res = await optimize({ scenario: sc, snapshot: snap, years: [1] });
  const r = res.results[0];
  const c0 = r.searched.refineCenter;
  let refined = 0; for (let b = Math.max(0, c0 - 90); b <= Math.min(10000, c0 + 90); b += 10) if (b % 100) refined++;
  assert.equal(r.candidatesEvaluated, 101 + refined + 366);
  assert.equal(r.label, SEARCH_LABEL);
  assert.ok(res.notes.includes(FUTURE_NOTE));
  const w = r.winners.maxNet.winner;
  const rp = r.replays[w.policy.key];
  assert.equal(rp.verified, true);
  const direct = simulate({ ...sc, horizonYears: 1 }, snap, w.policy);
  assert.equal(direct.summary.net, rp.full.summary.net);
  assert.equal(direct.daily.length, rp.full.daily.length);
  assert.ok(r.winners.maxRoi && r.winners.fastestPayback !== undefined);
  assert.equal(r.winners.leastTopup, null); // 비용충당형은 해당 없음
});

test('1/2/3년 각각 탐색(윤년 포함 일수)', async () => {
  // 3년 가스 소모를 감안해 네이티브 가스 200, 총예산 1300(=1000+50+200 이상)
  const sc = base({ totalBudgetDai: '1300', engine: { gas: { anubisNativeDai: '200' } } });
  const res = await optimize({ scenario: sc, snapshot: snap, years: [1, 2, 3] }, { search: COARSE });
  assert.deepEqual(res.results.map((r) => r.horizonDays), [365, 731, 1096]);
  for (const r of res.results) assert.ok(r.winners.maxNet, `y${r.horizonYears}`);
});

test('예산 초과 후보는 정상 승자에서 제외', async () => {
  const res = await optimize({ scenario: base({ totalBudgetDai: '1100' }), snapshot: snap, years: [1] }, { search: COARSE });
  const r = res.results[0];
  assert.equal(r.winners.maxNet, null);
  assert.equal(r.conditional.count, r.candidatesEvaluated);
  assert.ok(r.conditional.byReason.OVER_BUDGET > 0);
});

test('막힌 진입(depositsOpen=0)·CONFLICT 스냅샷은 조건부 목록으로 격리', async () => {
  const closed = structuredClone(snap); closed.values.depositsOpen.value = '0';
  const a = (await optimize({ scenario: base(), snapshot: closed, years: [1] }, { search: COARSE })).results[0];
  assert.equal(a.winners.maxNet, null);
  assert.ok(a.conditional.byReason['INCOMPLETE:ENTRY_NOT_EXECUTED'] > 0);
  const conf = structuredClone(snap); conf.values.sellFeeBps.status = STATUS.CONFLICT;
  assert.ok(snapshotGate(base(), conf).reasons.includes('SNAPSHOT:sellFeeBps:CONFLICT'));
  assert.equal(snapshotGate(base({ engine: { sellTaxBps: 300 } }), conf).ok, true); // 사용자 값으로 대체 시 비의존
  const b = (await optimize({ scenario: base(), snapshot: conf, years: [1] }, { search: COARSE })).results[0];
  assert.equal(b.winners.maxNet, null);
  assert.equal(b.conditional.count, b.candidatesEvaluated);
});

test('외부 DAI: 추가자금 최소 승자 별도, 분모에 추가투입 포함', async () => {
  const sc = base({ funding: 'EXTERNAL', reserveDai: '0', externalBudget: { dailyDai: '100', totalDai: '100000' } });
  const r = (await optimize({ scenario: sc, snapshot: snap, years: [1] }, { search: COARSE })).results[0];
  assert.equal(r.funding, 'EXTERNAL');
  const w = r.winners.leastTopup.winner;
  assert.equal(w.I, w.initialCapitalDai + w.topups);
});

test('동률은 ties에 모두 표시, 지표별 승자 분리', () => {
  const c = (ratio, net, payback) => ({ policy: makePolicy({ type: 'ratio', ratio }), modelEligible: true, net, I: 100n, paybackDay: payback, topups: 0n });
  const w = pickWinners([c(0, 10n, 5), c(100, 10n, 5), c(200, 5n, 3)]);
  assert.deepEqual(w.maxNet.ties, ['r:0', 'r:100']);
  assert.equal(w.maxRoi.tieCount, 2);
  assert.equal(w.fastestPayback.winner.policy.key, 'r:200');
  assert.equal(w.nearBest.count, 2);
});

test('진행률·취소', async () => {
  const seen = [];
  const full = await optimize({ scenario: base(), snapshot: snap, years: [1] }, { search: COARSE, onProgress: (p) => seen.push(p) });
  assert.equal(full.cancelled, false);
  assert.ok(seen.every((p, i) => i === 0 || p.done >= seen[i - 1].done));
  assert.equal(seen.at(-1).phase, 'done');
  const signal = { aborted: false };
  const c = await optimize({ scenario: base(), snapshot: snap, years: [1] }, { search: COARSE, signal, onProgress: () => { signal.aborted = true; } });
  assert.equal(c.cancelled, true);
});

test('worker: 새 run이 이전 job 대체(stale 결과 미전송), cancel, 프로토콜 검사', async () => {
  const out = [];
  const msg = (jobId) => ({ type: 'run', protocol: OPTIMIZER_PROTOCOL, jobId, scenario: base(), snapshot: snap, horizons: [1], search: COARSE });
  const p1 = handleMessage(msg(1), (m) => out.push(m));
  const p2 = handleMessage(msg(2), (m) => out.push(m));
  await Promise.all([p1, p2]);
  assert.ok(!out.some((m) => m.jobId === 1 && m.type === 'result'));
  assert.equal(out.filter((m) => m.type === 'result' && m.jobId === 2).length, 1);
  const out2 = [];
  const p3 = handleMessage(msg(3), (m) => out2.push(m));
  await handleMessage({ type: 'cancel', jobId: 3 }, (m) => out2.push(m));
  await p3;
  assert.ok(out2.some((m) => m.type === 'cancelled' && m.jobId === 3));
  assert.ok(!out2.some((m) => m.type === 'result'));
  const out3 = [];
  await handleMessage({ type: 'run', protocol: 'helix-opt/0', jobId: 9 }, (m) => out3.push(m));
  assert.equal(out3[0].type, 'error');
});

test('client: 재실행 시 terminate, stale jobId 무시', () => {
  const workers = [], got = [];
  const createWorker = () => { const w = { posted: [], terminated: false, postMessage(m) { this.posted.push(m); }, terminate() { this.terminated = true; } }; workers.push(w); return w; };
  const cl = createOptimizerClient({ createWorker, onResult: (m) => got.push(m.jobId), onCancelled: () => got.push('c') });
  const j1 = cl.run({ scenario: {}, snapshot: {} });
  const j2 = cl.run({ scenario: {}, snapshot: {} });
  assert.equal(workers[0].terminated, true);
  workers[0].onmessage({ data: { type: 'result', protocol: OPTIMIZER_PROTOCOL, jobId: j1 } });
  workers[1].onmessage({ data: { type: 'result', protocol: OPTIMIZER_PROTOCOL, jobId: j1 } });
  assert.deepEqual(got, []);
  workers[1].onmessage({ data: { type: 'result', protocol: OPTIMIZER_PROTOCOL, jobId: j2 } });
  assert.deepEqual(got, [j2]);
  cl.run({ scenario: {}, snapshot: {} }); cl.cancel();
  assert.equal(workers[2].terminated, true);
  assert.equal(got.at(-1), 'c');
});
