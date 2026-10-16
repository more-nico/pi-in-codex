import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelPresence, PANEL_LEASE_MS, PANEL_OPENING_MS } from '../src/panel.js';

test('opening one chat suppresses duplicate opens without affecting another chat', () => {
  let now = 0; const panels = new PanelPresence(() => now);
  assert.equal(panels.status('a').shouldOpen, true);
  assert.equal(panels.request('a').state, 'opening');
  assert.equal(panels.status('a').shouldOpen, false);
  assert.equal(panels.status('b').shouldOpen, true);
  now += PANEL_OPENING_MS;
  assert.equal(panels.status('a').shouldOpen, true, 'failed host opens must be retryable');
});

test('polling proves a panel is mounted and a dead connection eventually expires', () => {
  let now = 0; const panels = new PanelPresence(() => now);
  panels.request('a');
  const finish = panels.poll('a', 'panel');
  assert.equal(panels.status('a').state, 'open');
  now += 25_000; finish(false);
  assert.equal(panels.request('a').state, 'open');
  now += PANEL_LEASE_MS - 1;
  assert.equal(panels.status('a').shouldOpen, false);
  now += 1;
  assert.equal(panels.status('a').shouldOpen, true);
});

test('closing one instance preserves another and late cancellation cannot remove a newer poll', () => {
  const panels = new PanelPresence();
  const first = panels.poll('a', 'first'), second = panels.poll('a', 'second');
  first(true);
  assert.equal(panels.status('a').shouldOpen, false);
  second(true);
  assert.equal(panels.status('a').shouldOpen, true);
  const old = panels.poll('a', 'same'), current = panels.poll('a', 'same');
  old(true);
  assert.equal(panels.status('a').state, 'open');
  current(true);
  assert.equal(panels.status('a').shouldOpen, true);
});
