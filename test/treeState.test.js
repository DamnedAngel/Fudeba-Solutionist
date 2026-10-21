'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TreeState } = require('../src/treeState');

const memento = () => { const m = new Map(); return { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); } }; };

test('without a saved state the defaults apply', () => {
  const t = new TreeState(memento());
  t.load('a.sln');
  assert.strictEqual(t.isExpanded('x', true), true);
  assert.strictEqual(t.isExpanded('x', false), false);
});

test('expanded nodes and the selection come back, per solution', async () => {
  const m = memento();
  const t = new TreeState(m);
  t.load('a.sln');
  t.expand('prj:1'); t.expand('flt:1:src'); t.collapse('prj:1'); t.collapse('sln:a'); t.select('fil:1:main.c');
  await t.flush();
  const u = new TreeState(m);
  u.load('a.sln');
  assert.strictEqual(u.isExpanded('flt:1:src', false), true);
  assert.strictEqual(u.isExpanded('prj:1', true), false, 'a collapsed default-expanded node stays collapsed');
  assert.strictEqual(u.isExpanded('sln:a', true), false, 'the default-open solution row stays collapsed');
  assert.strictEqual(u.isExpanded('other', true), true, 'an untouched node keeps its default');
  assert.strictEqual(u.selected, 'fil:1:main.c');
  u.load('b.sln');
  assert.strictEqual(u.isExpanded('flt:1:src', false), false, 'another solution has its own state');
});
