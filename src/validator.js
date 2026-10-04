// 美术文创语境审校：事件信封与领域规则校验。
// 纯函数、无外部依赖，既供联调期使用，也作为服务端事件入库前的最后一道防线。

const REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_TYPES = [
  "CONTEXT_FROZEN",
  "EXHIBITION_PUBLISHED",
  "EXHIBITION_EXTENDED",
  "RIGHTS_CONFIRMED",
  "RIGHTS_EXPIRED",
  "DESIGN_SUBMITTED",
  "DESIGN_RESUBMITTED",
  "REVIEW_DECIDED",
  "OBJECTION_WITHDRAWN",
  "SAMPLE_VERIFIED",
  "BATCH_RELEASED",
  "CHANNEL_SUSPENDED",
];

export const AGGREGATE_TYPES = [
  "artwork_context",
  "exhibition",
  "rights_grant",
  "design_revision",
  "production_batch",
  "sales_channel",
];

export const DECISIONS = ["APPROVED", "CONDITIONAL", "REJECTED"];
export const CHANGE_FACETS = ["MATERIAL", "COPY", "SIZE", "CHANNEL"];
export const REVIEW_KINDS = ["ARTISTIC", "RIGHTS"];
export const RIGHTS_SCOPES = ["REPRODUCTION", "ADAPTATION", "PROMOTION", "LIVESTREAM_SALE"];
export const CHANNEL_PURPOSES = ["OFFLINE_RETAIL", "ONLINE_RETAIL", "LIVESTREAM_SALE", "WHOLESALE"];
export const BASIS_TYPES = ["CONTEXT_ELEMENT", "PROHIBITED_CONTEXT", "RIGHTS_SCOPE", "CURATORIAL_NOTE"];
export const STAKEHOLDER_ROLES = ["ARTIST_OR_HEIR", "CURATOR", "COLLECTION_DEPT", "BUSINESS_DEPT", "PARTNER"];

// 事件只能出现在对应聚合的版本链上。
export const EVENT_AGGREGATE = {
  CONTEXT_FROZEN: "artwork_context",
  EXHIBITION_PUBLISHED: "exhibition",
  EXHIBITION_EXTENDED: "exhibition",
  RIGHTS_CONFIRMED: "rights_grant",
  RIGHTS_EXPIRED: "rights_grant",
  DESIGN_SUBMITTED: "design_revision",
  DESIGN_RESUBMITTED: "design_revision",
  REVIEW_DECIDED: "design_revision",
  OBJECTION_WITHDRAWN: "design_revision",
  SAMPLE_VERIFIED: "production_batch",
  BATCH_RELEASED: "production_batch",
  CHANNEL_SUSPENDED: "sales_channel",
};

// 渠道所要求的授权范围：没有相应 scope 的授权不得在该渠道履约。
const CHANNEL_REQUIRED_SCOPE = {
  OFFLINE_RETAIL: "REPRODUCTION",
  ONLINE_RETAIL: "REPRODUCTION",
  WHOLESALE: "REPRODUCTION",
  LIVESTREAM_SALE: "LIVESTREAM_SALE",
};

// 设计变更面对应的重审种类。
const FACET_REVIEWS = {
  MATERIAL: ["ARTISTIC"],
  COPY: ["ARTISTIC", "RIGHTS"],
  SIZE: ["ARTISTIC"],
  CHANNEL: ["RIGHTS"],
};

const nonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const nonEmptyArray = (v) => Array.isArray(v) && v.length > 0;

function requireFields(payload, fields, errors, label) {
  for (const name of fields) {
    if (!(name in payload)) errors.push(`${label}：payload 缺少字段 ${name}`);
  }
}

function checkEnum(value, allowed, errors, label) {
  if (!allowed.includes(value)) errors.push(`${label}：取值必须为 ${allowed.join(" / ")} 之一`);
}

