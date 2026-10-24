// BigInt 고정소수점 도우미. 내부 표준 단위 = 18자리(WAD). 화면에서만 반올림한다.
export const WAD_DECIMALS = 18;
export const WAD = 10n ** 18n;
export const BPS = 10000n;

// "1234.5678" 또는 정수/BigInt → 지정 자리수 정수(BigInt). 자리수 초과분은 버림.
export function parseUnits(value, decimals = WAD_DECIMALS) {
  if (value === null || value === undefined) throw new TypeError('parseUnits: null/undefined는 0으로 바꾸지 않습니다');
  if (typeof value === 'bigint') return value * 10n ** BigInt(decimals);
  const s = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new TypeError(`parseUnits: 숫자 형식 아님 "${s}"`);
  const neg = s.startsWith('-');
  const [ip, fp = ''] = (neg ? s.slice(1) : s).split('.');
  const frac = (fp + '0'.repeat(decimals)).slice(0, decimals);
  const v = BigInt(ip) * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return neg ? -v : v;
}

export function formatUnits(v, decimals = WAD_DECIMALS) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const ip = a / base;
  let fp = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + ip.toString() + (fp ? '.' + fp : '');
}

// 자리수 변환(예: LGNS 9자리 → WAD 18자리). 축소 시 버림.
export function rescale(v, fromDec, toDec) {
  if (toDec >= fromDec) return v * 10n ** BigInt(toDec - fromDec);
  return v / 10n ** BigInt(fromDec - toDec);
}

export const wad = (x) => parseUnits(x, WAD_DECIMALS);
export const wmul = (a, b) => (a * b) / WAD;
export function wdiv(a, b) {
  if (b === 0n) throw new RangeError('wdiv: 0으로 나눔');
  return (a * WAD) / b;
}
export const bpsOf = (a, bps) => (a * BigInt(bps)) / BPS;
export const min = (a, b) => (a < b ? a : b);
export const max = (a, b) => (a > b ? a : b);

// 표시 전용. 계산에 다시 쓰지 않는다.
export function toDisplayNumber(v, decimals = WAD_DECIMALS) {
  return Number(formatUnits(v, decimals));
}
