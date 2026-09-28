# 把 ZCode 订阅暴露为本地 API 服务(zcode-ai-proxy 技术文档)

> 目标读者:想把外部 harness / 工具链接到 ZCode 模型套餐上的开发者。
> 核心产物:`tools/zcode-ai-proxy.mjs`(约 100 行,零依赖)。
> 实测状态:已验证端到端可用(见 §5)。

---

## 1. 背景与原理

ZCode 桌面端的模型订阅(bigmodel coding-plan)**并不暴露 OpenAI 风格的 API**。它的真实形态是:

```
~/.zcode/cli/config.json
{
  "provider": {
    "builtin:bigmodel-coding-plan": {
      "kind": "anthropic",                     ← Anthropic 兼容协议
      "options": {
        "apiKey": "<套餐专属 Key>",             ← 本机明文存放
        "baseURL": "https://open.bigmodel.cn/api/anthropic"
      }
    }
  },
  "model": { "main": "builtin:bigmodel-coding-plan/GLM-5.3-Flash" }
}
```

要点:
- **协议**:Anthropic Messages API(`/v1/messages`),鉴权头是 `x-api-key`(不是 OpenAI 的 `Authorization: Bearer`);
- **凭据**:Key 明文存在本机 `~/.zcode/cli/config.json`,任何本地进程都能读;
- **额度**:该 Key 直接消耗 ZCode 订阅套餐,不需要单独充值/购买 API 包。

而绝大多数外部工具(harness、Chrome 扩展、脚本)说的是 **OpenAI Chat Completions** 方言。两者不兼容,直接对接不可行。

**解法**:在本机跑一个极薄的**协议转换代理**:

```
外部 harness / 扩展                zcode-ai-proxy (127.0.0.1:8787)          智谱 Anthropic 端点
────────────────────               ─────────────────────────────           ──────────────────
POST /v1/chat/completions   ──►   读 config.json 取 baseURL/apiKey
{ model, messages[], ... }        OpenAI 请求体 ──转换──► Anthropic 请求体   ──►  POST {baseURL}/v1/mess···
                                    (system 拆分、role 过滤、                   x-api-key: <套餐Key>
                                     max_tokens 补默认)                        anthropic-version: 2023-06-01
                            ◄──   Anthropic 响应 ──反向转换──► OpenAI 响应  ◄──  { content[], usage{} }
{ choices[], usage{} }              (content 拼接、usage 字段映射)
```

订阅就这样被"暴露为服务"了:**不做任何账号共享或转售,只是本机进程间的一个格式适配器**。

## 2. 快速开始

```bash
# 1) 启动(自动读取 ~/.zcode/cli/config.json,密钥不出本机)
node tools/zcode-ai-proxy.mjs            # 默认 127.0.0.1:8787,可用参数改端口

# 2) 冒烟测试
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.3-Flash","messages":[{"role":"user","content":"hello"}],"max_tokens":2048}'

# 3) 任何 OpenAI 兼容 harness 只需配置
#    base_url = http://127.0.0.1:8787/v1
#    api_key  = 任意非空字符串(代理不校验,凭据由代理内部注入)
#    model    = GLM-5.3-Flash(ZCode config.json 的 model.main 去掉 "builtin:.../" 前缀)
```

## 3. 接口契约(供 harness 对接)

### 3.1 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 唯一业务端点,OpenAI 请求/响应格式 |
| GET | `/v1/models` | 返回单元素模型列表(便于 harness 的"列模型"探测) |
| 其他 | — | 404 |

### 3.2 请求字段(OpenAI 格式 → 实际行为)

| OpenAI 字段 | 代理行为 |
|---|---|
| `model` | **原样透传**给上游。需用智谱真实模型名(如 `GLM-5.3-Flash`),`gpt-*` 之类不可用 |
| `messages` | `system` 角色合并为 Anthropic `system` 参数;`user`/`assistant` 映射为 `messages` |
| `max_tokens` | 透传;**缺省补 2048**(Anthropic 必填,OpenAI 可省) |
| `temperature` | 透传 |
| `stream` | ⚠️ **未实现**,请保持 false(见 §6 局限) |
| `tools` / `tool_choice` | ⚠️ **未转换**,依赖函数调用的 harness 暂不可用 |
| 其他字段(`top_p`、`n`、`stop` 等) | 忽略 |