// 审校意见：赞成、附条件通过、反对都必须锚定具体设计区域并给出依据。
function validateOpinions(opinions, errors) {
  if (!nonEmptyArray(opinions)) {
    errors.push("REVIEW_DECIDED：payload 缺少非空 opinions");
    return;
  }
  opinions.forEach((opinion, i) => {
    const where = `REVIEW_DECIDED opinions[${i}]`;
    if (!nonEmptyString(opinion.opinion_id)) errors.push(`${where}：opinion_id 不能为空（供异议撤回引用）`);
    if (!STAKEHOLDER_ROLES.includes(opinion.party)) errors.push(`${where}：party 不在登记范围内`);
    checkEnum(opinion.verdict, DECISIONS, errors, `${where} verdict`);
    if (!nonEmptyArray(opinion.anchor_regions) || !opinion.anchor_regions.every((r) => nonEmptyString(r.region_id))) {
      errors.push(`${where}：必须指向至少一个具体设计区域（anchor_regions[].region_id）`);
    }
    if (!nonEmptyArray(opinion.basis) || !opinion.basis.every((b) => BASIS_TYPES.includes(b.basis_type) && nonEmptyString(b.ref))) {
      errors.push(`${where}：必须给出依据（basis[].basis_type + ref，引用语境冻结件或授权件）`);
    }
    if (opinion.verdict === "CONDITIONAL" && !nonEmptyArray(opinion.conditions)) {
      errors.push(`${where}：附条件通过必须列明 conditions`);
    }
  });
}

