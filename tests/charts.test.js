import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisScale, createSyncedCharts, indexAt } from '../src/charts.js';

class FakeClassList {
  constructor(node) { this.node = node; }
  toggle(name, force) {
    const names = new Set((this.node.attributes.class ?? '').split(/\s+/).filter(Boolean));
    if (force) names.add(name); else names.delete(name);
    this.node.attributes.class = [...names].join(' ');
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.className = '';
    this.clientWidth = 0;
    this.textContent = '';
    this._innerHTML = '';
    this.classList = new FakeClassList(this);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  dispatch(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
  getBoundingClientRect() {
    const viewWidth = Number((this.attributes.viewBox ?? '').split(/\s+/)[2]);
    return { left: 0, width: Number.isFinite(viewWidth) ? viewWidth : this.clientWidth };
  }
  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  get innerHTML() { return this._innerHTML; }
}

const all = (node) => [node, ...node.children.flatMap(all)];
const byClass = (root, name) => all(root).filter((node) => (node.attributes.class ?? '').split(/\s+/).includes(name));

test('axisScale maps DAI and POWER on independent domains', () => {
  const pad = { t: 20, b: 30 };
  const dai = axisScale([0, 50, 100], 190, pad);
  const power = axisScale([0, 500, 1000], 190, pad);

  assert.deepEqual([dai.lo, dai.hi], [0, 100]);
  assert.deepEqual([power.lo, power.hi], [0, 1000]);
  assert.equal(dai.y(50), 90);
  assert.equal(power.y(500), 90);
  assert.notEqual(dai.y(50), power.y(50));
});

test('indexAt keeps the old padding default and accepts chart-specific margins', () => {
  assert.equal(indexAt(58, 600, 365), 0);
  assert.equal(indexAt(588, 600, 365), 364);

  const dualAxisPad = { l: 58, r: 58 };
  assert.equal(indexAt(58, 300, 5, dualAxisPad), 0);
  assert.equal(indexAt(150, 300, 5, dualAxisPad), 2);
  assert.equal(indexAt(242, 300, 5, dualAxisPad), 4);
});

test('dual-axis SVG fits its container and keeps payback separate from milestone labels', (t) => {
  const previousDocument = globalThis.document;
  const previousResizeObserver = globalThis.ResizeObserver;
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
  };
  globalThis.ResizeObserver = undefined;
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.ResizeObserver = previousResizeObserver;
  });

  const root = new FakeElement('div');
  root.clientWidth = 280;
  const pins = [];
  const chart = createSyncedCharts(root, {
    n: 3,
    dates: ['D1', 'D2', 'D3'],
    markers: [
      { day: 2, label: '원금 회수', kind: 'payback' },
      { day: 3, label: '기간 끝' },
    ],
    charts: [{
      id: 'cash-power',
      title: '누적 현금 회수 · 활성 POWER',
      unit: 'DAI',
      fmt: (v) => `D${v}`,
      rightAxis: { label: 'POWER', fmt: (v) => `P${v}` },
      series: [
        { key: 'cash', label: '누적 현금 회수', cls: 's-teal', type: 'step', values: [0, 50, 100] },
        { key: 'power', label: '활성 POWER', cls: 's-navy', type: 'step', axis: 'right', values: [0, 500, 1000] },
      ],
    }],
  }, { onPin: (i) => pins.push(i) });

  const svg = all(root).find((node) => node.tagName === 'svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 280 300');
  assert.equal(svg.getAttribute('width'), '100%');

  const rightLabels = byClass(svg, 'tick-right').map((node) => node.textContent);
  assert.ok(rightLabels.includes('P1000'));
  const rightAxisLines = byClass(svg, 'axis-right').filter((node) => node.tagName === 'line');
  assert.ok(rightAxisLines.length > 1);
  assert.ok(rightAxisLines.every((node) => node.getAttribute('stroke')));
  const dots = byClass(svg, 'dot');
  assert.equal(dots.length, 2);
  assert.equal(dots[0].getAttribute('cy'), dots[1].getAttribute('cy'));
  assert.match(dots[0].getAttribute('class'), /s-teal/);
  assert.match(dots[1].getAttribute('class'), /s-navy/);

  const paybackLine = byClass(svg, 'marker-payback').find((node) => node.tagName === 'line');
  const paybackLabel = byClass(svg, 'marker-label-payback')[0];
  const milestoneLabel = byClass(svg, 'marker-label').find((node) => !byClass(node, 'marker-label-payback').length);
  assert.equal(paybackLine.getAttribute('x1'), '140');
  assert.ok(Number(paybackLabel.getAttribute('y')) < Number(paybackLine.getAttribute('y1')));
  assert.ok(Number(milestoneLabel.getAttribute('y')) > Number(paybackLine.getAttribute('y2')));

