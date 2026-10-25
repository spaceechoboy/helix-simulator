// 동기 커서 SVG 차트. 외부 라이브러리 없음. DESIGN §2 그래프 상세 커서, §7.
// 값은 일별 장부를 그대로 계단선으로 그린다(부드러운 보간 금지). 커서는 가장 가까운 일별 행을 정확히 선택한다.
const NS = 'http://www.w3.org/2000/svg';
const H = 190, PAD = { l: 58, r: 12, t: 14, b: 26 };
const RIGHT_AXIS_PAD = 58;
const MARKER_LANE_STEP = 14, MARKER_LABEL_GAP = 6;

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

/** 0을 포함하는 보기 좋은 눈금. */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (min > 0) min = 0;
  if (max < 0) max = 0;
  if (max === min) max = min + 1;
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e9 ? 0 : v);
  return { lo, hi, ticks };
}

/** 값 배열 전용 y축. 서로 단위가 다른 계열은 각각 별도 scale을 만든다. */
export function axisScale(values, height = H, pad = PAD) {
  let min = 0, max = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const { lo, hi, ticks } = niceTicks(min, max);
  const top = Number.isFinite(pad?.t) ? pad.t : PAD.t;
  const bottom = Number.isFinite(pad?.b) ? pad.b : PAD.b;
  const innerHeight = Math.max(1, height - top - bottom);
  const y = (value) => top + innerHeight - ((value - lo) / (hi - lo)) * innerHeight;
  return { lo, hi, ticks, y };
}

/** 픽셀 x → 가장 가까운 일 index. pad 생략 시 기존 좌우 여백 계약을 유지한다. */
export function indexAt(px, width, n, pad = PAD) {
  const left = Number.isFinite(pad?.l) ? pad.l : PAD.l;
  const right = Number.isFinite(pad?.r) ? pad.r : PAD.r;
  const w = Math.max(1, width - left - right);
  if (n <= 1) return 0;
  return Math.max(0, Math.min(n - 1, Math.round(((px - left) / w) * (n - 1))));
}

// 좁은 화면의 일반 마일스톤을 좌→우 greedy 2-lane으로 배치한다. payback은 별도 상단 행을 쓴다.
const markerLanes = (markers, width, n, pad) => {
  const iw = Math.max(1, width - pad.l - pad.r);
  const x = (day) => pad.l + (n <= 1 ? 0 : ((day - 1) / (n - 1)) * iw);
  const items = markers.map((marker, index) => ({ marker, index }))
    .filter(({ marker }) => marker.kind !== 'payback' && marker.day - 1 >= 0 && marker.day - 1 < n)
    .map(({ marker, index }) => {
      const mx = x(marker.day), half = String(marker.label ?? '').length * 3.2 + 4;
      const anchor = mx - half < pad.l ? 'start' : mx + half > width - pad.r ? 'end' : 'middle';
      const labelX = Math.max(pad.l + 2, Math.min(width - pad.r - 2, mx));
      const labelWidth = half * 2;
      const left = anchor === 'start' ? labelX : anchor === 'end' ? labelX - labelWidth : labelX - half;
      const right = anchor === 'start' ? labelX + labelWidth : anchor === 'end' ? labelX : labelX + half;
      return { index, mx, left, right };
    }).sort((a, b) => a.mx - b.mx);
  const laneEnd = [-Infinity, -Infinity], lanes = new Map();
  for (const item of items) {
    let lane = laneEnd.findIndex((end) => item.left >= end + MARKER_LABEL_GAP);
    if (lane < 0) lane = laneEnd[0] <= laneEnd[1] ? 0 : 1;
    lanes.set(item.index, lane);
    laneEnd[lane] = Math.max(laneEnd[lane], item.right);
  }
  return lanes;
};

/**
 * @param root 컨테이너 요소
 * @param model {n, dates[], markers:[{day,label,kind?:'payback'}], charts:[{id,title,unit,fmt,rightAxis?:{fmt,label},series:[{key,label,cls,type:'step'|'bar',axis?:'right',values:(number|null)[]}]}]}
 * @param hooks {onCursor(i), onPin(i|null), initialPinnedDate?:string} — date restores pin silently across refresh
 * @returns {setCursor(i), pin(i), destroy()}
 */
