'use strict';
// 出货质量处置：对已转“待评估”（PENDING_REVIEW）的出货单按整单登记处置结论。
//
//   处置二选一：
//     CONTINUE 准予继续流转 —— 仅当①批次仍存在、②当前存在该批次有效放行、
//                             ③出货快照过敏原集合覆盖当前批次过敏原集合（当前 ⊆ 快照）；
//     RECALL   召回         —— 条件不满足时只能召回。
//
// 乐观并发（状态版本）：
//   查询（GET 处置上下文）时计算该单“处置依据指纹”并签发 HMAC 版本令牌（30 分钟有效，
//   进程密钥，重启即作废）；提交必须携带该版本。事务内重新读取最新依据并核对：
//     版本签名/格式非法、过期 → 400/409，拒绝且不产生记录；
//     依据指纹已变化（批次过敏原、有效放行、所用卷停用信息变化，或已有他人新结论）
//                            → 409 VERSION_EXPIRED，拒绝且不产生记录；
//     同一版本令牌重复提交   → 409 VERSION_USED，拒绝（重复用旧版本不得覆盖新结论）。
//
// 记录只增不改（append-only）：
//   新结论插入后，原 CURRENT 结论置为 SUPERSEDED（保留留痕），任何既有记录均不改写内容。
//
// 需重新评估（不自动生效）：
//   此后批次过敏原、有效放行或所用卷停用信息变化时，由 syncStaleReviews 在重算/放行变更
//   事务中把该单仍为 CURRENT 的旧结论（含 CONTINUE 与 RECALL）置为 NEEDS_REVIEW 并记录原因；
//   原出货状态、数量占用与停卷规则保持不变；旧结论不自动恢复，需重新查询后提交新结论。

const crypto = require('crypto');

const REVIEW_TTL_MS = 30 * 60 * 1000; // 查询版本有效期 30 分钟
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 进程级随机密钥：重启后旧版本令牌自然失效。
const SIGN_SECRET = crypto.randomBytes(32);

class ReviewError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
    this.details = details || [];
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', SIGN_SECRET).update(payloadB64).digest());
}

// ---------- 依据（evidence） ----------
// 处置依据只包含会影响“能否准予继续流转”与“所用卷停用”的当前事实：
//   - 批次是否存在、当前批次过敏原集合
//   - 该批次当前全部有效放行（id/时间/操作人/快照集合；放行集合随批次相等，仍留全量）
//   - 出货快照过敏原集合（出货记录不可变）
//   - 出货所用各卷当前停用状态与停用原因（核销修订号变化不影响依据）
function getEvidence(db, shipmentId) {
  const ship = db.prepare(
    'SELECT id, shipment_code, batch_id, batch_code, allergen_set, status FROM shipments WHERE id = ?'
  ).get(shipmentId);
  if (!ship) return null;

  const batch = ship.batch_id == null ? null
    : db.prepare(
      `SELECT b.id, b.code, COALESCE(bo.allergens, '[]') AS allergens,
              CASE WHEN bo.batch_id IS NULL THEN 0 ELSE 1 END AS produced
         FROM batches b LEFT JOIN batch_outputs bo ON bo.batch_id = b.id
        WHERE b.id = ?`
    ).get(ship.batch_id);

  const activeReleases = ship.batch_id == null ? [] : db.prepare(
    `SELECT id, released_at, released_by, snapshot_allergens
       FROM releases WHERE batch_id = ? AND status = 'ACTIVE'
      ORDER BY id`
  ).all(ship.batch_id);

  const rolls = db.prepare(
    `SELECT si.roll_id, si.roll_code,
            lr.id AS existing, lr.status AS roll_status, lr.retired_reason
       FROM shipment_items si
       LEFT JOIN label_rolls lr ON lr.id = si.roll_id
      WHERE si.shipment_id = ?
      ORDER BY si.roll_id, si.id`
  ).all(shipmentId);

  return {
    shipment_id: ship.id,
    shipment_code: ship.shipment_code,
    shipment_status: ship.status,
    batch: batch
      ? { id: batch.id, code: batch.code, produced: !!batch.produced,
          allergens: JSON.parse(batch.allergens || '[]').slice().sort((a, b) => a.localeCompare(b, 'zh')) }
      : null, // 批次已被连带删除
    shipment_allergens: JSON.parse(ship.allergen_set || '[]').slice()
      .sort((a, b) => a.localeCompare(b, 'zh')),
    active_releases: activeReleases.map((r) => ({
      id: r.id,
      released_at: r.released_at,
      released_by: r.released_by,
      allergens: JSON.parse(r.snapshot_allergens || '[]').slice()
        .sort((a, b) => a.localeCompare(b, 'zh'))
    })),
    rolls: rolls.map((r) => ({
      roll_id: r.roll_id,
      roll_code: r.roll_code,
      exists: !!r.existing,
      status: r.roll_status || null,
      retired: r.roll_status === 'RETIRED',
      retired_reason: r.retired_reason || ''
    }))
  };
}