  const hit = byClass(svg, 'hit')[0];
  const tooltip = all(root).find(n => n.className === 'chart-tooltip');
  assert.equal(tooltip.hidden, true);
  hit.dispatch('pointermove', { clientX: 140, pointerType: 'mouse' });
  assert.equal(tooltip.hidden, false);
  assert.equal(chart.index, 1);
  assert.match(tooltip.textContent, /DAI/);
  const middleText = tooltip.textContent;
  hit.dispatch('pointermove', { clientX: 222, pointerType: 'mouse' });
  assert.notEqual(tooltip.textContent, middleText);
  hit.dispatch('pointerleave', {});
  assert.equal(tooltip.hidden, true);
  hit.dispatch('pointerdown', { clientX: 222, clientY: 100, pointerType: 'touch', pointerId: 1, timeStamp: 10 });
  assert.equal(tooltip.hidden, true);
  hit.dispatch('pointerup', { clientX: 222, clientY: 100, pointerType: 'touch', pointerId: 1, timeStamp: 50 });
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.textContent, /고정됨/);
  assert.equal(chart.index, 2);
  assert.deepEqual(pins, [2]);

  let prevented = false;
  svg.dispatch('keydown', { key: 'ArrowLeft', shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(chart.index, 1);
  assert.equal(prevented, true);
});

test('narrow 3-year chart staggers close milestone labels and preserves touch/right padding', (t) => {
  const previousDocument = globalThis.document;
  const previousResizeObserver = globalThis.ResizeObserver;
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
  };
  globalThis.ResizeObserver = undefined;
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.ResizeObserver = previousResizeObserver;
  });

  const root = new FakeElement('div');
  root.clientWidth = 360;
  const pins = [];
  const chart = createSyncedCharts(root, {
    n: 1097,
    dates: [],
    markers: [
      { day: 92, label: '3개월' },
      { day: 182, label: '6개월' },
      { day: 365, label: '12개월' },
    ],
    charts: [{
      id: 'cash-power', title: '누적 현금 회수 · 활성 POWER', unit: 'DAI',
      rightAxis: { label: 'POWER' },
      series: [
        { key: 'cash', label: '누적 현금 회수', cls: 's-teal', type: 'step', values: [0] },
        { key: 'power', label: '활성 POWER', cls: 's-navy', type: 'step', axis: 'right', values: [0] },
      ],
    }],
  }, { onPin: (i) => pins.push(i) });

  const svg = all(root).find((node) => node.tagName === 'svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 360 314');
  const labels = byClass(svg, 'marker-label');
  const m3 = labels.find((node) => node.textContent === '3개월');
  const m6 = labels.find((node) => node.textContent === '6개월');
  const markerBottom = Number(byClass(svg, 'marker').find((node) => node.tagName === 'line').getAttribute('y2'));
  assert.equal(Math.abs(Number(m3.getAttribute('y')) - Number(m6.getAttribute('y'))), 14);
  assert.ok(Number(m3.getAttribute('y')) > markerBottom);
  assert.ok(Number(m6.getAttribute('y')) > markerBottom);

  const hit = byClass(svg, 'hit')[0];
  hit.dispatch('pointerdown', { clientX: 302, clientY: 100, pointerType: 'touch', pointerId: 1, timeStamp: 10 });
  hit.dispatch('pointerup', { clientX: 302, clientY: 100, pointerType: 'touch', pointerId: 1, timeStamp: 50 });
  assert.equal(chart.index, 1096);
  assert.deepEqual(pins, [1096]);
});

function fixture(t, hooks = {}, options = {}) {
  const old = globalThis.document;
  globalThis.document = { createElement: tag => new FakeElement(tag), createElementNS: (_ns, tag) => new FakeElement(tag) };
  t.after(() => { globalThis.document = old; });
  const root = new FakeElement('div'); root.clientWidth = options.width ?? 700;
  const n = options.n ?? 61;
  const chart = createSyncedCharts(root, { n, dates: options.dates ?? Array.from({length:n},(_,i)=>`D${i}`), markers: [], charts: [{ title:'현금', unit:'DAI', referenceValue:200, series:[{key:'cash',label:'현금 인출(계산)',cls:'s-teal',type:'step',values:Array.from({length:n},(_,i)=>i)}] }] }, hooks);
  t.after(() => chart.destroy());
  return { root, chart, svg: all(root).find(n=>n.tagName==='svg'), hit:byClass(root,'hit')[0], tooltip:all(root).find(n=>n.className==='chart-tooltip'), announcement:all(root).find(n=>n.className==='chart-announcement') };
}

