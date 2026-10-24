// 달력·KST·프로토콜 일 경계·마일스톤. DESIGN §7. 임의 '자정' 하드코딩 금지 → 프로토콜 genesis/daySeconds 경계 사용.
export const KST_OFFSET_SECONDS = 9 * 3600;

export function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}
export const isValidDate = (s) => parseDate(s) !== null;
const fmt = (dt) => dt.toISOString().slice(0, 10);
const utc = (s) => { const p = parseDate(s); if (!p) throw new RangeError(`날짜 오류 ${s}`); return Date.UTC(p.y, p.m - 1, p.d); };

export const addDays = (s, n) => fmt(new Date(utc(s) + n * 86400000));
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);

/** 달력 +n개월, 말일 clamp(1/31+1개월 → 2/28 또는 윤년 2/29). */
export function addMonths(s, n) {
  const { y, m, d } = parseDate(s);
  const t = m - 1 + n, ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(ny, nm, Math.min(d, last))));
}

/** 유닉스 초 → KST 날짜 문자열. */
export const kstDate = (unix) => fmt(new Date((unix + KST_OFFSET_SECONDS) * 1000));
/** KST 날짜의 00:00 KST 유닉스 초. */
export const kstMidnightUnix = (s) => utc(s) / 1000 - KST_OFFSET_SECONDS;

/** 시작 KST 날짜 이후 첫 프로토콜 일 경계(정산 시점). */
export function firstBoundary(startDate, genesis, daySeconds) {
  const t = kstMidnightUnix(startDate);
  const k = Math.ceil((t - genesis) / daySeconds);
  return genesis + Math.max(k, 0) * daySeconds;
}

/** horizon 일수. CALENDAR=달력 +N년, FIXED_DAYS=365×N. */
export function horizonDays(startDate, years, mode = 'CALENDAR') {
  return mode === 'FIXED_DAYS' ? (years === 0.5 ? 180 : 365 * years) : daysBetween(startDate, addMonths(startDate, 12 * years));
}

/** 3·6·12개월(+24/36). FIXED_DAYS는 90/180/365(+730/1095). day=시작일부터 경과일. */
export function milestones(startDate, years, mode = 'CALENDAR') {
  const months = [3, 6, 12, ...(years >= 2 ? [24] : []), ...(years >= 3 ? [36] : [])];
  return months.map((mo) => {
    const day = mode === 'FIXED_DAYS' ? { 3: 90, 6: 180, 12: 365, 24: 730, 36: 1095 }[mo] : daysBetween(startDate, addMonths(startDate, mo));
    return { label: mo < 12 ? `${mo}개월` : `${mo / 12}년`, months: mo, day, date: addDays(startDate, day) };
  });
}
