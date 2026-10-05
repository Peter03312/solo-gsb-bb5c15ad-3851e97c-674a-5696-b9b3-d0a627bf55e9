import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Placement, Position } from '../src/domain';
import { simulateDischarge, DischargeSimulation } from '../src/discharge';
import { evaluatePort } from '../src/berth';

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });

function placementsOf(m: Record<string, [number, number, number]>): Placement[] {
  return Object.entries(m).map(([boxNo, [bay, row, tier]]) => ({ boxNo, position: { bay, row, tier } }));
}

function itemsOf(m: Record<string, string>) {
  return Object.entries(m).map(([boxNo, dischargePort]) => ({ boxNo, dischargePort }));
}

/** 真实模拟：同列 tier0=BOT(SHA) 被 tier1=TOP(SIN) 压住 */
function blockedSimulation(): DischargeSimulation {
  return simulateDischarge({
    ports: ['SHA', 'SIN'],
    items: itemsOf({ BOT: 'SHA', TOP: 'SIN' }),
    placements: placementsOf({ BOT: [1, 1, 0], TOP: [1, 1, 1] }),
  });
}

/** 真实模拟：各箱独立列顶，逐港卸空 */
function cleanSimulation(): DischargeSimulation {
  return simulateDischarge({
    ports: ['SHA', 'SIN', 'HAM'],
    items: itemsOf({ A: 'SHA', B: 'SHA', C: 'SIN', D: 'HAM' }),
    placements: placementsOf({
      A: [1, 1, 0],
      B: [2, 1, 0],
      C: [3, 1, 0],
      D: [4, 1, 0],
    }),
  });
}

test('未知卸港：known=false 且不可预订', () => {
  const e = evaluatePort(cleanSimulation(), 'XXX');
  assert.equal(e.known, false);
  assert.equal(e.dischargedCount, 0);
  assert.equal(e.blockedCount, 0);
  assert.equal(e.bookable, false);
});

test('有实际卸箱且无受阻：bookable=true，卸箱数为该港 discharged 条数', () => {
  const e = evaluatePort(cleanSimulation(), 'SHA');
  assert.equal(e.known, true);
  assert.equal(e.dischargedCount, 2);
  assert.equal(e.blockedCount, 0);
  assert.equal(e.bookable, true);
});

test('无实卸且有受阻（被后续港箱压住）：bookable=false', () => {
  const e = evaluatePort(blockedSimulation(), 'SHA');
  assert.equal(e.known, true);
  assert.equal(e.dischargedCount, 0);
  assert.equal(e.blockedCount, 1);
  assert.equal(e.bookable, false);
});

test('阻挡港当港卸下：列顶箱实际卸走、无受阻，bookable=true', () => {
  const e = evaluatePort(blockedSimulation(), 'SIN');
  assert.equal(e.dischargedCount, 1);
  assert.equal(e.blockedCount, 0);
  assert.equal(e.bookable, true);
});