test('touch scroll, cancel and long press do not pin, a short tap toggles pin', t => {
  const pins=[]; const f=fixture(t,{onPin:i=>pins.push(i)});
  const ev=(x,y,time)=>({clientX:x,clientY:y,timeStamp:time,pointerId:1,pointerType:'touch'});
  f.hit.dispatch('pointerdown',ev(200,100,0)); f.hit.dispatch('pointermove',ev(200,130,20)); f.hit.dispatch('pointerup',ev(200,100,40));
  f.hit.dispatch('pointerdown',ev(200,100,100)); f.hit.dispatch('pointercancel',ev(200,100,110)); f.hit.dispatch('pointerup',ev(200,100,120));
  f.hit.dispatch('pointerdown',ev(200,100,200)); f.hit.dispatch('pointerup',ev(200,100,800));
  assert.deepEqual(pins,[]);
  f.hit.dispatch('pointerdown',ev(200,100,900)); f.hit.dispatch('pointerup',ev(200,100,950));
  f.hit.dispatch('pointerdown',ev(200,100,1000)); f.hit.dispatch('pointerup',ev(200,100,1050));
  assert.equal(pins.length,2); assert.equal(pins[1],null);
});

test('mouse hover remains silent; keyboard announces debounced and external date pins restore', async t => {
  const f=fixture(t,{initialPinnedDate:'D20'});
  assert.equal(f.chart.index,20); assert.match(f.tooltip.textContent,/고정됨/);
  assert.equal(f.tooltip.getAttribute('aria-hidden'),'true');
  assert.equal(f.tooltip.getAttribute('role'),null);
  assert.equal(f.announcement.getAttribute('aria-live'),'polite');
  f.chart.pin(null);
  f.hit.dispatch('pointermove',{clientX:300,pointerType:'mouse'});
  await new Promise(r=>setTimeout(r,320)); assert.equal(f.announcement.textContent,'');
  const key=k=>f.svg.dispatch('keydown',{key:k,preventDefault(){}});
  key('Home'); key('PageDown'); assert.equal(f.chart.index,30);
  await new Promise(r=>setTimeout(r,320)); assert.match(f.announcement.textContent,/D30/);
  key('End'); assert.equal(f.chart.index,60); key('PageUp'); assert.equal(f.chart.index,30);
  key('Enter'); assert.match(f.tooltip.textContent,/고정됨/); key('Escape'); assert.equal(f.tooltip.hidden,true);
  assert.equal(f.svg.getAttribute('height'),'420');
  assert.equal(byClass(f.svg,'reference-line').length,1);
  assert.ok(Number(byClass(f.svg,'reference-line')[0].getAttribute('y1'))>=0);
});


test('hover selects rendered SVG coordinates and clamps tooltip at both horizontal edges', t => {
  for (const width of [200, 360, 700]) {
    const f = fixture(t, {}, { width });
    // A CSS-scaled SVG must map client coordinates back into its own viewBox.
    f.svg.getBoundingClientRect = () => ({ left: 37, width: width / 2 });
    f.hit.dispatch('pointermove', { pointerType:'mouse', clientX:37 + 58 / 2 });
    assert.equal(f.tooltip.hidden,false);
    assert.equal(f.chart.index,0);
    assert.equal(Number.parseFloat(f.tooltip.style.left),0);
    assert.match(f.tooltip.textContent,/^D0\n/);
    f.hit.dispatch('pointermove', { pointerType:'mouse', clientX:37 + (width - 12) / 2 });
    assert.equal(f.chart.index,60);
    assert.match(f.tooltip.textContent,/^D60\n/);
    const left=Number.parseFloat(f.tooltip.style.left);
    assert.ok(left >= 0);
    assert.ok(left + Math.min(280,width) <= width);
    f.hit.dispatch('pointerleave',{});
    assert.equal(f.tooltip.hidden,true);
    f.chart.destroy();
  }
});

test('pinned date restores by date rather than old index after ledger length changes', t => {
  const first=fixture(t,{initialPinnedDate:'D20'});
  assert.equal(first.chart.index,20);
  const shortened=fixture(t,{initialPinnedDate:'D20'},{n:21,dates:Array.from({length:21},(_,i)=>`D${i+10}`)});
  assert.equal(shortened.chart.index,10);
  assert.equal(shortened.tooltip.hidden,false);
  assert.match(shortened.tooltip.textContent,/^D20\n/);
  const outside=fixture(t,{initialPinnedDate:'D20'},{n:10});
  assert.equal(outside.chart.index,9);
  assert.equal(outside.tooltip.hidden,true);
  assert.doesNotMatch(outside.tooltip.textContent,/고정됨/);
});