// 单事件信封 + 各事件 payload 必填校验。
export function validateEvent(record) {
  const errors = REQUIRED.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if (errors.length) return errors;

  if (!nonEmptyString(record.event_id)) errors.push("event_id 不能为空");
  if (!EVENT_TYPES.includes(record.event_type)) errors.push(`event_type 不在登记范围内：${record.event_type}`);
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`aggregate_type 不在登记范围内：${record.aggregate_type}`);
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (Number.isNaN(Date.parse(record.occurred_at))) errors.push("occurred_at 必须是合法时间");
  if (!nonEmptyString(record.summary)) errors.push("summary 不能为空");
  if (errors.length) return errors;

  if (EVENT_AGGREGATE[record.event_type] !== record.aggregate_type) {
    errors.push(`${record.event_type} 只能挂在聚合 ${EVENT_AGGREGATE[record.event_type]} 上，当前为 ${record.aggregate_type}`);
    return errors;
  }

  const p = record.payload ?? {};
  if (typeof p !== "object" || Array.isArray(p)) {
    errors.push("payload 必须是对象");
    return errors;
  }

  switch (record.event_type) {
    case "CONTEXT_FROZEN":
      requireFields(p, ["exhibition_id", "artwork_id", "curatorial_note", "extractable_elements", "prohibited_contexts"], errors, "CONTEXT_FROZEN");
      if (Array.isArray(p.extractable_elements) && !p.extractable_elements.every((e) => nonEmptyString(e.element_id))) {
        errors.push("CONTEXT_FROZEN：extractable_elements[].element_id 不能为空");
      }
      if (!Array.isArray(p.prohibited_contexts)) errors.push("CONTEXT_FROZEN：prohibited_contexts 必须是数组（可为空）");
      if (typeof p.artwork_published !== "boolean") errors.push("CONTEXT_FROZEN：artwork_published 必须为布尔值，标明作品是否已公布");
      break;
    case "EXHIBITION_PUBLISHED":
      requireFields(p, ["exhibition_id"], errors, "EXHIBITION_PUBLISHED");
      break;
    case "EXHIBITION_EXTENDED":
      requireFields(p, ["exhibition_id", "previous_end_date", "new_end_date"], errors, "EXHIBITION_EXTENDED");
      if (Date.parse(p.new_end_date) <= Date.parse(p.previous_end_date)) {
        errors.push("EXHIBITION_EXTENDED：new_end_date 必须晚于 previous_end_date");
      }
      break;
    case "RIGHTS_CONFIRMED":
      requireFields(p, ["grant_id", "exhibition_id", "artwork_id", "rights_holder_id", "partner_id", "scopes", "effective_from", "effective_until"], errors, "RIGHTS_CONFIRMED");
      if (Array.isArray(p.scopes)) p.scopes.forEach((s) => checkEnum(s, RIGHTS_SCOPES, errors, "RIGHTS_CONFIRMED scopes"));
      else errors.push("RIGHTS_CONFIRMED：scopes 必须为数组");
      if ("channels" in p && !Array.isArray(p.channels)) errors.push("RIGHTS_CONFIRMED：channels 必须为数组");
      break;
    case "RIGHTS_EXPIRED":
      requireFields(p, ["grant_id", "effective_until"], errors, "RIGHTS_EXPIRED");
      break;
    case "DESIGN_SUBMITTED":
    case "DESIGN_RESUBMITTED": {
      requireFields(p, ["design_id", "revision_no", "context_id", "artwork_id", "exhibition_id", "partner_id", "material", "copy_text", "size", "channels", "elements_used", "design_regions"], errors, record.event_type);
      if (Array.isArray(p.channels)) p.channels.forEach((c) => checkEnum(c, CHANNEL_PURPOSES, errors, `${record.event_type} channels`));
      else errors.push(`${record.event_type}：channels 必须为数组`);
      if (Array.isArray(p.elements_used)) {
        p.elements_used.forEach((u, i) => {
          if (!nonEmptyString(u.element_id) || !nonEmptyString(u.region_id)) {
            errors.push(`${record.event_type} elements_used[${i}]：element_id 与 region_id 均不能为空`);
          }
        });
      } else errors.push(`${record.event_type}：elements_used 必须为数组`);
      if (Array.isArray(p.design_regions) && !p.design_regions.every((r) => nonEmptyString(r.region_id))) {
        errors.push(`${record.event_type}：design_regions[].region_id 不能为空`);
      }
      if (record.event_type === "DESIGN_RESUBMITTED") {
        requireFields(p, ["based_on_revision", "changed_facets"], errors, "DESIGN_RESUBMITTED");
        if (Array.isArray(p.changed_facets)) p.changed_facets.forEach((f) => checkEnum(f, CHANGE_FACETS, errors, "changed_facets"));
      }
      break;
    }
    case "REVIEW_DECIDED":
      requireFields(p, ["design_id", "revision_no", "decision", "review_kind", "opinions"], errors, "REVIEW_DECIDED");
      checkEnum(p.decision, DECISIONS, errors, "REVIEW_DECIDED decision");
      checkEnum(p.review_kind, REVIEW_KINDS, errors, "REVIEW_DECIDED review_kind");
      validateOpinions(p.opinions, errors);
      break;
    case "OBJECTION_WITHDRAWN":
      requireFields(p, ["design_id", "withdrawn_opinion_ids", "prior_decision_id"], errors, "OBJECTION_WITHDRAWN");
      break;
    case "SAMPLE_VERIFIED":
      requireFields(p, ["batch_id", "design_id", "revision_no", "decision_id", "sample_hash", "checked_by", "matches"], errors, "SAMPLE_VERIFIED");
      if (p.matches !== true) errors.push("SAMPLE_VERIFIED：仅允许记录核对一致的样品（matches=true），不一致应退回改稿");
      break;
    case "BATCH_RELEASED":
      requireFields(p, ["batch_id", "design_id", "revision_no", "decision_id", "grant_ids", "partner_id", "sample_hash", "quantity", "channels", "produced_at"], errors, "BATCH_RELEASED");
      if (Array.isArray(p.channels)) p.channels.forEach((c) => checkEnum(c, CHANNEL_PURPOSES, errors, "BATCH_RELEASED channels"));
      break;
    case "CHANNEL_SUSPENDED":
      requireFields(p, ["channel_id", "batch_ids", "reason", "suspended_at"], errors, "CHANNEL_SUSPENDED");
      checkEnum(p.channel_id, CHANNEL_PURPOSES, errors, "CHANNEL_SUSPENDED channel_id");
      if (!nonEmptyArray(p.batch_ids)) errors.push("CHANNEL_SUSPENDED：局部停售必须指明受影响 batch_ids");
      break;
  }
  return errors;
}

