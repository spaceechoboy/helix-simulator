// Polygon FIXED 경로(§15): Polygon LGNS FIXED 소각 → 인정액 기준 주기 지급(Anubis LGNS) → 청구 → HELIX 소각.
// 인정액(principalRecognizedDai)은 지급 계산용이며 ROI 원금이 아니다. 모든 FIXED 규칙은 오늘 미검증 → ASSUMED.
import { WAD } from './decimal.js';

const LGNS_UNIT = 10n ** 9n;

/**
 * @param fq getEntryQuote().fixed
 * @param startUnix FIXED 소각 시각
 * @returns FixedState
 */
export function createFixedState(fq, startUnix) {
  const missing = ['principalRecognizedDai', 'capRateWad', 'payoutRateWad', 'periodSeconds', 'payoutPriceDai'].filter((k) => fq?.[k] == null);
  return {
    enabled: missing.length === 0,
    status: missing.length ? 'PENDING_VERIFICATION' : 'ASSUMED',
    missing,
    polygonLgnsBurned: fq?.polygonLgnsBurned ?? 0n,       // 9자리
    principalRecognizedDai: fq?.principalRecognizedDai ?? null,
    capDai: missing.length ? null : (fq.principalRecognizedDai * fq.capRateWad) / WAD,
    payoutBpsPerPeriod: fq?.payoutBpsPerPeriod ?? null, // 표시용 문자열(소수 가능)
    payoutRateWad: fq?.payoutRateWad ?? null,           // 계산용 WAD 분수
    periodSeconds: fq?.periodSeconds ?? null,
    payoutPriceDai: fq?.payoutPriceDai ?? null,
    stopUnix: fq?.stopUnix ?? null,
    nextPayoutAt: fq?.periodSeconds ? startUnix + fq.periodSeconds : null,
    paidDai: 0n,          // 누적 지급 인정 DAI
    accruedLgns: 0n,      // 누적 지급 LGNS(9자리)
    unclaimedLgns: 0n,    // 지급됐으나 미청구(9자리)
    claimedLgns: 0n,
    stopped: false, capReached: false,
  };
}

/** 미지급 잔량(인정 DAI 기준). */
export const fixedRemainingDai = (s) => (s.capDai === null ? null : s.capDai - s.paidDai);

/**
 * 순수 함수. event:
 *  {type:'tick', at}            — at까지 도래한 지급 처리
 *  {type:'price', price}        — 지급가 변경(이후 지급부터)
 *  {type:'stop', at}            — 지급 중단(HELIX 소각 재개와 독립)
 *  {type:'claim', at}           — 미청구분 청구
 * @returns {{state, events:Array}}
 */
export function fixedAccrual(state, event) {
  const s = { ...state };
  const events = [];
  if (!s.enabled) return { state: s, events };
  if (event.type === 'price') { s.payoutPriceDai = event.price; events.push({ type: 'FIXED_PRICE', price: event.price }); }
  else if (event.type === 'stop') { s.stopUnix = event.at; }
  else if (event.type === 'claim') {
    if (s.unclaimedLgns > 0n) {
      events.push({ type: 'FIXED_CLAIM', at: event.at, lgns: s.unclaimedLgns });
      s.claimedLgns += s.unclaimedLgns; s.unclaimedLgns = 0n;
    }
  } else if (event.type === 'tick') {
    while (s.nextPayoutAt !== null && s.nextPayoutAt <= event.at) {
      const t = s.nextPayoutAt;
      if (s.stopUnix !== null && t >= s.stopUnix) { if (!s.stopped) events.push({ type: 'FIXED_STOPPED', at: t }); s.stopped = true; s.nextPayoutAt = null; break; }
      const remaining = s.capDai - s.paidDai;
      if (remaining <= 0n) { s.capReached = true; s.nextPayoutAt = null; events.push({ type: 'FIXED_CAP_REACHED', at: t }); break; }
      let payDai = (s.principalRecognizedDai * s.payoutRateWad) / WAD; // wei 미만 버림(정산 단위)
      if (payDai > remaining) payDai = remaining;
      const lgns = (payDai * LGNS_UNIT) / s.payoutPriceDai; // DAI(18)/가격(18) → LGNS 9자리, 버림
      s.paidDai += payDai; s.accruedLgns += lgns; s.unclaimedLgns += lgns;
      events.push({ type: 'FIXED_PAYOUT', at: t, payDai, lgns, price: s.payoutPriceDai });
      s.nextPayoutAt = t + s.periodSeconds;
    }
  }
  return { state: s, events };
}