function canonicalString(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalString).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalString(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function evidenceFingerprint(ev) {
  return crypto.createHash('sha256').update(canonicalString(ev)).digest('hex');
}

// 准予继续流转的三个必要条件（查询与提交事务内使用同一判定）。
function evaluateContinue(ev) {
  const reasons = [];
  if (!ev.batch) {
    reasons.push('出货批次的加工记录已不存在（批次被连带删除）');
  } else if (!ev.batch.produced) {
    reasons.push(`批次 ${ev.batch.code} 当前无加工产出，无法推导过敏原`);
  }
  if (ev.batch && !ev.active_releases.length) {
    reasons.push('该批次当前不存在有效放行记录');
  }
  const missing = (ev.batch ? ev.batch.allergens : [])
    .filter((a) => !ev.shipment_allergens.includes(a));
  if (missing.length) {
    reasons.push(`出货快照过敏原集合未覆盖当前批次过敏原（缺少：${missing.join('、') || '?'}）`);
  }
  return { can_continue: reasons.length === 0, reasons };
}

// ---------- 版本令牌 ----------
function issueVersion(shipmentId, fingerprint) {
  const payloadB64 = b64url(JSON.stringify({
    s: shipmentId, fp: fingerprint, ts: Date.now()
  }));
  return {
    version: `${payloadB64}.${sign(payloadB64)}`,
    version_expires_in_ms: REVIEW_TTL_MS
  };
}

function parseVersion(version) {
  if (typeof version !== 'string' || !version.includes('.')) {
    throw new ReviewError('VERSION_INVALID', '处置状态版本格式不正确，请重新查询处置上下文');
  }
  const dot = version.indexOf('.');
  const payloadB64 = version.slice(0, dot);
  const sig = version.slice(dot + 1);
  const expected = sign(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new ReviewError('VERSION_INVALID', '处置状态版本签名不合法，请重新查询处置上下文');
  }
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    );
  } catch (_) {
    throw new ReviewError('VERSION_INVALID', '处置状态版本内容不合法');
  }
  if (!payload || typeof payload.fp !== 'string' || !Number.isInteger(payload.s)) {
    throw new ReviewError('VERSION_INVALID', '处置状态版本内容不合法');
  }
  if (Date.now() - payload.ts > REVIEW_TTL_MS) {
    const err = new ReviewError('VERSION_EXPIRED', '处置状态版本已过期，请重新查询处置上下文');
    err.expired = true;
    throw err;
  }
  return payload;
}

function versionNonce(payloadB64) {
  return crypto.createHash('sha256').update(payloadB64).digest('hex').slice(0, 32);
}

// ---------- 读取模型 ----------
function formatReview(r) {
  if (!r) return null;
  return {
    id: r.id,
    shipment_id: r.shipment_id,
    decision: r.decision,
    decision_text: r.decision === 'CONTINUE' ? '准予继续流转' : '召回',
    decided_by: r.decided_by,
    basis: r.basis,
    decided_at: r.decided_at,
    status: r.status,
    status_text: r.status === 'CURRENT' ? '当前结论'
      : r.status === 'SUPERSEDED' ? '已被新结论取代（历史）'
      : '需重新评估（不自动生效）',
    is_current: r.status === 'CURRENT',
    superseded: r.status === 'SUPERSEDED',
    needs_review: r.status === 'NEEDS_REVIEW',
    stale_reason: r.stale_reason || '',
    basis_version_business: String(r.basis_fingerprint || '').slice(0, 12),
    created_at: r.created_at
  };
}

function getReviews(db, shipmentId) {
  return db.prepare(
    'SELECT * FROM shipment_reviews WHERE shipment_id = ? ORDER BY id DESC'
  ).all(shipmentId).map(formatReview);
}

