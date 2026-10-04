import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AGGREGATE_TYPES,
  EVENT_TYPES,
  computeReassessment,
  projectForPartner,
  replayBatches,
  traceSoldProduct,
  validateChain,
  validateEvent,
} from "../src/validator.js";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

// node:test 不支持顶层 await 读文件，包一层惰性加载。
let cachedChain;
async function chain() {
  cachedChain ??= await loadJson("../data/sample-chain.json");
  return structuredClone(cachedChain);
}
const findEvent = (events, id) => events.find((e) => e.event_id === id);
const byId = (events) => Object.fromEntries(events.map((e) => [e.event_id, e]));

test("单事件样例符合领域约定", async () => {
  const sample = await loadJson("../data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("validator 枚举与 schema 契约保持一致", async () => {
  const schema = await loadJson("../contracts/domain.schema.json");
  assert.deepEqual(EVENT_TYPES, schema.$defs.event_types.enum);
  assert.deepEqual(AGGREGATE_TYPES, schema.$defs.aggregate_types.enum);
});

test("完整联调样例链通过全部领域规则", async () => {
  const errors = validateChain(await chain());
  assert.deepEqual(errors, []);
});

test("事件挂错聚合会被拒绝", () => {
  const bad = {
    event_id: "x",
    event_type: "BATCH_RELEASED",
    aggregate_type: "design_revision",
    aggregate_id: "a",
    occurred_at: "2026-10-01T00:00:00+08:00",
    version: 1,
    summary: "错挂",
  };
  assert.match(validateEvent(bad)[0], /只能挂在聚合/);
});

test("computeReassessment：材质/文案/尺寸/新增渠道分别决定重审面", () => {
  const base = {
    material: "桑蚕丝",
    copy_text: "秋山行旅",
    size: { width: 180, height: 60, unit: "cm" },
    channels: ["OFFLINE_RETAIL"],
  };
  assert.deepEqual(
    computeReassessment(base, { ...base, material: "羊绒" }),
    { changed_facets: ["MATERIAL"], added_channels: [], required_reviews: ["ARTISTIC"], livestream_added: false },
  );
  assert.deepEqual(
    computeReassessment(base, { ...base, copy_text: "新文案" }).changed_facets,
    ["COPY"],
  );
  assert.deepEqual(
    computeReassessment(base, { ...base, size: { width: 90, height: 90, unit: "cm" } }).required_reviews,
    ["ARTISTIC"],
  );
  const channelChange = computeReassessment(base, { ...base, channels: ["OFFLINE_RETAIL", "LIVESTREAM_SALE"] });
  assert.deepEqual(channelChange.changed_facets, ["CHANNEL"]);
  assert.deepEqual(channelChange.required_reviews, ["RIGHTS"]);
  assert.equal(channelChange.livestream_added, true);
  // 仅移除渠道不产生重审义务。
  assert.deepEqual(
    computeReassessment({ ...base, channels: ["OFFLINE_RETAIL", "ONLINE_RETAIL"] }, base).changed_facets,
    [],
  );
});

test("合作方只看到履约所需：未公布内容、他人合同与他人设计均不串出", async () => {
  const events = await chain();
  const view = projectForPartner(events, "partner-hongbu");
  const ids = view.map((e) => e.event_id);

  assert.ok(ids.includes("evt-ctx-aw01-frozen")); // 本方授权作品的冻结语境
  assert.ok(!ids.includes("evt-ctx-aw02-frozen")); // 未公布作品
  assert.ok(!ids.includes("evt-grant-aw02-otherco")); // 其他艺术家合同
  assert.ok(!ids.includes("evt-design-aw02-v1")); // 他人设计
  assert.ok(ids.includes("evt-grant-aw01-expired")); // 本方授权到期事实
  assert.ok(ids.includes("evt-channel-livestream-suspended"));
  const suspension = view.find((e) => e.event_id === "evt-channel-livestream-suspended");
  assert.deepEqual(suspension.payload.batch_ids, ["batch-2027-001"]);
});

test("停售事件波及他方批次时，本方视图只露出本方批次", async () => {
  const events = await chain();
  // 先补一条他方已投产批次（同一直播停售波及两方）。
  events.push({
    event_id: "evt-batch-otherco-999",
    event_type: "BATCH_RELEASED",
    aggregate_type: "production_batch",
    aggregate_id: "batch-otherco-999",
    occurred_at: "2027-01-09T09:00:00+08:00",
    version: 1,
    summary: "另一合作方已投产批次",
    payload: {
      batch_id: "batch-otherco-999",
      design_id: "design-aw02-badge",
      revision_no: 1,
      decision_id: "evt-review-aw01-v3-rights",
      partner_id: "partner-otherco",
      grant_ids: ["grant-aw02-otherco"],
      sample_hash: "sha256:other",
      quantity: 50,
      channels: ["LIVESTREAM_SALE"],
      produced_at: "2027-01-09",
    },
  });
  findEvent(events, "evt-channel-livestream-suspended").payload.batch_ids.push("batch-otherco-999");
  const view = projectForPartner(events, "partner-hongbu");
  const suspension = view.find((e) => e.event_id === "evt-channel-livestream-suspended");
  assert.deepEqual(suspension.payload.batch_ids, ["batch-2027-001"]);
  // 另一方也只看到自己的批次 id。
  const otherView = projectForPartner(events, "partner-otherco");
  const otherSuspension = otherView.find((e) => e.event_id === "evt-channel-livestream-suspended");
  assert.deepEqual(otherSuspension.payload.batch_ids, ["batch-otherco-999"]);
});

test("未公布展览的冻结语境即使作品已公布也不进合作方视图", async () => {
  const events = await chain();
  findEvent(events, "evt-exh-published").event_type = "EXHIBITION_EXTENDED";
  findEvent(events, "evt-exh-published").payload.previous_end_date = "2026-08-31";
  const view = projectForPartner(events, "partner-hongbu");
  assert.ok(!view.some((e) => e.event_type === "evt-ctx-aw01-frozen"));
});

test("审校意见必须锚定具体设计区域并引用依据", async () => {
  const events = await chain();
  const decision = findEvent(events, "evt-review-aw01-v2-artistic");
  decision.payload.opinions[0].anchor_regions = [];
  assert.ok(validateChain(events).some((m) => m.includes("必须指向至少一个具体设计区域")));

  const events2 = await chain();
  const decision2 = findEvent(events2, "evt-review-aw01-v2-artistic");
  decision2.payload.opinions[0].anchor_regions[0].region_id = "r-not-exist";
  assert.ok(validateChain(events2).some((m) => m.includes("不在该设计稿上")));

  const events3 = await chain();
  const decision3 = findEvent(events3, "evt-review-aw01-v2-artistic");
  decision3.payload.opinions[0].basis[0].ref = "el-ghost";
  assert.ok(validateChain(events3).some((m) => m.includes("无法在冻结语境或授权件中解析")));

  const events4 = await chain();
  const conditional = findEvent(events4, "evt-review-aw01-v1-artistic");
  conditional.payload.opinions[0].conditions = [];
  assert.ok(validateChain(events4).some((m) => m.includes("附条件通过必须列明")));
});

test("使用未登记元素或撞入禁用语境会被拦截", async () => {
  const events = await chain();
  findEvent(events, "evt-design-aw01-v1").payload.elements_used[0].element_id = "el-tiktok-trend";
  assert.ok(validateChain(events).some((m) => m.includes("未在冻结语境中登记")));

  const events2 = await chain();
  findEvent(events2, "evt-design-aw01-v1").payload.copy_text = "镇宅之宝 秋山行旅";
  assert.ok(validateChain(events2).some((m) => m.includes("撞入禁用语境")));
});

test("改稿申报的变更面与实际差异不符会被拦截", async () => {
  const events = await chain();
  const v2 = findEvent(events, "evt-design-aw01-v2");
  v2.payload.changed_facets = []; // 实际换了材质却申报无变更
  assert.ok(validateChain(events).some((m) => m.includes("changed_facets 与实际差异不一致")));
});

test("渠道面改稿缺少 v3 权利重审不得投产", async () => {
  const events = await chain();
  // 删掉 v3 权利通过：批次仍引用它，先改引用到不存在的另一种场景——
  // 直接删除决定事件，批次引用悬空。
  const idx = events.findIndex((e) => e.event_id === "evt-review-aw01-v3-rights");
  events.splice(idx, 1);
  const errors = validateChain(events);
  assert.ok(errors.some((m) => m.includes("审校决定 evt-review-aw01-v3-rights 不存在")));
});

test("仅渠道变更时艺术审校结论沿用 v2，不要求 v3 重新艺术审校", async () => {
  // 样例链本身就是这种形态：v3 只有 RIGHTS 决定，批次仍合法。
  const errors = validateChain(await chain());
  assert.deepEqual(errors, []);
});

test("直播渠道缺少 LIVESTREAM_SALE 授权范围时批次被拦截", async () => {
  const events = await chain();
  // v2 授权是补登直播；把批次提前到旧授权窗口（v1 聚合事件已被同聚合 v2 覆盖，
  // 这里改为移除授权中的直播 scope）。
  findEvent(events, "evt-grant-aw01-v2").payload.scopes = ["REPRODUCTION", "ADAPTATION", "PROMOTION"];
  const errors = validateChain(events);
  assert.ok(errors.some((m) => m.includes("渠道 LIVESTREAM_SALE 缺少授权范围 LIVESTREAM_SALE")));
});

test("CONDITIONAL 决定不能作为投产依据", async () => {
  const events = await chain();
  // 样品记录改挂到 v1 的附条件艺术决定。
  const sample = findEvent(events, "evt-sample-b001-verified");
  sample.payload.decision_id = "evt-review-aw01-v1-artistic";
  sample.payload.revision_no = 1;
  const errors = validateChain(events);
  assert.ok(errors.some((m) => m.includes("仅 APPROVED 决定可进入投产环节")));
});

test("样品哈希与获准版本不一致无法进入批次", async () => {
  const events = await chain();
  findEvent(events, "evt-batch-b001-released").payload.sample_hash = "sha256:tampered";
  assert.ok(validateChain(events).some((m) => m.includes("缺少与获准版本一致的 SAMPLE_VERIFIED")));
});

test("生产时间落在授权窗口外会被拦截", async () => {
  const events = await chain();
  findEvent(events, "evt-batch-b001-released").payload.produced_at = "2027-04-01";
  assert.ok(validateChain(events).some((m) => m.includes("不在授权")));
});

test("版本链必须连续且时间不倒流", async () => {
  const events = await chain();
  findEvent(events, "evt-design-aw01-v2").version = 9;
  assert.ok(validateChain(events).some((m) => m.includes("版本号须从 1 连续递增")));

  const events2 = await chain();
  findEvent(events2, "evt-design-aw01-v2").occurred_at = "2020-01-01T00:00:00+08:00";
  assert.ok(validateChain(events2).some((m) => m.includes("时间不得倒流")));
});

test("展览延期、权利到期、异议撤回均不得回写已生产批次", async () => {
  for (const id of ["evt-exh-extended", "evt-grant-aw01-expired", "evt-objection-withdrawn-001"]) {
    const events = await chain();
    findEvent(events, id).payload.mutates_batches = true;
    assert.ok(
      validateChain(events).some((m) => m.includes("不得声明回写已生产批次")),
      `${id} 应触发不可变约束`,
    );
  }
});

test("异议撤回必须引用原决定中真实存在的意见", async () => {
  const events = await chain();
  findEvent(events, "evt-objection-withdrawn-001").payload.withdrawn_opinion_ids = ["op-ghost"];
  assert.ok(validateChain(events).some((m) => m.includes("op-ghost 不在原决定")));
});

test("从未投产的批次不能被停售", async () => {
  const events = await chain();
  findEvent(events, "evt-channel-livestream-suspended").payload.batch_ids = ["batch-never-produced"];
  assert.ok(validateChain(events).some((m) => m.includes("从未投产，不能停售")));
});

test("局部停售只折叠该渠道状态，其他渠道保持在售且批次历史保留", async () => {
  const events = await chain();
  const [batch] = replayBatches(events);
  assert.equal(batch.batch_id, "batch-2027-001");
  assert.equal(batch.channels.LIVESTREAM_SALE, "SUSPENDED");
  assert.equal(batch.channels.ONLINE_RETAIL, "ACTIVE");
  assert.equal(batch.channels.OFFLINE_RETAIL, "ACTIVE");
  // 批次事实与停售事实都在历史中，抹除不发生。
  assert.deepEqual(batch.history.map((e) => e.event_type), ["BATCH_RELEASED", "CHANNEL_SUSPENDED"]);
});

test("售出商品可回查批次、获准版本、审校决定、授权与渠道状态", async () => {
  const events = await chain();
  const trace = traceSoldProduct(events, { batch_id: "batch-2027-001", channel_id: "LIVESTREAM_SALE" });
  assert.equal(trace.found, true);
  assert.deepEqual(trace.approved_revision, { design_id: "design-scarf-aw01", revision_no: 3 });
  assert.equal(trace.decision.decision, "APPROVED");
  assert.deepEqual(trace.grants[0].scopes.includes("LIVESTREAM_SALE"), true);
  assert.equal(trace.channel_status, "SUSPENDED");
  assert.equal(trace.suspension_history[0].event_id, "evt-channel-livestream-suspended");

  const offline = traceSoldProduct(events, { batch_id: "batch-2027-001", channel_id: "ONLINE_RETAIL" });
  assert.equal(offline.channel_status, "ACTIVE");

  assert.equal(traceSoldProduct(events, { batch_id: "nope", channel_id: "ONLINE_RETAIL" }).found, false);
});