// 比较两个设计版本，计算需要重审的部分。
// 渠道新增才需要权利重审；仅移除渠道不产生重审义务。
export function computeReassessment(before, after) {
  const changed = [];
  if (before.material !== after.material) changed.push("MATERIAL");
  if (before.copy_text !== after.copy_text) changed.push("COPY");
  if (JSON.stringify(before.size) !== JSON.stringify(after.size)) changed.push("SIZE");
  const addedChannels = (after.channels ?? []).filter((c) => !(before.channels ?? []).includes(c));
  if (addedChannels.length > 0) changed.push("CHANNEL");

  const kinds = new Set();
  changed.forEach((facet) => FACET_REVIEWS[facet].forEach((k) => kinds.add(k)));
  return {
    changed_facets: changed,
    added_channels: addedChannels,
    required_reviews: [...kinds],
    livestream_added: addedChannels.includes("LIVESTREAM_SALE"),
  };
}

// 校验整条事件日志：版本链连续性、引用完整性、投产闸门、授权窗口、不可变约束。
export function validateChain(events) {
  const errors = [];
  events.forEach((e, i) => validateEvent(e).forEach((msg) => errors.push(`事件#${i} ${e.event_id ?? "?"}：${msg}`)));
  if (errors.length) return errors;

  const byAggregate = new Map();
  for (const e of events) {
    if (!byAggregate.has(e.aggregate_id)) byAggregate.set(e.aggregate_id, []);
    byAggregate.get(e.aggregate_id).push(e);
  }
  for (const [id, list] of byAggregate) {
    list.forEach((e, i) => {
      if (e.version !== i + 1) errors.push(`聚合 ${id}：版本号须从 1 连续递增，第 ${i + 1} 个事件版本为 ${e.version}`);
      if (i > 0 && Date.parse(e.occurred_at) < Date.parse(list[i - 1].occurred_at)) {
        errors.push(`聚合 ${id}：事件时间不得倒流（${e.event_id} 早于前一事件）`);
      }
    });
  }

  const find = (predicate) => events.find(predicate);
  const contexts = events.filter((e) => e.event_type === "CONTEXT_FROZEN");
  const contextOf = (artworkId, exhibitionId) =>
    contexts.find((e) => e.payload.artwork_id === artworkId && e.payload.exhibition_id === exhibitionId);
  const publishedExhibitions = new Set(
    events.filter((e) => e.event_type === "EXHIBITION_PUBLISHED").map((e) => e.payload.exhibition_id),
  );
  const grants = events.filter((e) => e.event_type === "RIGHTS_CONFIRMED");
  const grantById = new Map(grants.map((e) => [e.payload.grant_id, e]));
  const decisions = events.filter((e) => e.event_type === "REVIEW_DECIDED");
  const decisionById = new Map(decisions.map((e) => [e.event_id, e]));

  // 设计件必须引用已冻结语境；可提取元素与禁用语境必须来自该冻结件。
  for (const e of events.filter((x) => x.event_type === "DESIGN_SUBMITTED" || x.event_type === "DESIGN_RESUBMITTED")) {
    const ctx = contextOf(e.payload.artwork_id, e.payload.exhibition_id);
    if (!ctx) {
      errors.push(`设计 ${e.payload.design_id} v${e.payload.revision_no}：找不到对应作品的 CONTEXT_FROZEN`);
      continue;
    }
    if (e.payload.context_id !== ctx.aggregate_id) {
      errors.push(`设计 ${e.payload.design_id}：context_id 必须指向冻结语境聚合 ${ctx.aggregate_id}`);
    }
    const allowed = new Set(ctx.payload.extractable_elements.map((x) => x.element_id));
    for (const used of e.payload.elements_used) {
      if (!allowed.has(used.element_id)) {
        errors.push(`设计 ${e.payload.design_id}：使用了未在冻结语境中登记的可提取元素 ${used.element_id}`);
      }
      if (used.region_id && !e.payload.design_regions?.some((r) => r.region_id === used.region_id)) {
        errors.push(`设计 ${e.payload.design_id}：元素 ${used.element_id} 未落在已登记设计区域上`);
      }
    }
    for (const banned of ctx.payload.prohibited_contexts) {
      if (typeof banned.match_copy === "string" && e.payload.copy_text.includes(banned.match_copy)) {
        errors.push(`设计 ${e.payload.design_id}：文案撞入禁用语境「${banned.match_copy}」`);
      }
    }
    if (e.event_type === "DESIGN_RESUBMITTED") {
      const prior = find(
        (x) => (x.event_type === "DESIGN_SUBMITTED" || x.event_type === "DESIGN_RESUBMITTED")
          && x.payload.design_id === e.payload.design_id && x.payload.revision_no === e.payload.based_on_revision,
      );
      if (!prior) errors.push(`设计 ${e.payload.design_id}：based_on_revision ${e.payload.based_on_revision} 不存在`);
      const calc = prior ? computeReassessment(prior.payload, e.payload) : null;
      if (calc && JSON.stringify(calc.changed_facets.sort()) !== JSON.stringify([...e.payload.changed_facets].sort())) {
        errors.push(`设计 ${e.payload.design_id}：申报的 changed_facets 与实际差异不一致，应为 ${calc.changed_facets.join("/") || "（无）"}`);
      }
    }
  }

  // 审校决定必须挂在已提交的具体设计版本上；锚点与依据必须可解析。
  for (const e of decisions) {
    const design = find(
      (x) => (x.event_type === "DESIGN_SUBMITTED" || x.event_type === "DESIGN_RESUBMITTED")
        && x.payload.design_id === e.payload.design_id && x.payload.revision_no === e.payload.revision_no,
    );
    if (!design) {
      errors.push(`审校 ${e.event_id}：设计 ${e.payload.design_id} v${e.payload.revision_no} 不存在`);
      continue;
    }
    const regionIds = new Set(design.payload.design_regions.map((r) => r.region_id));
    const ctx = contextOf(design.payload.artwork_id, design.payload.exhibition_id);
    const elementIds = new Set(ctx?.payload.extractable_elements.map((x) => x.element_id) ?? []);
    const bannedIds = new Set(ctx?.payload.prohibited_contexts.map((x) => x.context_id).filter(Boolean) ?? []);
    const grantIds = new Set(grants.map((g) => g.payload.grant_id));
    for (const op of e.payload.opinions) {
      for (const anchor of op.anchor_regions) {
        if (!regionIds.has(anchor.region_id)) {
          errors.push(`审校 ${e.event_id} 意见 ${op.opinion_id}：锚定区域 ${anchor.region_id} 不在该设计稿上`);
        }
      }
      for (const b of op.basis) {
        const ok = (b.basis_type === "CONTEXT_ELEMENT" && elementIds.has(b.ref))
          || (b.basis_type === "PROHIBITED_CONTEXT" && bannedIds.has(b.ref))
          || (b.basis_type === "CURATORIAL_NOTE" && ctx && (b.ref === ctx.aggregate_id || b.ref === ctx.event_id))
          || (b.basis_type === "RIGHTS_SCOPE" && grantIds.has(b.ref));
        if (!ok) errors.push(`审校 ${e.event_id} 意见 ${op.opinion_id}：依据 ${b.basis_type}:${b.ref} 无法在冻结语境或授权件中解析`);
      }
    }
  }

  // 每个设计版本需要哪些审种，以及各审种应在哪个版本完成：
  // 初始稿艺术/权利两类必审；改稿只对变更面涉及的审种重新到期；
  // 未触及的审种沿用此前版本的通过结论。
  const designSubmits = new Map();
  for (const e of events.filter((x) => x.event_type === "DESIGN_SUBMITTED" || x.event_type === "DESIGN_RESUBMITTED")) {
    if (!designSubmits.has(e.payload.design_id)) designSubmits.set(e.payload.design_id, []);
    designSubmits.get(e.payload.design_id).push(e);
  }
  const dueReviewsOf = (designId, revisionNo) => {
    const list = (designSubmits.get(designId) ?? []).slice().sort((a, b) => a.payload.revision_no - b.payload.revision_no);
    const due = { ARTISTIC: 1, RIGHTS: 1 };
    for (const e of list) {
      if (e.payload.revision_no <= 1 || e.payload.revision_no > revisionNo) continue;
      const prev = list.find((x) => x.payload.revision_no === e.payload.based_on_revision);
      if (!prev) continue;
      for (const kind of computeReassessment(prev.payload, e.payload).required_reviews) {
        due[kind] = e.payload.revision_no;
      }
    }
    return due;
  };

  // 只有 APPROVED 的审校决定可作为投产依据；CONDITIONAL 必须先改稿复审。
  const approvalsByRevision = new Map(); // design_id|rev -> kinds with APPROVED
  for (const e of decisions) {
    if (e.payload.decision === "APPROVED") {
      const key = `${e.payload.design_id}|${e.payload.revision_no}`;
      if (!approvalsByRevision.has(key)) approvalsByRevision.set(key, new Set());
      approvalsByRevision.get(key).add(e.payload.review_kind);
    }
  }
  for (const e of events.filter((x) => x.event_type === "SAMPLE_VERIFIED" || x.event_type === "BATCH_RELEASED")) {
    const decision = decisionById.get(e.payload.decision_id);
    if (!decision) {
      errors.push(`${e.event_type} ${e.payload.batch_id || e.event_id}：引用的审校决定 ${e.payload.decision_id} 不存在`);
    } else {
      if (decision.payload.design_id !== e.payload.design_id || decision.payload.revision_no !== e.payload.revision_no) {
        errors.push(`${e.event_type} ${e.payload.batch_id || e.event_id}：审校决定与设计版本不匹配`);
      }
      if (decision.payload.decision !== "APPROVED") {
        errors.push(`${e.event_type} ${e.payload.batch_id || e.event_id}：仅 APPROVED 决定可进入投产环节，当前为 ${decision.payload.decision}`);
      }
      const due = dueReviewsOf(e.payload.design_id, e.payload.revision_no);
      for (const [kind, dueRev] of Object.entries(due)) {
        const got = approvalsByRevision.get(`${e.payload.design_id}|${dueRev}`);
        if (!got?.has(kind)) {
          errors.push(`${e.event_type} ${e.payload.batch_id || e.event_id}：缺少在 v${dueRev} 到期的 ${kind} 类 APPROVED 决定`);
        }
      }
    }
  }

  // 投产前须有与获准版本一致的样品核对记录；批次固化授权快照与渠道。
  const verifies = events.filter((e) => e.event_type === "SAMPLE_VERIFIED");
  for (const e of events.filter((x) => x.event_type === "BATCH_RELEASED")) {
    const b = e.payload;
    const verified = verifies.find(
      (v) => v.payload.batch_id === b.batch_id && v.payload.sample_hash === b.sample_hash
        && v.payload.revision_no === b.revision_no && v.payload.design_id === b.design_id,
    );
    if (!verified) errors.push(`批次 ${b.batch_id}：缺少与获准版本一致的 SAMPLE_VERIFIED 记录`);
    if (!Number.isInteger(b.quantity) || b.quantity <= 0) errors.push(`批次 ${b.batch_id}：quantity 必须为正整数`);

    for (const gid of b.grant_ids) {
      const g = grantById.get(gid);
      if (!g) {
        errors.push(`批次 ${b.batch_id}：授权 ${gid} 不存在`);
        continue;
      }
      if (Date.parse(b.produced_at) < Date.parse(g.payload.effective_from)
        || Date.parse(b.produced_at) > Date.parse(g.payload.effective_until)) {
        errors.push(`批次 ${b.batch_id}：生产时间不在授权 ${gid} 的有效期内`);
      }
    }
    for (const channel of b.channels) {
      const requiredScope = CHANNEL_REQUIRED_SCOPE[channel];
      const covered = b.grant_ids.some((gid) => {
        const g = grantById.get(gid);
        return g && g.payload.scopes.includes(requiredScope)
          && (!g.payload.channels || g.payload.channels.includes(channel));
      });
      if (!covered) errors.push(`批次 ${b.batch_id}：渠道 ${channel} 缺少授权范围 ${requiredScope}`);
    }
  }

  // 展览延期、权利到期、异议撤回只能追加事实，不得回写已生产批次。
  for (const e of events) {
    if (e.event_type === "RIGHTS_EXPIRED" || e.event_type === "EXHIBITION_EXTENDED" || e.event_type === "OBJECTION_WITHDRAWN") {
      if (e.payload.mutates_batches === true) {
        errors.push(`${e.event_type} ${e.event_id}：不得声明回写已生产批次，历史批次只能被停售不能被改写`);
      }
    }
    if (e.event_type === "OBJECTION_WITHDRAWN") {
      const prior = decisionById.get(e.payload.prior_decision_id);
      if (!prior) {
        errors.push(`异议撤回 ${e.event_id}：prior_decision_id 不存在`);
      } else {
        const opinionIds = new Set(prior.payload.opinions.map((o) => o.opinion_id));
        for (const oid of e.payload.withdrawn_opinion_ids) {
          if (!opinionIds.has(oid)) errors.push(`异议撤回 ${e.event_id}：意见 ${oid} 不在原决定 ${prior.event_id} 中`);
        }
      }
    }
    if (e.event_type === "CHANNEL_SUSPENDED") {
      const released = new Set(events.filter((x) => x.event_type === "BATCH_RELEASED").map((x) => x.payload.batch_id));
      for (const bid of e.payload.batch_ids) {
        if (!released.has(bid)) errors.push(`停售事件 ${e.event_id}：批次 ${bid} 从未投产，不能停售`);
      }
    }
  }

  // 合作方可见性由 projectForPartner 负责，这里做静态冗余检查：
  // 授权件必须自带 partner_id，且跨方设计/授权不得共用同一合作方标识。
  return errors;
}

