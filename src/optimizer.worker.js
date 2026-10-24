// 최적화 Web Worker. 프로토콜 helix-opt/1 (optimizer-contract.md).
// 받음: {type:'run', protocol, jobId, scenario, snapshot, horizons, fundings?, search?} | {type:'cancel', jobId}
// 보냄: {type:'progress'|'result'|'error'|'cancelled', protocol, jobId, ...}
// 새 run이 오면 이전 job을 중단하고, 중단·대체된 job의 결과는 보내지 않는다.
import { optimize, OPTIMIZER_PROTOCOL } from './strategies.js';

let current = null; // {jobId, signal}

/** 메시지 처리(테스트에서 직접 호출 가능). post(msg)로 응답. 반환 Promise는 job 종료 시 resolve. */
export function handleMessage(msg, post) {
  if (!msg || msg.type === undefined) return Promise.resolve();
  if (msg.protocol !== undefined && msg.protocol !== OPTIMIZER_PROTOCOL) {
    post({ type: 'error', protocol: OPTIMIZER_PROTOCOL, jobId: msg.jobId ?? null, message: `프로토콜 불일치 ${msg.protocol}` });
    return Promise.resolve();
  }
  if (msg.type === 'cancel') {
    if (current && (msg.jobId === undefined || msg.jobId === current.jobId)) {
      current.signal.aborted = true;
      post({ type: 'cancelled', protocol: OPTIMIZER_PROTOCOL, jobId: current.jobId });
      current = null;
    }
    return Promise.resolve();
  }
  if (msg.type !== 'run') return Promise.resolve();
  if (current) current.signal.aborted = true; // 이전 job 중단
  const job = { jobId: msg.jobId, signal: { aborted: false } };
  current = job;
  const live = () => current === job && !job.signal.aborted;
  return optimize(
    { scenario: msg.scenario, snapshot: msg.snapshot, years: msg.horizons ?? [1, 2, 3], fundings: msg.fundings ?? null },
    { signal: job.signal, search: msg.search ?? undefined, onProgress: (p) => { if (live()) post({ type: 'progress', protocol: OPTIMIZER_PROTOCOL, jobId: job.jobId, ...p }); } },
  ).then((res) => {
    if (live() && !res.cancelled) { post({ type: 'result', protocol: OPTIMIZER_PROTOCOL, jobId: job.jobId, results: res }); current = null; }
  }).catch((e) => {
    if (live()) { post({ type: 'error', protocol: OPTIMIZER_PROTOCOL, jobId: job.jobId, message: String(e?.message ?? e) }); current = null; }
  });
}

// 실제 Worker 전역에서만 연결(Node 테스트 import 시 비활성).
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (e) => { handleMessage(e.data, (m) => self.postMessage(m)); };
}
