# 交接文档 — dsh-copilot

## 1. 项目是什么

把 GitHub Copilot 包装成 OpenAI 兼容接口，接入 DeepSeek Harness，并规划一个 Copilot 用量中心。

- 仓库：https://github.com/nikomao/dsh-copilot
- 本地：/Users/Niko.Mao/Documents/deepseek-harness/default-workspace/codes/dsh-copilot
- 版本：0.1.0，MIT

## 2. 当前状态

已完成：

- 直连模式：POST /v1/responses → Copilot Responses API，首 token 约 2s，支持流式、tools（function calling）、图片
- CLI 回退模式：POST /v1/chat/completions → copilot CLI 子进程，约 10s，禁用 shell/write/edit 工具
- 授权：OAuth 设备码流程获取 ghu_ token，桥接自动换 Copilot 短效 token（约 24h，到期前刷新）
- 额度：GET /v1/quota（business，剩余约 7796 / 8000，重置 2026-12-01）
- 用量：GET /v1/usage，流水写入 .usage/usage.jsonl（含 token、credits、ttft、status）
- DSH 接入：copilot-api provider 已写入 cordis.patch.yml，用户已在使用（3s 级响应）

未完成（下一阶段 M1）：

- DSH 插件 Tab（概览 / 模型 / 会话三页）
- credit 单位标定
- 打包成 dsh plugin bundle

## 3. 运行环境

- 服务：node server.mjs，监听 127.0.0.1:17866
- 自启：LaunchAgent label com.local.copilot-bridge
- plist：~/Library/LaunchAgents/com.local.copilot-bridge.plist
- 日志：~/Library/Logs/copilot-bridge.log
- 代理：LaunchAgent 注入 HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:7897
- token：.auth/gh-token.json（600，gitignore）
- 流水：.usage/usage.jsonl（gitignore）

常用命令：

    launchctl print gui/$(id -u)/com.local.copilot-bridge | head -20
    launchctl kickstart -k gui/$(id -u)/com.local.copilot-bridge
    launchctl bootout gui/$(id -u)/com.local.copilot-bridge
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.copilot-bridge.plist

验证：

    curl -s http://127.0.0.1:17866/health
    curl -s http://127.0.0.1:17866/v1/quota
    curl -s 'http://127.0.0.1:17866/v1/usage?range=1h'

## 4. DSH 配置

文件：~/.dsh/profiles/desktop/cordis.patch.yml，条目 id llm-pi-ai。

providers 下有两个：

- copilot-api：api openai-responses，baseURL http://127.0.0.1:17866/v1，13 个模型，apiKeyEnv COPILOT_BRIDGE_TOKEN
- copilot：api openai-completions，CLI 回退用

注意：

- apiKeyEnv 只是满足 pi-ai 的校验，桥接不校验，凭据库里 COPILOT_BRIDGE_TOKEN 是占位值
- 改完配置必须重启 DSH
- 脚本 apply-provider.py 可重复执行（已存在会跳过）

## 5. 关键设计决策

- 为什么直连：CLI 每次冷启动约 2.4s + 首 token 约 7s，总计约 10s；直连走和 VS Code 相同的后端链路，约 2s
- prompt 通过 stdin 传给 CLI：旧版把 prompt 放进 -p 参数，740KB 上下文会超过 argv 上限导致空响应
- 空输出不再返回 200：改为 502 并带 stderr，避免"成功但没内容"
- 不传 --allow-all-tools：CLI 模式禁用 shell/write/edit，避免提示词注入执行命令
- token 存储：GitHub token 存 .auth，Copilot 短效 token 只在内存缓存

## 6. 已知问题

- credit 单位未标定：quota 的 credits_used 是整数（如 204），桥接按 copilot_usage.total_nano_aiu / 1e9 算出单次约 0.007，两者量级关系待用真实账单校准
- Claude 不可用：Copilot 目录 33 个模型里没有 Anthropic，账号/租户层面问题
- Gemini 3.8 Flash / 4 Argon 只支持 /chat/completions，只能走 CLI provider
- 会话归因未实现：/v1/usage 只有请求级数据，没有 DSH session 归属
- 设备码授权过期或换号时需要重新授权
- .usage 里有少量测试数据，可清空

## 7. 下一步（M1）

1. 插件 bundle 骨架（dsh plugin add），注册 Copilot Tab
2. 概览页消费 /v1/quota + /v1/usage
3. 模型页消费 /v1/models
4. 会话页做时间窗归因（桥接流水 + DSH 会话事件）
5. 校准 credit 系数，写回 README

## 8. 安全

- .auth/ 与 .usage/ 不进仓库
- token 文件权限 600
- 不要把 17866 暴露到公网
- 日志和截图里不要带 token
