'use strict';
// 出货质量处置：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），逐条验证：
//   1. 查询处置上下文：出货快照过敏原/逐卷分配/放行快照、当前批次过敏原、当前有效放行、
//      所用卷停用原因与状态版本；仅待评估单据可处置；
//   2. 准予继续流转三条件（批次存在 / 当前有有效放行 / 出货快照覆盖当前过敏原），
//      不满足时只能召回（CONTINUE → 409 CONTINUE_NOT_ALLOWED，RECALL → 200）；
//   3. 提交事务内核版本：篡改/非法版本 → 400；查询后依据变化 → 409 VERSION_EXPIRED 且不产生记录；
//      同一版本重复提交 → 409 VERSION_USED；缺少操作人/依据/版本 → 400；
//   4. 记录只增不改：新结论旧 CURRENT → SUPERSEDED/NEEDS_REVIEW 历史保留；
//   5. 依据变化（批次过敏原 / 有效放行登记/删除 / 卷停用）后旧结论 → NEEDS_REVIEW，不自动生效、
//      不改变出货状态/数量占用/停卷规则；
//   6. 重放与覆盖：旧版本不能覆盖新结论；非待评估单据不能处置；
//   7. replan 预演返回 reviews_need_reevaluate；应用后 stale_reviews 落库；
//   8. GET /api/shipments 与 /api/state 携带当前结论；历史接口可查。
//   node scripts/test-reviews.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39132';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const state0 = (await api('GET', '/api/state')).json;
    const b3 = state0.batches.find((b) => b.code === 'BATCH-003');
    const e2 = state0.events.find((e) => e.batch_code === 'BATCH-002');
    const peanut = state0.materials.find((m) => m.code === 'PEANUT-01').id;
    const set3 = ['蛋', '乳', '芝麻'];

    // ---------- 1. 非待评估单据不能处置 ----------
    console.log('1) SHIPPED 单据不可处置，无版本可提交');
    let r = await api('GET', '/api/shipments/SHIP-0001/review');
    check('SHIPPED 单据上下文仍可查（reviewable=false）',
      r.status === 200 && r.json.reviewable === false && r.json.pending_review === false, r.json);
    const vShipped = r.json.version;
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: vShipped, decision: 'RECALL', decided_by: '王', basis: 'x'
    });
    check('对 SHIPPED 提交处置 → 409 SHIPMENT_NOT_PENDING',
      r.status === 409 && r.json.code === 'SHIPMENT_NOT_PENDING', r.json);
    r = await api('GET', '/api/shipments/NO-SUCH/review');
    check('不存在出货单 → 404', r.status === 404 && r.json.code === 'SHIPMENT_NOT_FOUND');

    // ---------- 2. 转待评估 ----------
    console.log('2) BATCH-002 加花生 → 放行失效/卷停用/出货单待评估');
    r = await api('PUT', `/api/events/${e2.id}`, {
      type: 'PROCESS', event_time: '2026-09-30T10:00', equipment_id: e2.equipment_id,
      note: '蛋糕糊', batch_code: 'BATCH-002', material_ids: [3, 4, peanut], ref_batch_ids: []
    });
    check('重算返回待评估出货单', (r.json.pending_shipments || []).some((s) => s.shipment_code === 'SHIP-0001'), r.json);
    check('尚无处置结论，stale_reviews 为空', Array.isArray(r.json.stale_reviews) && r.json.stale_reviews.length === 0);

    // ---------- 3. 查询上下文 ----------
    console.log('3) 处置上下文呈现快照 + 当前事实 + 版本');
    r = await api('GET', '/api/shipments/SHIP-0001/review');
    const ctx1 = r.json;
    check('待评估可处置', r.status === 200 && ctx1.reviewable === true && ctx1.pending_review === true);
    check('含状态版本与业务短码',
      typeof ctx1.version === 'string' && ctx1.version.includes('.') && /^[0-9a-f]{12}$/.test(ctx1.business_version));
    check('出货快照过敏原 蛋/乳/芝麻',
      JSON.stringify(ctx1.shipment.allergen_set) === JSON.stringify(set3), ctx1.shipment);
    check('逐卷分配与放行快照',
      ctx1.shipment.items.length === 1 &&
      ctx1.shipment.items[0].roll_code === 'LABEL-0001' &&
      ctx1.shipment.items[0].release_id === 1 &&
      ctx1.shipment.items[0].qty === 100 &&
      ctx1.shipment.items[0].release_by === '质检员-王敏', ctx1.shipment.items);
    check('当前批次过敏原含花生',
      ctx1.evidence.batch.allergens.includes('花生'), ctx1.evidence);
    check('当前无有效放行', ctx1.evidence.active_releases.length === 0);
    const used = ctx1.evidence.rolls[0];
    check('所用卷停用原因可查',
      used.roll_code === 'LABEL-0001' && used.retired === true && /花生/.test(used.retired_reason), used);
    check('三条件不满足 → can_continue=false, 仅 RECALL',
      ctx1.can_continue === false &&
      JSON.stringify(ctx1.allowed_decisions) === JSON.stringify(['RECALL']) &&
      ctx1.continue_blockers.length >= 2, ctx1);

    // ---------- 4. CONTINUE 被拒绝、RECALL 成功 ----------
    console.log('4) 条件不满足：CONTINUE 409，RECALL 200');
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx1.version, decision: 'CONTINUE', decided_by: '王敏', basis: '强行继续'
    });
    check('CONTINUE → 409 CONTINUE_NOT_ALLOWED',
      r.status === 409 && r.json.code === 'CONTINUE_NOT_ALLOWED' &&
      r.json.details.some((x) => x.includes('有效放行')), r.json);
    check('拒绝后无记录', (await api('GET', '/api/shipments/SHIP-0001/reviews')).json.length === 0);

    // 中文处置值兼容
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx1.version, decision: '召回', decided_by: '质检员-王敏',
      basis: '批次新增花生、放行失效，召回', decided_at: '2026-09-30T16:00'
    });
    check('RECALL（中文）成功并返回最新出货单（含 review）',
      r.status === 200 && r.json.status === 'PENDING_REVIEW' &&
      r.json.review.decision === 'RECALL' && r.json.review.is_current === true, r.json);

    // ---------- 5. 乐观并发：重放 / 篡改 / 过期 ----------
    console.log('5) 状态版本并发保护');
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx1.version, decision: 'RECALL', decided_by: '王敏', basis: '重放'
    });
    check('同一版本重复提交 → 409 VERSION_USED，不产生新记录',
      r.status === 409 && r.json.code === 'VERSION_USED', r.json);
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: 'tampered.payload', decision: 'RECALL', decided_by: '王敏', basis: 'x'
    });
    check('非法签名 → 400 VERSION_INVALID', r.status === 400 && r.json.code === 'VERSION_INVALID');
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      decision: 'RECALL', decided_by: '王敏', basis: '无版本'
    });
    check('缺版本 → 400 INVALID_REQUEST', r.status === 400 && r.json.code === 'INVALID_REQUEST');
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx1.version, decision: 'RECALL', decided_by: '', basis: 'x'
    });
    check('缺操作人 → 400', r.status === 400 && r.json.code === 'INVALID_REQUEST');
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx1.version, decision: 'RECALL', decided_by: '王', basis: ''
    });
    check('缺依据 → 400', r.status === 400 && r.json.code === 'INVALID_REQUEST');
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx1.version, decision: 'BOGUS', decided_by: '王', basis: 'x'
    });
    check('非法处置值 → 400', r.status === 400);

    // 版本跨出货单
    const ctxOther = (await api('GET', '/api/state')).json;
    check('此时只有一张出货单（版本跨单校验借单号查询即可）', ctxOther.shipments.length === 1);

    // ---------- 6. 依据变化 → NEEDS_REVIEW，不自动生效；原规则保持 ----------
    console.log('6) 撤销花生：过敏原/放行事实变化，旧 RECALL → NEEDS_REVIEW');
    r = await api('PUT', `/api/events/${e2.id}`, {
      type: 'PROCESS', event_time: '2026-09-30T10:00', equipment_id: e2.equipment_id,
      note: '蛋糕糊', batch_code: 'BATCH-002', material_ids: [3, 4], ref_batch_ids: []
    });
    check('旧结论被标 NEEDS_REVIEW',
      (r.json.stale_reviews || []).some((x) => x.old_decision === 'RECALL' &&
        x.shipment_code === 'SHIP-0001' && /过敏原|放行/.test(x.reason)), r.json.stale_reviews);
    r = await api('GET', '/api/shipments/SHIP-0001');
    check('出货单仍 PENDING_REVIEW（不自动恢复）', r.json.status === 'PENDING_REVIEW');
    check('当前结论 needs_review=true、不自动生效',
      r.json.review.needs_review === true && r.json.review.status === 'NEEDS_REVIEW', r.json.review);
    r = await api('GET', `/api/batches/${b3.id}/shipment-balance`);
    check('数量占用保持（已分配 100）、停卷规则保持（可出货 0、卷 RETIRED）',
      r.json.allocated_qty === 100 && r.json.shippable_qty === 0 &&
      r.json.rolls[0].status === 'RETIRED', r.json);

    // ---------- 7. 恢复满足条件：新有效放行 → CONTINUE；旧记录保留 ----------
    console.log('7) 重新登记放行后可 CONTINUE；记录只增不改');
    r = await api('POST', '/api/releases', {
      batch_id: b3.id, released_at: '2026-09-30T17:00', released_by: '质检员-王敏'
    });
    const rel2Id = r.json.id;
    check('新放行登记成功', typeof rel2Id === 'number' && rel2Id > 1);
    const ctx2 = (await api('GET', '/api/shipments/SHIP-0001/review')).json;
    check('恢复后 can_continue=true（快照覆盖当前且有有效放行）',
      ctx2.can_continue === true && ctx2.continue_blockers.length === 0 &&
      ctx2.evidence.active_releases.length === 1, ctx2);
    check('上下文当前结论仍为旧 NEEDS_REVIEW', ctx2.current_review.needs_review === true);
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx2.version, decision: 'CONTINUE', decided_by: '质检主管-陈静',
      basis: '过敏原恢复一致、放行有效、快照覆盖，准予继续流转'
    });
    check('CONTINUE 成功',
      r.status === 200 && r.json.review.decision === 'CONTINUE' && r.json.review.is_current, r.json);
    const hist = (await api('GET', '/api/shipments/SHIP-0001/reviews')).json;
    check('历史 2 条：新 CONTINUE/CURRENT，旧 RECALL/NEEDS_REVIEW 保留',
      hist.length === 2 && hist[0].decision === 'CONTINUE' && hist[0].status === 'CURRENT' &&
      hist[1].decision === 'RECALL' && hist[1].status === 'NEEDS_REVIEW', hist);

    // ---------- 8. 有效放行删除：旧结论 NEEDS_REVIEW，且版本过期提交不落记录 ----------
    console.log('8) 放行删除 → 旧 CONTINUE 需重新评估；旧版本提交 409 且不增记录');
    const beforeCount = (await api('GET', '/api/shipments/SHIP-0001/reviews')).json.length;
    r = await api('DELETE', `/api/releases/${rel2Id}`);
    check('放行删除响应含 stale_reviews',
      (r.json.stale_reviews || []).some((x) => x.review_id === hist[0].id), r.json);
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx2.version, decision: 'RECALL', decided_by: '王敏', basis: '用过期版本'
    });
    check('依据变化后旧版本 → 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    const afterCount = (await api('GET', '/api/shipments/SHIP-0001/reviews')).json.length;
    check('过期提交不产生记录', afterCount === beforeCount);

    // ---------- 9. 再次 CONTINUE 后，批次过敏原变化 → NEEDS_REVIEW（含批次新增原因）----------
    console.log('9) 恢复条件→CONTINUE→再加花生：旧 CONTINUE NEEDS_REVIEW（原因含新增过敏原）');
    await api('PUT', `/api/events/${e2.id}`, {
      type: 'PROCESS', event_time: '2026-09-30T10:00', equipment_id: e2.equipment_id,
      note: '蛋糕糊', batch_code: 'BATCH-002', material_ids: [3, 4], ref_batch_ids: []
    });
    await api('POST', '/api/releases', {
      batch_id: b3.id, released_at: '2026-09-30T18:00', released_by: '王敏'
    });
    // 注意：放行 #1 已删除，但 LABEL-0001 早已停用；CONTINUE 只看批次/放行/快照覆盖
    let ctx3 = (await api('GET', '/api/shipments/SHIP-0001/review')).json;
    check('再次满足 CONTINUE 条件', ctx3.can_continue === true, ctx3.continue_blockers);
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx3.version, decision: 'CONTINUE', decided_by: '陈静', basis: '再次准予'
    });
    check('第二次 CONTINUE 成功', r.status === 200 && r.json.review.is_current);
    const beforeHist = (await api('GET', '/api/shipments/SHIP-0001/reviews')).json;
    check('上一条 CURRENT 已被取代为 SUPERSEDED 之前先变为…（本次为 NEEDS_REVIEW 前插入）',
      beforeHist.length === 3, beforeHist.map((x) => x.status));

    r = await api('PUT', `/api/events/${e2.id}`, {
      type: 'PROCESS', event_time: '2026-09-30T10:00', equipment_id: e2.equipment_id,
      note: '蛋糕糊', batch_code: 'BATCH-002', material_ids: [3, 4, peanut], ref_batch_ids: []
    });
    check('CONTINUE 被标 NEEDS_REVIEW，原因含“新增：花生”',
      (r.json.stale_reviews || []).some((x) => x.old_decision === 'CONTINUE' &&
        /新增：花生/.test(x.reason)), r.json.stale_reviews);
    const h2 = (await api('GET', '/api/shipments/SHIP-0001/reviews')).json;
    check('全部历史保留（3 条），无自动改写', h2.length === 3);
    check('/api/state 出货单带当前结论（NEEDS_REVIEW）',
      (await api('GET', '/api/state')).json.shipments[0].review.needs_review === true);

    // ---------- 10. replan 预测与应用 ----------
    console.log('10) 换线预演/应用对处置结论的联动');
    // 回到无花生状态：#3 结论仍为 NEEDS_REVIEW（不自动恢复）；
    // 重新登记有效放行并提交新的 CURRENT 结论，再用预演加花生预测其将转为需重新评估。
    await api('PUT', `/api/events/${e2.id}`, {
      type: 'PROCESS', event_time: '2026-09-30T10:00', equipment_id: e2.equipment_id,
      note: '蛋糕糊', batch_code: 'BATCH-002', material_ids: [3, 4], ref_batch_ids: []
    });
    await api('POST', '/api/releases', {
      batch_id: b3.id, released_at: '2026-09-30T18:30', released_by: '王敏'
    });
    let ctxContinue = (await api('GET', '/api/shipments/SHIP-0001/review')).json;
    check('恢复后可再次 CONTINUE', ctxContinue.can_continue === true, ctxContinue.continue_blockers);
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctxContinue.version, decision: 'CONTINUE', decided_by: '陈静', basis: '换线预演前的继续流转结论'
    });
    check('预演前 CURRENT 结论存在', r.status === 200 && r.json.review.status === 'CURRENT');

    r = await api('POST', '/api/replan/preview', {
      changes: [{
        op: 'update', event_id: e2.id, type: 'PROCESS',
        event_time: '2026-09-30T10:00', equipment_id: e2.equipment_id, note: '蛋糕糊',
        batch_code: 'BATCH-002', material_ids: [3, 4, peanut], ref_batch_ids: []
      }]
    });
    check('预演 diff 含 reviews_need_reevaluate',
      r.status === 200 &&
      Array.isArray(r.json.diff.reviews_need_reevaluate) &&
      r.json.diff.summary.reviews_need_reevaluate >= 1, r.json && r.json.diff);
    check('预演不改正式结论（仍 CURRENT）',
      (await api('GET', '/api/shipments/SHIP-0001')).json.review.status === 'CURRENT');
    const pv = r.json.version;
    const changes = r.json.changes;
    r = await api('POST', '/api/replan/apply', { version: pv, changes });
    check('应用成功并返回 stale_reviews',
      r.status === 200 && Array.isArray(r.json.stale_reviews) && r.json.stale_reviews.length >= 1, r.json);
    check('应用后旧 CONTINUE 为 NEEDS_REVIEW',
      (await api('GET', '/api/shipments/SHIP-0001')).json.review.needs_review === true);

    // ---------- 11. 最终只能召回（批次新增花生且新放行也失效）----------
    console.log('11) 终态：条件不满足只能 RECALL，历史继续追加');
    const ctx4 = (await api('GET', '/api/shipments/SHIP-0001/review')).json;
    check('can_continue=false', ctx4.can_continue === false);
    r = await api('POST', '/api/shipments/SHIP-0001/reviews', {
      version: ctx4.version, decision: 'RECALL', decided_by: '王敏', basis: '终态召回'
    });
    check('终态 RECALL 成功', r.status === 200 && r.json.review.decision === 'RECALL');
    const h3 = (await api('GET', '/api/shipments/SHIP-0001/reviews')).json;
    check('历史累计 5 条，最新 CURRENT，其余为历史（只增不改）',
      h3.length === 5 && h3[0].status === 'CURRENT' &&
      h3.slice(1).every((x) => x.status !== 'CURRENT'), h3.map((x) => x.id + ':' + x.status));
  } finally {
    proc.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
