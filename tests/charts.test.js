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
  hit.dispatch('pointerdown', { clientX: 222, pointerType: 'touch' });
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
  hit.dispatch('pointerdown', { clientX: 302, pointerType: 'touch' });
  assert.equal(chart.index, 1096);
  assert.deepEqual(pins, [1096]);
});
