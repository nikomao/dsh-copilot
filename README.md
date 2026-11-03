# copilot-bridge — 把 GitHub Copilot 接到 OpenAI 兼容接口

一条本地 HTTP 服务，把 GitHub Copilot 的模型能力包装成 OpenAI 兼容接口，让 DeepSeek Harness（或任何 OpenAI 兼容客户端）可以把 Copilot 当成一个模型提供方。

目前有两条链路：

| 模式 | 端点 | 延迟 | 能力 |
| --- | --- | --- | --- |
| **直连**（推荐） | POST /v1/responses | 首 token ~2s | 真流式、真 function calling、图片 |
| CLI 回退 | POST /v1/chat/completions | 每次 10s 左右 | 纯文本，工具被禁用 |

直连模式用 GitHub OAuth token 换取 Copilot 短效 token，直接把请求转发到 Copilot 后端（和 VS Code 扩展同一条链路），不再为每个请求启动 CLI 进程。

## 架构

    DSH / 任意 OpenAI 客户端
            │  OpenAI 兼容协议
            ▼
    copilot-bridge :17866
            │
            ├── /v1/responses ──► api.<proxy>.githubcopilot.com   (直连, 快)
            └── /v1/chat/completions ──► copilot CLI 子进程        (回退)

## 前置条件

- Node.js >= 18（使用内置 fetch，无需第三方依赖）
- 一个已开通 Copilot 的 GitHub 账号
- 直连模式需要该账号的 OAuth token（见「授权」）；CLI 回退模式需要 copilot 已登录

## 授权（直连模式）

桥接需要一份带 Copilot 权限的 GitHub OAuth token（ghu_ 开头）。经典 PAT（ghp_）会被 Copilot 后端拒绝。

推荐用 OAuth 设备码流程获取（与 copilot.vim 相同的官方 client id）：

1. 申请设备码：

       curl -s https://github.com/login/device/code \
         -H 'Accept: application/json' \
         -d 'client_id=Iv1.b507a08c87ecfe98&scope=read:user'

2. 浏览器打开返回的 verification_uri，输入 user_code 并授权（必须是开通了 Copilot 的账号）。

3. 轮询换 token：

       curl -s https://github.com/login/oauth/access_token \
         -H 'Accept: application/json' \
         -d 'client_id=Iv1.b507a08c87ecfe98' \
         -d "device_code=<上一步的 device_code>" \
         -d 'grant_type=urn:ietf:params:oauth:grant-type:device_code'

4. 返回的 access_token 写入（文件权限 600）：

       {"access_token": "ghu_xxx"}

   路径：copilot-bridge/.auth/gh-token.json

桥接启动时用这个 token 调 api.github.com/copilot_internal/v2/token 换取 Copilot 短效 token（约 24h 有效，到期前自动刷新），并从返回的 proxy-ep 推导真实 API 域名（个人版 / 企业版不同）。

## 启动

    cd copilot-bridge
    node server.mjs
    # 监听 http://127.0.0.1:17866

或使用已安装的 LaunchAgent（登录自启、退出自动拉起）：

    # 状态
    launchctl print gui/$(id -u)/com.local.copilot-bridge | head -20

    # 重启
    launchctl kickstart -k gui/$(id -u)/com.local.copilot-bridge

    # 停止并取消自启
    launchctl bootout gui/$(id -u)/com.local.copilot-bridge

日志：~/Library/Logs/copilot-bridge.log

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| PORT | 17866 | 监听端口 |
| HOST | 127.0.0.1 | 监听地址 |
| COPILOT_BIN | copilot | CLI 可执行文件 |
| BRIDGE_TIMEOUT_MS | 240000 | CLI 单次请求超时 |
| BRIDGE_CONCURRENCY | 2 | CLI 并发进程上限 |
| BRIDGE_AUTH_TOKEN | 空 | 设置后要求 Bearer 鉴权 |
| BRIDGE_WORKDIR | 系统临时目录 | CLI 工作目录（建议空目录） |
| BRIDGE_DENY_TOOLS | shell,write,edit | 传给 CLI 的 --deny-tool 列表 |
| BRIDGE_MODELS | 空 | 追加 CLI 模型 id，逗号分隔 |
| BRIDGE_MODELS_FILE | ./models.json | 追加模型列表的 JSON 文件 |
| BRIDGE_GH_TOKEN_FILE | .auth/gh-token.json | GitHub OAuth token 文件，存在即启用直连 |
| BRIDGE_DEBUG | 0 | 设为 1 输出调试日志 |

## 接口

- GET /health：健康检查，返回当前 CLI 模型列表
- GET /v1/models：模型列表。直连可用时返回 Copilot 真实目录（含 endpoints、上下文长度、最大输出），否则返回本地配置列表
- POST /v1/responses：直连转发到 Copilot Responses API，支持 stream、tools、图片
- POST /v1/chat/completions：CLI 回退模式，支持 stream: true/false
- GET /v1/quota：额度快照（plan、重置日、premium_interactions 剩余/已用），缓存 5 分钟
- GET /v1/usage?range=7d：用量聚合（summary、by_day、by_model、recent），range 支持 1h/7d/30d/today/all