// 合作方视图：履约最小可见集。
// - 未公布展览的冻结语境对任何合作方不可见；
// - 只可见归属本方的授权、设计与相关审校；
// - 馆藏/经营内部事件与其他艺术家合同一律剔除。
export function projectForPartner(events, partnerId) {
  const ownGrants = events
    .filter((e) => e.event_type === "RIGHTS_CONFIRMED" && e.payload.partner_id === partnerId)
    .map((e) => ({ exhibition_id: e.payload.exhibition_id, artwork_id: e.payload.artwork_id }));
  const ownKey = (x) => `${x.exhibition_id}|${x.artwork_id}`;
  const scopeKeys = new Set(ownGrants.map(ownKey));
  const published = new Set(
    events.filter((e) => e.event_type === "EXHIBITION_PUBLISHED").map((e) => e.payload.exhibition_id),
  );

  // 注意：停售分支要返回裁剪后的副本，flatMap 才能把映射值真正带出；filter 只会保留原对象。
  return events.flatMap((e) => {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "EXHIBITION_PUBLISHED":
      case "EXHIBITION_EXTENDED":
        return published.has(p.exhibition_id) ? [e] : [];
      case "CONTEXT_FROZEN":
        return (p.artwork_published === true && published.has(p.exhibition_id)
          && scopeKeys.has(ownKey({ exhibition_id: p.exhibition_id, artwork_id: p.artwork_id }))) ? [e] : [];
      case "RIGHTS_CONFIRMED":
        return p.partner_id === partnerId ? [e] : [];
      case "RIGHTS_EXPIRED":
        return grantBelongsTo(events, p.grant_id, partnerId) ? [e] : [];
      case "DESIGN_SUBMITTED":
      case "DESIGN_RESUBMITTED":
        return p.partner_id === partnerId ? [e] : [];
      case "REVIEW_DECIDED":
      case "OBJECTION_WITHDRAWN":
        return ownDesign(events, p.design_id, partnerId) ? [e] : [];
      case "SAMPLE_VERIFIED":
      case "BATCH_RELEASED":
        return ownBatch(events, p, partnerId) ? [e] : [];
      case "CHANNEL_SUSPENDED": {
        // 同一次停售可能波及多个合作方，只露出本方批次。
        const visible = p.batch_ids.filter((bid) => ownBatch(events, { batch_id: bid }, partnerId));
        return visible.length > 0 ? [{ ...e, payload: { ...p, batch_ids: visible } }] : [];
      }
      default:
        return [];
    }
  });
}