function getLatestReview(db, shipmentId) {
  const r = db.prepare(
    'SELECT * FROM shipment_reviews WHERE shipment_id = ? ORDER BY id DESC LIMIT 1'
  ).get(shipmentId);
  return r ? formatReview(r) : null;
}

// 处置上下文（查询呈现 + 取得状态版本）。
function reviewContext(db, shipmentId) {
  const ship = db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
  if (!ship) throw new ReviewError('SHIPMENT_NOT_FOUND', '出货单不存在');
  const evidence = getEvidence(db, shipmentId);
  const { can_continue, reasons } = evaluateContinue(evidence);
  const fingerprint = evidenceFingerprint(evidence);
  const { version, version_expires_in_ms } = issueVersion(shipmentId, fingerprint);
  const reviews = getReviews(db, shipmentId);
  const latest = reviews.length ? reviews[0] : null;

  return {
    shipment_id: ship.id,
    shipment_code: ship.shipment_code,
    shipment_status: ship.status,
    pending_review: ship.status === 'PENDING_REVIEW',
    reviewable: ship.status === 'PENDING_REVIEW',
    version,
    version_expires_in_ms,
    business_version: fingerprint.slice(0, 12),
    // 当前处置结论（最新一条；可能 NEEDS_REVIEW 需重新评估）
    current_review: latest,
    review_history: reviews,
    // 处置判定
    can_continue,
    continue_blockers: reasons,
    allowed_decisions: can_continue ? ['CONTINUE', 'RECALL'] : ['RECALL'],
    // 出货时依据（快照，只增不改）
    shipment: {
      allergen_set: evidence.shipment_allergens,
      batch_code: ship.batch_code,
      items: db.prepare(
        `SELECT roll_id, roll_code, qty, roll_revision, release_id, release_at, release_by, allergen_set
           FROM shipment_items WHERE shipment_id = ? ORDER BY id`
      ).all(shipmentId).map((it) => ({
        roll_id: it.roll_id,
        roll_code: it.roll_code,
        qty: it.qty,
        roll_revision: it.roll_revision,
        release_id: it.release_id,
        release_at: it.release_at,
        release_by: it.release_by,
        allergens: JSON.parse(it.allergen_set || '[]')
      }))
    },
    // 当前事实（提交时须与之相符，否则版本过期）
    evidence
  };
}