模型 id 以 /v1/models 为准。CLI 回退模式额外支持 default（不传 --model）和 auto（自动路由）。

## 用量与额度

桥接会在每次请求结束后写一条流水到 .usage/usage.jsonl（已 gitignore），字段包括：

    ts, id, mode(direct|cli), model, stream, tools, body_bytes,
    input_tokens, output_tokens, cached_tokens, credits, credits_raw,
    ttft_ms, duration_ms, status, ok

credit 数值取自 Copilot 响应的 copilot_usage.total_nano_aiu / 1e9（非流式在 JSON 顶层，流式在 response.completed 事件里）。

- 额度来源：GET /v1/quota 代理 api.github.com/copilot_internal/user 的 quota_snapshots
- 当前账号额度以 premium_interactions 为准（chat / completions 为 unlimited）
- credit 单位换算是估算，若与 GitHub 后台存在偏差，可在 .usage 数据上按比例校正

示例：

    curl -s http://127.0.0.1:17866/v1/quota

    curl -s 'http://127.0.0.1:17866/v1/usage?range=7d'

## 接到 DeepSeek Harness

DSH 内置 OpenAI 兼容网关适配器（@deepseek-ai/dsh-llm-pi-ai），不需要改源码，只需在 ~/.dsh/profiles/desktop/cordis.patch.yml 的 llm-pi-ai 条目下加 provider。

推荐用脚本自动写入（会备份并校验 YAML）：

    cd copilot-bridge
    python3 apply-provider.py

脚本从 /v1/models 读取真实上下文长度，生成 copilot-api provider（api: openai-responses）。

手动配置示例：

    providers:
      copilot-api:
        displayName: GitHub Copilot (直连)
        apiKeyEnv: COPILOT_BRIDGE_TOKEN
        api: openai-responses
        baseURL: http://127.0.0.1:17866/v1
        models:
          - id: gpt-6.1-sol
            name: GPT-6.1 Sol
            contextWindow: 400000
            maxTokens: 128000
            input: [text, image]
          - id: gpt-6-luna
            name: GPT-6 Luna
            contextWindow: 200000
            maxTokens: 64000
            input: [text, image]

注意：

- apiKeyEnv 必须指向一个存在的凭据引用（桥接不校验，值可以是占位符），否则 pi-ai 会报 No API key for provider；
- 直连 provider 的 api 必须是 openai-responses，CLI provider 才用 openai-completions；
- 改完重启 DSH，配置由 cordis loader 在启动时加载；
- 旧的 copilot（CLI）provider 可以保留作回退。

## 模型与限制

- 直连目录当前 33 个模型，其中 13 个支持 /responses（GPT 系列、Grok、MAI）；
- Gemini 3.8 Flash / 4 Argon 只支持 /chat/completions，需走 CLI provider 或另行直连 chat 端点；
- 模型目录里没有任何 Anthropic 模型，Claude 是否可用取决于账号/租户，桥接无法绕过；
- 非官方本地封装：请求计入你的 Copilot 配额，请自行确认符合 GitHub 使用条款，不要把服务暴露到公网；
- 直连 token 存储在 .auth/gh-token.json（600），请勿提交到版本库或分享。

## 排障

| 现象 | 处理 |
| --- | --- |
| DSH 里 10s+ 才出字 | 选成了 GitHub Copilot (CLI) provider；改用 (直连) |
| No API key for provider: copilot | provider 缺 apiKeyEnv，或凭据引用不存在 |
| 直连返回 401/503 | token 失效：重新走设备码流程，替换 .auth/gh-token.json |
| model "x" is not accessible via the /chat/completions endpoint | 该模型只支持 /responses，不要用 CLI provider 的 chat 端点 |
| CLI 返回空内容 | 查看 ~/Library/Logs/copilot-bridge.log；空输出会以 502 返回并带上 stderr |
| 端口占用 | 日志出现 EADDRINUSE，先停掉旧进程 |
| 大上下文请求失败 | 旧版把 prompt 塞进命令行参数会超限；现已改为 stdin，直连模式不受影响 |

## 文件

| 文件 | 说明 |
| --- | --- |
| server.mjs | 桥接服务（无第三方依赖，直连 + CLI 回退） |
| apply-provider.py | 把直连 provider 写入 DSH 配置（带备份与校验） |
| models.json | CLI 回退模式追加的模型 id |
| .auth/gh-token.json | GitHub OAuth token（600，不提交） |
| package.json | ESM 包定义 |

## 文档

- [产品规划：Copilot 用量中心](docs/PRD-copilot-usage.md)

## 项目结构

    .
    ├── server.mjs              # 桥接服务（直连 + CLI 回退）
    ├── apply-provider.py       # 写入 DSH 配置（备份 + 校验）
    ├── models.json             # CLI 回退模式追加模型
    ├── docs/PRD-copilot-usage.md
    └── .auth/                  # 本地 token（已 gitignore）

## 贡献

欢迎 issue / PR。提交前请确认：

- .auth/ 不要提交；
- 改动 apply-provider.py 时保持备份与 YAML 校验逻辑；
- 新增端点请同步 README 的接口表。

## License

MIT
