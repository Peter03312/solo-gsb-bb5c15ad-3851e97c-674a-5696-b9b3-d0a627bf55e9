/* eslint-disable no-console */
// 靠泊窗口预订 端到端验证：embedded-postgres + 真实 Express HTTP
// 运行: npm run build && node test/e2e-berth.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30198;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body, expectedStatus) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus} 实际 ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, body: json };
}

/** 造一个航次 + 布局 + 签发 rev1 清单，并按给定港序/每箱卸港做卸货审查，返回审查 */
async function prepareVoyage(voyageNo, itemsByPort, ports) {
  // 通用布局：每个箱单独一列（bay 递增），全部在 tier0，互不叠压
  const boxes = Object.keys(itemsByPort).map((boxNo, i) => ({
    boxNo,
    weight: '500',
    category: '1',
    bay: i + 1,
  }));
  const n = boxes.length;
  const { body: voyage } = await http('POST', `${BASE}/voyages`, {
    voyageNo,
    bays: n, rows: 1, tiers: 1,
    defaultColumnWeightLimit: '10000',
    boxes: boxes.map((b) => ({ boxNo: b.boxNo, weight: '500', category: '1' })),
  }, 201);
  const vid = voyage.id;
  await http('POST', `${BASE}/voyages/${vid}/moves`, {
    baseRevision: 0,
    moves: boxes.map((b) => ({ boxNo: b.boxNo, position: { bay: b.bay, row: 1, tier: 0 } })),
  }, 200);
  await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 1 }, 201);
  const items = Object.entries(itemsByPort).map(([boxNo, dischargePort]) => ({ boxNo, dischargePort }));
  const review = await http(
    'POST', `${BASE}/voyages/${vid}/manifests/1/discharge-reviews`,
    { ports, items }, 201,
  );
  return { vid, reviewId: review.body.reviewId, ports };
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-berth'),
    user: 'stowage',
    password: 'stowage',
    port: 54398,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54398/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 准备：审查 A（SHA 全部可卸）与审查 B（SHA 有受阻箱）----
    // 航次1：4 箱各占一列，SHA/SIN/HAM 均当港卸空，无受阻
    const A = await prepareVoyage(
      'V-BERTH-001',
      { 'BX-1': 'SHA', 'BX-2': 'SHA', 'BX-3': 'SIN', 'BX-4': 'HAM' },
      ['SHA', 'SIN', 'HAM'],
    );
    // 航次2：两箱同列叠压，BX-TOP(SIN) 在 tier1 压住 BX-BOT(SHA) tier0
    // => SHA 实际卸 0、受阻 1（不可受理）；SIN 卸 1、无受阻（可受理）
    const { body: v2 } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-BERTH-002',
      bays: 1, rows: 1, tiers: 2,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'BX-TOP', weight: '500', category: '1' },
        { boxNo: 'BX-BOT', weight: '500', category: '1' },
      ],
    }, 201);
    await http('POST', `${BASE}/voyages/${v2.id}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'BX-BOT', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'BX-TOP', position: { bay: 1, row: 1, tier: 1 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${v2.id}/manifests`, { expectedRevision: 1 }, 201);
    const reviewB = await http('POST', `${BASE}/voyages/${v2.id}/manifests/1/discharge-reviews`, {
      ports: ['SHA', 'SIN'],
      items: [
        { boxNo: 'BX-BOT', dischargePort: 'SHA' },
        { boxNo: 'BX-TOP', dischargePort: 'SIN' },
      ],
    }, 201);
    const reviewBId = reviewB.body.reviewId;

    // 航次3（不同航次/审查）：SHA 同样可卸，用于验证“即使来自不同航次”同港同泊位不得重叠
    const C = await prepareVoyage(
      'V-BERTH-003',
      { 'CY-1': 'SHA', 'CY-2': 'SIN' },
      ['SHA', 'SIN'],
    );

    const bookUrl = (rid) => `${BASE}/discharge-reviews/${rid}/berth-bookings`;

    // ---- 1. 正常预订：带时区时刻、冻结清单修订号与该港卸箱数 ----
    const t1 = '2026-10-10T08:00:00Z';
    const t2 = '2026-10-10T12:00:00Z';
    const b1 = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SHA', berth: 'B-01',
      startAt: t1, endAt: t2, submissionNo: 'SUB-1',
    }, 201);
    check('首次预订 201 replay=false', b1.body.replay === false && !!b1.body.bookingId);
    check('status=active', b1.body.status === 'active' && b1.body.active === true);
    check('冻结清单修订号 = 1', b1.body.manifestRevision === 1 && b1.body.frozenManifestRevision === 1);
    check('冻结该港实际卸箱数 = 2（SHA 卸 BX-1/BX-2）', b1.body.dischargedBoxCount === 2);
    check('回显卸港/泊位/提交号', b1.body.dischargePort === 'SHA' && b1.body.berth === 'B-01' && b1.body.submissionNo === 'SUB-1');
    check('UTC 时刻归一化返回（带毫秒）', b1.body.startAt === '2026-10-10T08:00:00.000Z' && b1.body.endAt === '2026-10-10T12:00:00.000Z');

    // ---- 2. 同提交号同内容重试 -> 200 replay:true，返回原预订当前状态 ----
    const retry = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SHA', berth: 'B-01',
      startAt: t1, endAt: t2, submissionNo: 'SUB-1',
    }, 200);
    check('同号同内容 replay 同一 bookingId',
      retry.body.replay === true && retry.body.bookingId === b1.body.bookingId);

    // ---- 3. 同提交号改内容 -> 409 submission_no_conflict ----
    const conflictSub = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SIN', berth: 'B-01',
      startAt: t1, endAt: t2, submissionNo: 'SUB-1',
    });
    check('同号改内容 409 submission_no_conflict',
      conflictSub.status === 409 && conflictSub.body.error.code === 'submission_no_conflict');

    // ---- 4. 同一审查同一卸港至多一个有效预订（换泊位/换提交号仍拒）----
    const samePort = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SHA', berth: 'B-99',
      startAt: '2026-11-01T00:00:00Z', endAt: '2026-11-01T04:00:00Z', submissionNo: 'SUB-2',
    });
    check('同审查同港第二个有效预订 409 active_booking_exists',
      samePort.status === 409 && samePort.body.error.code === 'active_booking_exists');

    // 但同审查的【另一卸港】可预订（不同泊位/时段）
    const sinBooking = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SIN', berth: 'B-02',
      startAt: '2026-10-11T08:00:00Z', endAt: '2026-10-11T10:00:00Z', submissionNo: 'SUB-3',
    }, 201);
    check('同审查另一卸港可预订（SIN，卸箱数 1）',
      sinBooking.body.dischargedBoxCount === 1);

    // ---- 5. 时刻非法：起点 >= 终点 ----
    const badRange = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'HAM', berth: 'B-03',
      startAt: '2026-10-12T10:00:00Z', endAt: '2026-10-12T10:00:00Z', submissionNo: 'SUB-4',
    });
    check('起点=终点 409 invalid_time_range',
      badRange.status === 409 && badRange.body.error.code === 'invalid_time_range');
    const inverted = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'HAM', berth: 'B-03',
      startAt: '2026-10-12T12:00:00Z', endAt: '2026-10-12T08:00:00Z', submissionNo: 'SUB-4',
    });
    check('起点晚于终点 409 invalid_time_range',
      inverted.status === 409 && inverted.body.error.code === 'invalid_time_range');

    // 裸时间（无时区）-> 400 invalid_request_body
    const noTz = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'HAM', berth: 'B-03',
      startAt: '2026-10-12T08:00:00', endAt: '2026-10-12T10:00:00', submissionNo: 'SUB-4',
    });
    check('无时区时刻 400 invalid_request_body',
      noTz.status === 400 && noTz.body.error.code === 'invalid_request_body');

    // 不同时区写法但同一绝对时刻 -> 与 SUB-1 同内容重放（+08:00 16:00 == Z 08:00）
    const tzRetry = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SHA', berth: 'B-01',
      startAt: '2026-10-10T16:00:00+08:00', endAt: '2026-10-10T20:00:00+08:00', submissionNo: 'SUB-1',
    }, 200);
    check('不同时区写法、同一绝对时刻视为同内容并归一化为 UTC',
      tzRetry.body.replay === true && tzRetry.body.bookingId === b1.body.bookingId &&
      tzRetry.body.startAt === '2026-10-10T08:00:00.000Z');

    // ---- 6. 未知审查 / 未知卸港 / 不可卸港 ----
    const otherId = '00000000-0000-0000-0000-000000000000';
    const noReview = await http('POST', bookUrl(otherId), {
      dischargePort: 'SHA', berth: 'B-01',
      startAt: t1, endAt: t2, submissionNo: 'SUB-X',
    });
    check('未知审查 404 discharge_review_not_found',
      noReview.status === 404 && noReview.body.error.code === 'discharge_review_not_found');

    const unknownPort = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'XXX', berth: 'B-01',
      startAt: '2026-12-01T00:00:00Z', endAt: '2026-12-01T02:00:00Z', submissionNo: 'SUB-5',
    });
    check('未知卸港 404 unknown_discharge_port',
      unknownPort.status === 404 && unknownPort.body.error.code === 'unknown_discharge_port');

    // 审查 B 的 SHA：被 SIN 箱压住，实际卸 0、受阻 1 -> 422
    const notDischargeable = await http('POST', bookUrl(reviewBId), {
      dischargePort: 'SHA', berth: 'B-01',
      startAt: '2026-12-01T00:00:00Z', endAt: '2026-12-01T02:00:00Z', submissionNo: 'SUB-6',
    });
    check('有受阻箱/无实卸 422 port_not_dischargeable',
      notDischargeable.status === 422 &&
      notDischargeable.body.error.code === 'port_not_dischargeable' &&
      notDischargeable.body.error.details.dischargedBoxCount === 0 &&
      notDischargeable.body.error.details.blockedBoxCount === 1);

    // 审查 B 的 SIN：列顶可卸、卸 1、无受阻 -> 可预订
    const sinB = await http('POST', bookUrl(reviewBId), {
      dischargePort: 'SIN', berth: 'B-01',
      startAt: '2026-12-02T00:00:00Z', endAt: '2026-12-02T02:00:00Z', submissionNo: 'SUB-7',
    }, 201);
    check('审查B 的 SIN 可预订（卸箱数 1）', sinB.body.dischargedBoxCount === 1);

    // ---- 7. 窗口重叠：同港同泊位（即使来自不同航次/审查）不得重叠；首尾相接可用 ----
    // 准备两个全新的可卸审查 E/F（各有 SHA、SIN 可卸，且尚无任何有效预订）
    const E = await prepareVoyage(
      'V-BERTH-105',
      { 'E-1': 'SHA', 'E-2': 'SIN' },
      ['SHA', 'SIN'],
    );
    const F = await prepareVoyage(
      'V-BERTH-106',
      { 'F-1': 'SHA', 'F-2': 'SIN' },
      ['SHA', 'SIN'],
    );

    // 占位窗口 X：审查 E，SIN/B-WIN 10-10 08:00-12:00
    const winX = await http('POST', bookUrl(E.reviewId), {
      dischargePort: 'SIN', berth: 'B-WIN',
      startAt: '2026-10-10T08:00:00Z', endAt: '2026-10-10T12:00:00Z', submissionNo: 'WIN-1',
    }, 201);
    check('窗口 X（审查E SIN/B-WIN 08-12）创建', winX.status === 201);

    // 不同审查 F（另一航次）同港 SIN、同泊位 B-WIN、时间段重叠 -> 409 berth_window_overlap
    const realOverlap = await http('POST', bookUrl(F.reviewId), {
      dischargePort: 'SIN', berth: 'B-WIN',
      startAt: '2026-10-10T10:00:00Z', endAt: '2026-10-10T11:00:00Z', submissionNo: 'WIN-2',
    });
    check('跨审查（不同航次）同 SIN 同泊位重叠 -> 409 berth_window_overlap',
      realOverlap.status === 409 && realOverlap.body.error.code === 'berth_window_overlap');

    // 首尾相接：起点 = X 终点 12:00 -> 允许
    const abut = await http('POST', bookUrl(F.reviewId), {
      dischargePort: 'SIN', berth: 'B-WIN',
      startAt: '2026-10-10T12:00:00Z', endAt: '2026-10-10T14:00:00Z', submissionNo: 'WIN-3',
    }, 201);
    check('首尾相接（12:00 = X 终点）可用', abut.status === 201);

    // 同港同时段、不同泊位 -> 允许
    const otherBerth = await http('POST', bookUrl(E.reviewId), {
      dischargePort: 'SHA', berth: 'B-WIN2',
      startAt: '2026-10-10T09:00:00Z', endAt: '2026-10-10T11:00:00Z', submissionNo: 'WIN-4',
    }, 201);
    check('同港（SHA）同时段不同泊位允许（SHA/B-WIN2）', otherBerth.status === 201);

    // ---- 8. 取消：保留记录、释放占用；重复取消返回已取消 ----
    const cancel1 = await http('POST', `${BASE}/berth-bookings/${b1.body.bookingId}/cancel`, undefined, 200);
    check('首次取消 200 replay=false 且 status=cancelled',
      cancel1.body.replay === false && cancel1.body.status === 'cancelled' &&
      !!cancel1.body.cancelledAt);
    const cancelAgain = await http('POST', `${BASE}/berth-bookings/${b1.body.bookingId}/cancel`, undefined, 200);
    check('重复取消 200 replay=true 仍为 cancelled',
      cancelAgain.body.replay === true && cancelAgain.body.status === 'cancelled');
    const unknownCancel = await http('POST', `${BASE}/berth-bookings/${otherId}/cancel`, undefined);
    check('取消未知预订 404 berth_booking_not_found',
      unknownCancel.status === 404 && unknownCancel.body.error.code === 'berth_booking_not_found');

    // 取消后占用释放：同港同泊位重叠时段可用（同审查同港亦可重新预订）
    const afterCancel = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SHA', berth: 'B-01',
      startAt: '2026-10-10T09:00:00Z', endAt: '2026-10-10T11:00:00Z', submissionNo: 'SUB-12',
    }, 201);
    check('取消后重叠时段可重新预订（须新提交号 SUB-12）', afterCancel.status === 201);

    // 重新预订不得复用旧提交号（SUB-1 已存在）-> 即使内容不同也 409
    const reuseOldSub = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SHA', berth: 'B-01',
      startAt: '2026-10-10T09:00:00Z', endAt: '2026-10-10T11:00:00Z', submissionNo: 'SUB-1',
    });
    check('复用旧提交号 SUB-1（内容已变）-> 409',
      reuseOldSub.status === 409 && reuseOldSub.body.error.code === 'submission_no_conflict');

    // 取消后同号同内容重试仍返回【原预订当前状态】(SUB-1 已取消)
    const replayCancelled = await http('POST', bookUrl(A.reviewId), {
      dischargePort: 'SHA', berth: 'B-01', startAt: t1, endAt: t2, submissionNo: 'SUB-1',
    }, 200);
    check('已取消预订同号同内容重试 -> replay 原预订（cancelled）',
      replayCancelled.body.replay === true &&
      replayCancelled.body.bookingId === b1.body.bookingId &&
      replayCancelled.body.status === 'cancelled');

    // ---- 9. 查询：按审查列表 + 单条 GET ----
    const listA = await http('GET', bookUrl(A.reviewId), undefined, 200);
    // A 上：SUB-1(SHA cancelled)、SUB-3(SIN active)、SUB-12(SHA active)
    const activeCount = listA.body.bookings.filter((x) => x.status === 'active').length;
    check('按审查列出 3 条预订（含 1 条已取消）',
      listA.body.bookings.length === 3 && activeCount === 2,
      JSON.stringify(listA.body.bookings.map((b) => [b.submissionNo, b.status])));
    check('列表中保留已取消记录',
      listA.body.bookings.some((x) => x.status === 'cancelled' && x.bookingId === b1.body.bookingId));
    const listUnknown = await http('GET', bookUrl(otherId), undefined);
    check('未知审查列表 404', listUnknown.status === 404);
    const one = await http('GET', `${BASE}/berth-bookings/${b1.body.bookingId}`, undefined, 200);
    check('GET 单条返回取消状态与冻结字段',
      one.body.status === 'cancelled' && one.body.dischargedBoxCount === 2 &&
      one.body.manifestRevision === 1);
    const noBooking = await http('GET', `${BASE}/berth-bookings/${otherId}`, undefined);
    check('GET 未知预订 404', noBooking.status === 404 && noBooking.body.error.code === 'berth_booking_not_found');
    const badIdFmt = await http('GET', `${BASE}/berth-bookings/not-a-uuid`, undefined);
    check('非法 UUID 400 invalid_berth_booking_id',
      badIdFmt.status === 400 && badIdFmt.body.error.code === 'invalid_berth_booking_id');

    // ---- 10. 冻结不回写：航次调整并签发新清单后，旧预订快照不变 ----
    // 航次1 有 4 个独立 bay，交换 BX-1/BX-2 的 bay 产生 rev2（箱仍全配位），再签发新清单
    await http('POST', `${BASE}/voyages/${A.vid}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'BX-1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'BX-2', position: { bay: 1, row: 1, tier: 0 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${A.vid}/manifests`, { expectedRevision: 2 }, 201);
    const frozenOne = await http('GET', `${BASE}/berth-bookings/${one.body.bookingId}`, undefined, 200);
    check('新清单后旧预订仍冻结 rev=1、卸箱数 2（不回写）',
      frozenOne.body.manifestRevision === 1 && frozenOne.body.dischargedBoxCount === 2);

    // ---- 11. 并发竞争：同港同泊位重叠窗口同时提交，只成功一方 ----
    // 准备两个尚无任何预订的可卸审查 G/H（SIN 均可用）
    const G = await prepareVoyage('V-BERTH-107', { 'G-1': 'SIN' }, ['SIN']);
    const H = await prepareVoyage('V-BERTH-108', { 'H-1': 'SIN' }, ['SIN']);
    const raceBody = (sub) => ({
      dischargePort: 'SIN', berth: 'B-RACE',
      startAt: '2027-01-01T00:00:00Z', endAt: '2027-01-01T04:00:00Z', submissionNo: sub,
    });
    const results = await Promise.all([
      http('POST', bookUrl(G.reviewId), raceBody('RACE-1')),
      http('POST', bookUrl(H.reviewId), raceBody('RACE-2')),
    ]);
    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.body && r.body.error && r.body.error.code === 'berth_window_overlap');
    check('并发重叠：恰一方 201、另一方 berth_window_overlap',
      created.length === 1 && conflicts.length === 1,
      JSON.stringify(results.map((r) => [r.status, r.body && r.body.error && r.body.error.code])));

    // 同提交号并发（同审查同内容）：再造全新审查 I
    const I = await prepareVoyage('V-BERTH-109', { 'I-1': 'SHA' }, ['SHA']);
    const sameRaceBody = {
      dischargePort: 'SHA', berth: 'B-RACE2',
      startAt: '2027-02-01T00:00:00Z', endAt: '2027-02-01T02:00:00Z', submissionNo: 'RACE-SAME',
    };
    const sameSub = await Promise.all([
      http('POST', bookUrl(I.reviewId), sameRaceBody),
      http('POST', bookUrl(I.reviewId), sameRaceBody),
    ]);
    const ids = new Set(sameSub.map((r) => r.body.bookingId));
    check('同提交号并发同内容：两请求返回同一 bookingId（一条记录）',
      sameSub.every((r) => r.status === 200 || r.status === 201) && ids.size === 1);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await pg.stop();
  }
}

main();