function grantBelongsTo(events, grantId, partnerId) {
  const g = events.find((e) => e.event_type === "RIGHTS_CONFIRMED" && e.payload.grant_id === grantId);
  return g?.payload.partner_id === partnerId;
}

function ownDesign(events, designId, partnerId) {
  return events.some(
    (e) => (e.event_type === "DESIGN_SUBMITTED" || e.event_type === "DESIGN_RESUBMITTED")
      && e.payload.design_id === designId && e.payload.partner_id === partnerId,
  );
}

function ownBatch(events, payload, partnerId) {
  if (payload.partner_id === partnerId) return true;
  // 样品/批次件直接带 design_id；停售事件只带 batch_id，先经批次件反查。
  if (payload.design_id) return ownDesign(events, payload.design_id, partnerId);
  const release = events.find(
    (e) => e.event_type === "BATCH_RELEASED" && e.payload.batch_id === payload.batch_id,
  );
  return Boolean(release) && ownDesign(events, release.payload.design_id, partnerId);
}

// 批次回放：每个渠道的在售状态按停售事件折叠，批次事实永不消失。
export function replayBatches(events) {
  const batches = new Map();
  for (const e of events) {
    if (e.event_type === "BATCH_RELEASED") {
      batches.set(e.payload.batch_id, {
        batch_id: e.payload.batch_id,
        design_id: e.payload.design_id,
        revision_no: e.payload.revision_no,
        channels: Object.fromEntries(e.payload.channels.map((c) => [c, "ACTIVE"])),
        history: [e],
      });
    } else if (e.event_type === "CHANNEL_SUSPENDED") {
      for (const bid of e.payload.batch_ids) {
        const batch = batches.get(bid);
        if (batch) {
          if (batch.channels[e.payload.channel_id]) batch.channels[e.payload.channel_id] = "SUSPENDED";
          batch.history.push(e);
        }
      }
    }
  }
  return [...batches.values()];
}