export function createSyncedCharts(root, model, hooks = {}) {
  root.innerHTML = '';
  const initialPin = hooks.initialPinnedDate == null ? -1 : (model.dates ?? []).indexOf(hooks.initialPinnedDate);
  const state = { i: initialPin >= 0 ? initialPin : Math.max(0, model.n - 1), pinned: initialPin >= 0 ? initialPin : null };
  let announceTimer = null;
  const announce = () => {
    clearTimeout(announceTimer);
    const pending = views.map(v => ({ v, text: v.tooltip.textContent }));
    announceTimer = setTimeout(() => {
      for (const { v, text } of pending) {
        if (v.announcement.textContent !== text) v.announcement.textContent = text;
      }
    }, 300);
  };
  const views = [];
  let ro = null;

  const build = () => {
    views.length = 0;
    root.innerHTML = '';
    // SVG의 고정 최소폭을 두지 않는다. 작은 화면에서는 컨테이너 폭에 맞춰 viewBox도 줄인다.
    const width = root.clientWidth > 0 ? Math.max(1, Math.floor(root.clientWidth)) : 640;
    const markers = model.markers ?? [];
    const hasPayback = markers.some((m) => m.kind === 'payback');
    for (const c of model.charts) {
      const n = model.n;
      const rightSeries = c.series.filter((s) => s.axis === 'right');
      const leftSeries = c.series.filter((s) => s.axis !== 'right');
      const hasRight = rightSeries.length > 0;
      const hasAxisLabels = Boolean(c.unit || (hasRight && c.rightAxis?.label));
      // 회수 표식과 축 단위에 각각 한 줄을 주어 선·하단 마일스톤과 겹치지 않게 한다.
      const basePad = {
        ...PAD,
        r: hasRight ? RIGHT_AXIS_PAD : PAD.r,
        t: PAD.t + (hasPayback ? 20 : 0) + (hasAxisLabels ? 14 : 0),
      };
      const lanes = markerLanes(markers, width, n, basePad);
      const staggered = [...lanes.values()].some((lane) => lane > 0);
      const height = (width < 600 ? 300 : 420) + (staggered ? MARKER_LANE_STEP : 0);
      const pad = { ...basePad, b: PAD.b + (staggered ? MARKER_LANE_STEP : 0) };
      const fig = document.createElement('figure');
      fig.className = 'chart';
      const cap = document.createElement('figcaption');
      cap.innerHTML = `<span class="chart-title">${c.title}</span><span class="legend">${c.series.map((s) => `<span class="key ${s.cls}">${s.label}</span>`).join('')}</span>`;
      fig.appendChild(cap);
      const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, tabindex: '0', role: 'img',
        'aria-label': `${c.title}. 좌우 화살표로 하루, PageUp·PageDown으로 30일, Home·End로 처음과 끝 이동, Enter로 고정, Esc로 해제.` });
      svg.style.touchAction = 'pan-y';
      fig.appendChild(svg);
      const tooltip = document.createElement('div');
      tooltip.className = 'chart-tooltip'; tooltip.hidden = true;
      tooltip.setAttribute('aria-hidden', 'true'); fig.appendChild(tooltip);
      const announcement = document.createElement('div');
      announcement.className = 'chart-announcement';
      announcement.setAttribute('aria-live', 'polite');
      announcement.setAttribute('aria-atomic', 'true');
      Object.assign(announcement.style, { position: 'absolute', width: '1px', height: '1px', padding: '0', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' });
      fig.appendChild(announcement);
      root.appendChild(fig);

      const referenceValue = Number.isFinite(c.referenceValue) ? c.referenceValue : null;
      const leftAxis = axisScale([...leftSeries.flatMap((s) => s.values), ...(referenceValue === null ? [] : [referenceValue])], height, pad);
      const rightAxis = hasRight ? axisScale(rightSeries.flatMap((s) => s.values), height, pad) : null;
      const leftFmt = typeof c.fmt === 'function' ? c.fmt : String;
      const rightFmt = typeof c.rightAxis?.fmt === 'function' ? c.rightAxis.fmt : leftFmt;
      const iw = Math.max(1, width - pad.l - pad.r), ih = Math.max(1, height - pad.t - pad.b);
      const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);

      for (const tick of leftAxis.ticks) {
        el('line', { x1: pad.l, x2: width - pad.r, y1: leftAxis.y(tick), y2: leftAxis.y(tick), class: tick === 0 ? 'axis zero' : 'grid' }, svg);
        const lab = el('text', { x: pad.l - 6, y: leftAxis.y(tick) + 4, class: 'tick tick-left', 'text-anchor': 'end' }, svg);
        lab.textContent = leftFmt(tick);
      }
      if (rightAxis) {
        el('line', { x1: width - pad.r, x2: width - pad.r, y1: pad.t, y2: height - pad.b, class: 'axis axis-right', stroke: '#b8bfcc' }, svg);
        for (const tick of rightAxis.ticks) {
          const py = rightAxis.y(tick);
          el('line', { x1: width - pad.r, x2: width - pad.r + 4, y1: py, y2: py, class: 'axis axis-right', stroke: '#b8bfcc' }, svg);
          const lab = el('text', { x: width - pad.r + 6, y: py + 4, class: 'tick tick-right', 'text-anchor': 'start' }, svg);
          lab.textContent = rightFmt(tick);
        }
      }
      if (hasAxisLabels) {
        const axisLabelY = hasPayback ? 30 : 12;
        if (c.unit) {
          const lab = el('text', { x: 2, y: axisLabelY, class: 'tick axis-label axis-label-left', 'text-anchor': 'start' }, svg);
          lab.textContent = c.unit;
        }
        if (hasRight && c.rightAxis?.label) {
          const lab = el('text', { x: width - 2, y: axisLabelY, class: 'tick axis-label axis-label-right', 'text-anchor': 'end' }, svg);
          lab.textContent = c.rightAxis.label;
        }
      }
      markers.forEach((m, markerIndex) => {
        if (m.day - 1 < 0 || m.day - 1 >= n) return;
        const mx = x(m.day - 1);
        const payback = m.kind === 'payback';
        const cls = payback ? 'marker marker-payback' : 'marker';
        el('line', { x1: mx, x2: mx, y1: pad.t, y2: height - pad.b, class: cls,
          ...(payback ? { style: 'stroke-width:2;opacity:.85' } : {}) }, svg);
        const halfLabel = String(m.label ?? '').length * 3.2 + 4;
        const anchor = mx - halfLabel < pad.l ? 'start' : mx + halfLabel > width - pad.r ? 'end' : 'middle';
        const labelX = Math.max(pad.l + 2, Math.min(width - pad.r - 2, mx));
        const lane = lanes.get(markerIndex) ?? 0;
        const t = el('text', { x: labelX, y: payback ? 14 : height - 8 - lane * MARKER_LANE_STEP,
          class: payback ? 'marker-label marker-label-payback' : 'marker-label', 'text-anchor': anchor,
          ...(payback ? { style: 'font-weight:700;paint-order:stroke;stroke:#fff;stroke-width:3px' } : {}) }, svg);
        t.textContent = m.label;
      });
      if (referenceValue !== null) {
        const py = leftAxis.y(referenceValue);
        el('line', { x1: pad.l, x2: width - pad.r, y1: py, y2: py, class: 'reference-line', stroke: '#53634c', 'stroke-dasharray': '2 5' }, svg);
        const label = el('text', { x: width - pad.r - 4, y: Math.max(pad.t + 12, py - 6), class: 'tick reference-label', 'text-anchor': 'end' }, svg);
        label.textContent = `${c.referenceLabel ?? '총투입'} ${leftFmt(referenceValue)} ${c.unit ?? ''}`;
      }
      const bw = Math.max(1, iw / Math.max(n, 1) * 0.8);
      for (const s of c.series) {
        const scale = s.axis === 'right' && rightAxis ? rightAxis : leftAxis;
        if (s.type === 'bar') {
          const g = el('g', { class: `bar ${s.cls}` }, svg);
          s.values.forEach((v, i) => {
            if (!v) return;
            const y0 = scale.y(0), y1 = scale.y(v);
            el('rect', { x: x(i) - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(0.5, Math.abs(y1 - y0)) }, g);
          });
        } else {
          let d = '', open = false;
          s.values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v)) { open = false; return; }
            const px = x(i), py = scale.y(v);
            d += open ? `H${px.toFixed(1)}V${py.toFixed(1)}` : `M${px.toFixed(1)},${py.toFixed(1)}`;
            open = true;
          });
          if (d) el('path', { d, class: `line ${s.cls}` }, svg);
        }
      }
      const cursor = el('line', { y1: pad.t, y2: height - pad.b, class: 'cursor' }, svg);
      const dots = c.series.map((s) => el('circle', { r: 3.5, class: `dot ${s.cls}` }, svg));
      const hit = el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, class: 'hit' }, svg);
      const scales = c.series.map((s) => s.axis === 'right' && rightAxis ? rightAxis : leftAxis);
      views.push({ c, svg, cursor, dots, x, scales, width, tooltip, announcement });

      const fromEvent = (ev) => {
        const r = svg.getBoundingClientRect();
        const renderedWidth = r.width || width;
        return indexAt(((ev.clientX - r.left) / renderedWidth) * width, width, n, pad);
      };
      let gesture = null;
      const eventTime = (ev) => Number.isFinite(ev.timeStamp) ? ev.timeStamp : Date.now();
      const moveGesture = (ev) => {
        if (gesture && ev.pointerId === gesture.id && Math.hypot(ev.clientX - gesture.x, ev.clientY - gesture.y) >= 8) gesture.moved = true;
      };
      hit.addEventListener('pointermove', (ev) => {
        moveGesture(ev);
        if (ev.pointerType === 'mouse' && state.pinned === null) { tooltip.hidden = false; setCursor(fromEvent(ev), true); }
      });
      hit.addEventListener('pointerleave', () => { gesture = null; if (state.pinned === null) tooltip.hidden = true; });
      hit.addEventListener('pointerdown', (ev) => {
        if (ev.button != null && ev.button !== 0) return;
        gesture = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, at: eventTime(ev), moved: false };
      });
      hit.addEventListener('pointercancel', () => { gesture = null; });
      hit.addEventListener('pointerup', (ev) => {
        moveGesture(ev);
        const tap = gesture; gesture = null;
        if (!tap || tap.id !== ev.pointerId || tap.moved || eventTime(ev) - tap.at > 500) return;
        const i = fromEvent(ev);
        if (state.pinned === i) pin(null, true);
        else { setCursor(i, true); pin(i, true); }
      });
      svg.addEventListener('focus', () => { tooltip.hidden = false; draw(); });
      svg.addEventListener('blur', () => { if (state.pinned === null) tooltip.hidden = true; });
      svg.addEventListener('keydown', (ev) => {
        const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -30, PageDown: 30 }[ev.key];
        let i = state.i;
        if (step !== undefined) i += ev.shiftKey && ev.key.startsWith('Arrow') ? Math.sign(step) * 30 : step;
        else if (ev.key === 'Home') i = 0;
        else if (ev.key === 'End') i = n - 1;
        else if (ev.key === 'Enter' || ev.key === ' ') { pin(state.pinned === state.i ? null : state.i, true); ev.preventDefault(); return; }
        else if (ev.key === 'Escape') { pin(null, true); ev.preventDefault(); return; }
        else return;
        ev.preventDefault();
        tooltip.hidden = false;
        setCursor(Math.max(0, Math.min(n - 1, i)), true);
        if (state.pinned !== null) pin(state.i);
        announce();
      });
    }
    if (state.pinned !== null) for (const v of views) v.tooltip.hidden = false;
    draw();
  };

  const draw = () => {
    for (const v of views) {
      const px = v.x(state.i);
      const number = (n) => Number.isFinite(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
      v.tooltip.textContent = `${model.dates?.[state.i] ?? `${state.i + 1}일`}\n` + v.c.series.map(s => `${s.label}  ${number(s.values[state.i])} ${s.axis === 'right' ? (v.c.rightAxis?.label ?? 'POWER') : (v.c.unit ?? '')}`).join('\n') + (model.dailyDai ? `\n하루 보상 가치  ${number(model.dailyDai[state.i])} DAI` : '') + (state.pinned !== null ? '\n고정됨 · Esc로 해제' : '');
      v.tooltip.style.left = `${Math.max(0, Math.min(v.width - Math.min(280, v.width), px - 130))}px`;
      v.cursor.setAttribute('x1', px); v.cursor.setAttribute('x2', px);
      v.cursor.classList.toggle('pinned', state.pinned !== null);
      v.c.series.forEach((s, k) => {
        const val = s.values[state.i];
        const ok = val !== null && val !== undefined && Number.isFinite(val);
        v.dots[k].setAttribute('cx', px);
        v.dots[k].setAttribute('cy', ok ? v.scales[k].y(val) : -10);
        v.dots[k].style.display = ok ? '' : 'none';
      });
    }
  };

  function setCursor(i, force = false) {
    if (!force && state.pinned !== null) return;
    if (i === state.i && !force) return;
    state.i = Math.max(0, Math.min(Math.max(0, model.n - 1), Number.isFinite(i) ? Math.round(i) : 0)); draw(); hooks.onCursor?.(state.i);
  }
  function pin(i, shouldAnnounce = false) {
    if (i !== null) i = Math.max(0, Math.min(Math.max(0, model.n - 1), Number.isFinite(i) ? Math.round(i) : 0));
    for (const v of views) v.tooltip.hidden = i === null;
    state.pinned = i; if (i !== null) state.i = i; draw(); hooks.onPin?.(i);
    if (shouldAnnounce) announce();
  }

  build();
  if (typeof ResizeObserver !== 'undefined') {
    let last = root.clientWidth;
    ro = new ResizeObserver(() => { if (Math.abs(root.clientWidth - last) > 4) { last = root.clientWidth; build(); } });
    ro.observe(root);
  }
  hooks.onCursor?.(state.i);
  return { setCursor: (i) => setCursor(i, true), pin, destroy: () => { ro?.disconnect(); clearTimeout(announceTimer); }, get index() { return state.i; } };
}
