# 美术文创语境审校

本仓库保存美术文创语境审校的领域词汇、事件约定与基础校验代码，供相关单位统一对象身份、事件顺序和版本语义。

## 目录

- `contracts/domain.schema.json`：领域事件信封与稳定枚举（事件只允许追加，不得改动既有取值）。
- `data/sample.json`：单事件中文联调样例。
- `data/sample-chain.json`：完整版本链中文联调样例（冻结语境 → 授权 → 提案 → 附条件通过 → 改稿 → 异议撤回 → 渠道扩展重审 → 样品核对 → 投产 → 局部停售 → 授权到期 → 展览延期）。
- `src/validator.js`：事件信封校验、链级领域规则、合作方最小可见投影、重审范围计算、批次回放与售出回查。
- `tests/contract.test.js`：领域资料一致性与规则检查。

## 聚合与事件

| 聚合 | 事件 |
| --- | --- |
| `artwork_context` | `CONTEXT_FROZEN`：原作版本、策展阐释、可提取元素、禁用语境一次性冻结 |
| `exhibition` | `EXHIBITION_PUBLISHED` / `EXHIBITION_EXTENDED`：公布与延期（只追加事实） |
| `rights_grant` | `RIGHTS_CONFIRMED` / `RIGHTS_EXPIRED`：权利主体与复制/改编/宣传/直播销售范围，同聚合 version 递增形成授权快照 |
| `design_revision` | `DESIGN_SUBMITTED` / `DESIGN_RESUBMITTED` / `REVIEW_DECIDED` / `OBJECTION_WITHDRAWN` |
| `production_batch` | `SAMPLE_VERIFIED` / `BATCH_RELEASED`：投产前样品须与获准版本一致，批次固化设计版本、决定与授权快照 |
| `sales_channel` | `CHANNEL_SUSPENDED`：按渠道、按批次局部停售，历史不抹除 |

## 关键语义

1. **意见可引用**：`REVIEW_DECIDED` 取 `APPROVED / CONDITIONAL / REJECTED`，每条 opinion 必须锚定设计稿上的具体 `region_id`，并引用冻结元素、禁用语境、策展阐释或授权件作为依据；附条件通过须列明条件。
2. **重审范围计算**：`computeReassessment` 按四个变更面给出需要重审的审种——材质/尺寸→艺术，文案→艺术+权利，**新增**渠道→权利（直播销售额外要求 `LIVESTREAM_SALE` 授权）；仅移除渠道不产生重审义务。未触及的审种沿用上一版本结论（如只加渠道时艺术审校不重审）。
3. **投产闸门**：只有 `APPROVED` 决定可投产；改稿版本须在各审种最近一次到期的版本上有通过；批次须有哈希一致的 `SAMPLE_VERIFIED`，且生产时间落在授权窗口内、渠道与授权范围匹配。
4. **历史不可变**：展览延期、权利到期、异议撤回均为追加事件，不得回写已生产批次（payload 出现 `mutates_batches: true` 直接判错）；问题渠道只能 `CHANNEL_SUSPENDED`。
5. **合作方最小可见**：`projectForPartner(events, partnerId)` 只返回本方授权、本方设计/审校/批次与已公布作品的冻结语境；未公布展览、其他艺术家合同不串出；跨方停售事件按 `batch_ids` 裁剪后只露本方批次。
6. **售出回查**：`traceSoldProduct` 从批次回查获准设计版本、审校决定、当时生效的授权快照与该渠道停售历史；`replayBatches` 折叠各渠道在售状态并保留完整事实链。

## 本地检查

```bash
npm test
```
