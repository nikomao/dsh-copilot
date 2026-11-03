# PRD: Copilot Usage — Copilot 用量中心

## 1. 定位

DSH 里的 Copilot 用量与成本控制台：一个 Tab 回答四件事——能用哪些模型、花了多少 credit、还剩多少、哪次会话最烧钱。

## 2. 数据基础（已验证）

| 数据 | 来源 | 字段 |
| --- | --- | --- |
| 额度与剩余 | api.github.com/copilot_internal/user | quota_snapshots.premium_interactions: percent_remaining、quota_remaining、credits_used、overage_permitted、quota_reset_date |
| 每次请求花费 | Responses 响应的 copilot_usage | token_details[]: 模型 / token 类型 / token_count / cost_per_batch |
| 真实 token 数 | 响应 usage | input_tokens、output_tokens、cached_tokens |
| 模型目录 | /models | vendor、supported_endpoints、上下文长度、最大输出、policy、preview |

当前账号：business 套餐，额度周期至 2026-12-01，总量约 8000 credits。

## 3. 信息架构

Tab 内 5 页：

1. 概览：额度环形、今日/本月数字、趋势图、按模型占比、最近请求
2. 模型：目录表格（名称/厂商/能力/上下文/费率/状态），搜索与排序
3. 用量：日/周/月，按模型堆叠，token 与 credit 双轴，导出 CSV
4. 会话：会话列表（标题/模型/turn 数/credit/时长），钻取每轮明细
5. 设置：token 状态与重新授权、刷新频率、告警阈值、数据保留

## 4. 功能优先级

P0（MVP）

- 额度卡片：剩余 credit、百分比、重置日、plan
- 模型列表：真实目录 + 费率 + 可用性
- 请求流水：时间、模型、token、credit、延迟、状态
- 会话聚合：按会话归因、Top 花费
- 概览 7 天趋势

P1

- 实时刷新与角标
- 预算告警（剩余 <20%、单会话 >50 credit、月度预测超支）
- 模型对比与替代建议
- 导出 CSV
- 延迟 P50/P95、错误率、缓存命中率

P2

- 月末预测
- 多账号 / 团队汇总
- 按项目分账
- 与 DSH 会话页双向跳转

## 5. 技术方案

桥接侧：

- GET /v1/quota：代理 copilot_internal/user，缓存 5 分钟
- GET /v1/usage?range=7d：从 SQLite 聚合
- /v1/responses 完成后写流水：ts, model, input, output, cached, credits, ttft, duration, status, request_id
- credit 换算：sum(token_count / batch_size * cost_per_batch) / SCALE，首次标定

插件侧：

- DSH plugin bundle，注册 Copilot Tab
- 前端只读桥接 API，不直接接触 token
- 会话归因：MVP 用时间窗 + 模型匹配；v1.1 注入会话头

## 6. 里程碑

| 阶段 | 时间 | 交付 |
| --- | --- | --- |
| M0 | 1~2 天 | /v1/quota + 流水落库 + /v1/usage |
| M1 | 1 周 | Tab MVP：概览、模型、会话 |
| M2 | 2 周 | 告警、导出、延迟指标、深色适配 |
| M3 | 4 周 | 预测、模型建议、会话深链、多账号 |

## 7. 成功指标

- 打开率：周活用户 ≥40% 打开过 Tab
- 准确率：额度与 GitHub 后台误差 <1%
- 归因准确率：会话 credit 误差 <5%
- 延迟可视化覆盖率 100%

## 8. 风险

| 风险 | 应对 |
| --- | --- |
| copilot_internal/* 非公开，可能变 | 全部走桥接适配层，缺失字段降级显示 |
| credit 单位换算 | 首次标定 + 设置页允许手动修正 |
| 重试重复计数 | request_id 去重 |
| 隐私 | 只存元数据，不落 prompt 内容 |