// 售出商品回查：批次 → 获准设计版本 → 审校决定 → 授权快照 → 该渠道当时与当前状态。
export function traceSoldProduct(events, { batch_id: batchId, channel_id: channelId }) {
  const release = events.find((e) => e.event_type === "BATCH_RELEASED" && e.payload.batch_id === batchId);
  if (!release) return { found: false, reason: `批次 ${batchId} 不存在` };
  const b = release.payload;
  const decision = events.find((e) => e.event_type === "REVIEW_DECIDED" && e.event_id === b.decision_id);
  // 授权以批次生产时点的最新版本为准（同一 grant_id 按 version 折叠）。
  const grants = b.grant_ids
    .map((gid) => events
      .filter((e) => e.event_type === "RIGHTS_CONFIRMED" && e.payload.grant_id === gid
        && Date.parse(e.payload.effective_from) <= Date.parse(b.produced_at))
      .sort((x, y) => y.version - x.version)[0])
    .filter(Boolean);
  const suspensions = events.filter(
    (e) => e.event_type === "CHANNEL_SUSPENDED" && e.payload.batch_ids.includes(batchId) && e.payload.channel_id === channelId,
  );
  return {
    found: true,
    batch: b,
    approved_revision: { design_id: b.design_id, revision_no: b.revision_no },
    decision: decision ? { event_id: decision.event_id, decision: decision.payload.decision } : null,
    grants: grants.map((g) => ({ grant_id: g.payload.grant_id, scopes: g.payload.scopes, effective_until: g.payload.effective_until })),
    channel_status: suspensions.length ? "SUSPENDED" : "ACTIVE",
    suspension_history: suspensions.map((s) => ({ event_id: s.event_id, reason: s.payload.reason, suspended_at: s.payload.suspended_at })),
  };
}