### 3.3 响应字段(Anthropic → OpenAI 映射)

| 上游(Anthropic) | 代理返回(OpenAI) |
|---|---|
| `content[{type:"text",text}]` | `choices[0].message.content`(多段 text 直接拼接) |
| `stop_reason` | `choices[0].finish_reason`(固定 "stop") |
| `usage.input_tokens / output_tokens` | `usage.prompt_tokens / completion_tokens / total_tokens` |
| `id` | `id` |

### 3.4 鉴权

- **代理本身不校验调用方 Key**:监听 127.0.0.1,外部机器不可达;harness 填任意非空 Key 即可;
- 真正的凭据在代理内部注入(`x-api-key: <config.json 里的套餐 Key>`),**不出代理进程**。

## 4. 关键实现细节(踩过的坑)

1. **max_tokens 必填**:Anthropic 协议强制要求。不补默认值会 4xx。实测中 GLM 的"思考型"输出会先消耗思考 token——`max_tokens: 32` 这类小值会得到 `content: ""`(32 个 token 全是思考,没轮到正文)。**建议 ≥2048**。
2. **system 位置差异**:OpenAI 的 system 是 `messages` 里的一个角色;Anthropic 是顶层 `system` 字段。不拆分会导致模型把系统提示当对话内容。
3. **凭据读取时机**:代理启动时读一次 `config.json`。ZCode 换号/换套餐后需重启代理。
4. **模型名映射**:ZCode 配置里的 `builtin:bigmodel-coding-plan/GLM-5.3-Flash` 是"provider/模型"复合 ID;调上游时只传模型名部分。
5. **编码**:Windows Git Bash 里 curl 中文 body 可能以 GBK 发出导致上游收到乱码(实测踩过);harness 走 HTTP 库发 UTF-8 无此问题。
6. **请求头二选一**:智谱 Anthropic 端点用 `x-api-key`;如果未来切换到 OpenAI 兼容上游,改成 `Authorization: Bearer` 一行即可(转换层已隔离此差异)。

## 5. 验证记录(2026-09-28)

```
启动:zcode-ai-proxy 监听 http://127.0.0.1:8787/v1/chat/completions
调用:POST {"model":"GLM-5.3-Flash","messages":[{"role":"user","content":"回复两个字:成功"}],"max_tokens":2048}
返回:200 OK,content 含模型回复,usage {prompt_tokens:20, completion_tokens:894, total_tokens:914}
结论:套餐端点 + 协议转换端到端可用;completion_tokens 偏大是 GLM 思考 token 计入所致
```

同一代理已在"简历闪填"扩展上实测:插件「AI 设置」填 `http://127.0.0.1:8787/v1/chat/completions` 即用套餐跑通 AI 字段规划。

## 6. 局限与边界(如实说明)

- **不支持流式**:未实现 SSE 转换。交互式 UI 类 harness 需要 stream 的话要自行扩展(`stream:true` 的 OpenAI chunk ↔ Anthropic `message_start/content_block_delta` 事件流,约 60 行)。
- **不支持函数调用**:OpenAI `tools` → Anthropic `tools` 的 schema 转换未做。Agent 型 harness 若依赖 tool-call 协议,需要加这一层。
- **单上游**:一次只读一个 provider 条目(取 config.json 里第一个带 baseURL+apiKey 的)。
- **无并发控制/重试**:上游 429/5xx 原样透传给调用方。
- **仅限本机**:监听 127.0.0.1 是刻意的——把订阅转发给局域网/公网等于共享账号,不要改。
- **额度即套餐额度**:经此代理的每一次调用都消耗 ZCode 订阅,与在 ZCode 里对话共享同一池子。

## 7. 外部 harness 接入清单

1. `node tools/zcode-ai-proxy.mjs` 起服务(开机自启可自行注册任务计划);
2. harness 的模型配置三件套:`base_url=http://127.0.0.1:8787/v1`、`api_key=placeholder`、`model=GLM-5.3-Flash`;
3. 确认 harness 不依赖 `stream` 与 `tools`(依赖则先扩代理,见 §6);
4. 跑一次最小请求确认 `usage` 有值(即套餐通道真实计费成功);
5. 观察代理控制台的 `[proxy] 上游错误` 行可快速定位 4xx/5xx 归属。