// ---------- 提交处置 ----------
// body: { version, decision, decided_by, basis, decided_at? }
function submitReview(db, shipmentId, body) {
  body = body || {};
  const ship = db.prepare('SELECT id, status FROM shipments WHERE id = ?').get(shipmentId);
  if (!ship) throw new ReviewError('SHIPMENT_NOT_FOUND', '出货单不存在');

  const rawVersion = body.version == null ? body.basis_version : body.version;
  if (!rawVersion || typeof rawVersion !== 'string') {
    throw new ReviewError('INVALID_REQUEST', '请提供查询处置上下文时取得的状态版本 version');
  }
  const payload = parseVersion(rawVersion);
  if (payload.s !== ship.id) {
    throw new ReviewError('VERSION_INVALID', '状态版本与该出货单不匹配');
  }

  const decision = normalizeDecision(body.decision);
  const decided_by = String(body.decided_by || '').trim();
  if (!decided_by) throw new ReviewError('INVALID_REQUEST', '请录入操作人');
  const basis = String(body.basis || '').trim();
  if (!basis) throw new ReviewError('INVALID_REQUEST', '请录入处置依据');
  const decided_at = String(body.decided_at || '').trim();
  if (decided_at && !TIME_RE.test(decided_at)) {
    throw new ReviewError('INVALID_REQUEST', '处置时间格式应为 YYYY-MM-DDTHH:MM');
  }

  if (ship.status !== 'PENDING_REVIEW') {
    throw new ReviewError(
      'SHIPMENT_NOT_PENDING',
      ship.status === 'SHIPPED'
        ? '该出货单仍为“已出货”，无需质量处置；仅待评估单据可登记处置结论'
        : '仅“待评估”出货单可登记处置结论'
    );
  }

  // 事务外预判定，给出准确中文原因；事务内会基于最新数据权威复核。
  const evidenceBefore = getEvidence(db, ship.id);
  const checkBefore = evaluateContinue(evidenceBefore);
  if (decision === 'CONTINUE' && !checkBefore.can_continue) {
    throw new ReviewError(
      'CONTINUE_NOT_ALLOWED',
      `当前不满足“准予继续流转”条件，只能召回：${checkBefore.reasons.join('；')}`,
      checkBefore.reasons
    );
  }

  const dot = rawVersion.indexOf('.');
  const nonce = versionNonce(rawVersion.slice(0, dot));

  let inserted;
  const tx = db.transaction(() => {
    // ---- 权威复核 1：单据状态（本流程不自动恢复，仅待评估可处置）----
    const cur = db.prepare('SELECT status FROM shipments WHERE id = ?').get(ship.id);
    if (!cur) throw new ReviewError('SHIPMENT_NOT_FOUND', '出货单不存在');
    if (cur.status !== 'PENDING_REVIEW') {
      throw new ReviewError('SHIPMENT_NOT_PENDING', '该出货单当前不是“待评估”状态，不能登记处置结论');
    }

    // ---- 权威复核 2：状态版本（依据指纹必须与查询时一致）----
    const evidence = getEvidence(db, ship.id);
    const fingerprint = evidenceFingerprint(evidence);
    if (fingerprint !== payload.fp) {
      throw new ReviewError(
        'VERSION_EXPIRED',
        '查询后该单处置依据已变化（批次过敏原 / 有效放行 / 所用卷停用信息），状态版本已过期；' +
        '本次拒绝且不产生记录，请重新查询后再提交'
      );
    }

    // ---- 权威复核 3：条件判定必须仍成立（防止查询与提交间条件翻转）----
    const check = evaluateContinue(evidence);
    if (decision === 'CONTINUE' && !check.can_continue) {
      throw new ReviewError(
        'CONTINUE_NOT_ALLOWED',
        `当前不满足“准予继续流转”条件，只能召回：${check.reasons.join('；')}`,
        check.reasons
      );
    }

    // ---- 重放检测：同一版本令牌只能产生一条记录（重复用旧版本不得覆盖新结论）----
    const reused = db.prepare(
      'SELECT id FROM shipment_reviews WHERE shipment_id = ? AND version_nonce = ?'
    ).get(ship.id, nonce);
    if (reused) {
      throw new ReviewError(
        'VERSION_USED',
        '该状态版本已用于提交过处置结论，不能重复使用；如需新结论请重新查询取得新版本'
      );
    }
    // 并发兜底：若已有更新的结论（其依据指纹必然与当前一致时也按“旧版本重复提交”拒绝），
    // 依据变化的情形已由 VERSION_EXPIRED 拦截；此处拦截指纹相同但他端先插入的提交。
    const latest = db.prepare(
      'SELECT id, basis_fingerprint FROM shipment_reviews WHERE shipment_id = ? ORDER BY id DESC LIMIT 1'
    ).get(ship.id);
    if (latest && latest.basis_fingerprint === fingerprint) {
      throw new ReviewError(
        'VERSION_EXPIRED',
        '该出货单已有基于相同状态版本的更新处置结论，旧版本重复提交不得覆盖；请重新查询'
      );
    }

    // ---- 只增不改：插入新结论，旧 CURRENT 置 SUPERSEDED（NEEDS_REVIEW 历史原样保留）----
    inserted = db.prepare(
      `INSERT INTO shipment_reviews
         (shipment_id, decision, decided_by, basis, decided_at, status, stale_reason,
          basis_version, basis_fingerprint, evidence_json, version_nonce)
       VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), 'CURRENT', '', ?, ?, ?, ?)`
    ).run(
      ship.id, decision, decided_by, basis, decided_at || null,
      rawVersion, fingerprint, JSON.stringify(evidence), nonce
    ).lastInsertRowid;

    db.prepare(
      `UPDATE shipment_reviews SET status = 'SUPERSEDED'
        WHERE shipment_id = ? AND status = 'CURRENT' AND id <> ?`
    ).run(ship.id, inserted);
  });
  tx();

  const { formatShipment } = require('./shipments');
  return formatShipment(db.prepare('SELECT * FROM shipments WHERE id = ?').get(ship.id), db);
}

function normalizeDecision(v) {
  const d = String(v == null ? '' : v).trim();
  const upper = d.toUpperCase();
  if (upper === 'CONTINUE' || d === '准予继续流转' || d === '继续流转' || d === '准予继续') {
    return 'CONTINUE';
  }
  if (upper === 'RECALL' || d === '召回') return 'RECALL';
  throw new ReviewError('INVALID_REQUEST', '处置只能是“准予继续流转（CONTINUE）”或“召回（RECALL）”');
}

// ---------- 需重新评估联动 ----------
// 批次过敏原、有效放行或所用卷停用信息变化后，在重算/放行变更事务中调用：
// 把每张待评估出货单仍为 CURRENT 的结论与最新依据核对；不一致即置 NEEDS_REVIEW（只置位、不回改）。
// 返回本次新转入 NEEDS_REVIEW 的结论（含出货单标识与原因）。
function syncStaleReviews(db) {
  const shipments = db.prepare(
    "SELECT id FROM shipments WHERE status = 'PENDING_REVIEW' ORDER BY id"
  ).all();
  const upd = db.prepare(
    `UPDATE shipment_reviews SET status = 'NEEDS_REVIEW', stale_reason = ?
      WHERE id = ? AND status = 'CURRENT'`
  );
  const stale = [];
  for (const { id: shipId } of shipments) {
    const currentRows = db.prepare(
      'SELECT * FROM shipment_reviews WHERE shipment_id = ? AND status = \'CURRENT\' ORDER BY id DESC'
    ).all(shipId);
    if (!currentRows.length) continue;
    const evidence = getEvidence(db, shipId);
    const fingerprint = evidenceFingerprint(evidence);
    if (fingerprint === currentRows[0].basis_fingerprint) continue;
    const reason = describeStaleReason(
      evidence,
      safeParseEvidence(currentRows[0].evidence_json)
    );
    for (const row of currentRows) {
      const info = upd.run(reason, row.id);
      if (info.changes) {
        stale.push({
          review_id: row.id,
          shipment_id: shipId,
          shipment_code: evidence.shipment_code,
          old_decision: row.decision,
          old_decision_text: row.decision === 'CONTINUE' ? '准予继续流转' : '召回',
          reason
        });
      }
    }
  }
  return stale;
}

function safeParseEvidence(json) {
  try { return JSON.parse(json || '{}'); } catch (_) { return {}; }
}

function describeStaleReason(now, before) {
  const parts = [];
  const bBatch = before.batch || null;
  if (!now.batch) {
    parts.push('批次加工记录已不存在');
  } else if (!now.batch.produced) {
    parts.push(`批次 ${now.batch.code} 当前无加工产出`);
  } else if (bBatch && Array.isArray(bBatch.allergens)) {
    const added = now.batch.allergens.filter((a) => !bBatch.allergens.includes(a));
    const removed = bBatch.allergens.filter((a) => !now.batch.allergens.includes(a));
    if (added.length || removed.length) {
      const sub = [];
      if (added.length) sub.push(`新增：${added.join('、')}`);
      if (removed.length) sub.push(`移除：${removed.join('、')}`);
      parts.push(`批次过敏原集合变化（${sub.join('；')}）`);
    }
  }
  const beforeIds = new Set((before.active_releases || []).map((r) => r.id));
  const nowIds = new Set(now.active_releases.map((r) => r.id));
  const lost = [...beforeIds].filter((x) => !nowIds.has(x));
  const gained = [...nowIds].filter((x) => !beforeIds.has(x));
  if (lost.length) parts.push('原有效放行已失效或被删除');
  if (gained.length) parts.push('出现新的有效放行记录');
  const beforeRolls = new Map((before.rolls || []).map((r) => [r.roll_id, r]));
  for (const r of now.rolls) {
    const b = beforeRolls.get(r.roll_id);
    if (r.retired && (!b || !b.retired)) {
      parts.push(`所用卷 ${r.roll_code} 已停用（${r.retired_reason || '见停用原因'}）`);
    }
  }
  if (!parts.length) parts.push('处置依据已变化');
  return `处置后批次过敏原、有效放行或所用卷停用信息发生变化，旧结论需重新评估、不自动生效：${parts.join('；')}`;
}

module.exports = {
  ReviewError,
  getEvidence,
  evidenceFingerprint,
  evaluateContinue,
  reviewContext,
  submitReview,
  getReviews,
  getLatestReview,
  syncStaleReviews
};
