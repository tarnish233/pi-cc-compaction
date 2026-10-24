# pi-cc-compact

> 在 Pi 里复刻 Claude Code 的上下文压缩：摘要请求复用提示缓存，阈值和提示词与 Claude Code 一致，空闲时趁缓存未过期先压缩。

## 安装

```bash
pi install npm:pi-cc-compact
```

安装后执行 `/reload`。本地开发时把仓库软链接到扩展目录即可：

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-cc-compact
```

装上即接管压缩，`/compact`、自动压缩和超限恢复都走本包；不想用时 `/pi_cc compact off` 回到 Pi 自己的压缩。

## 功能

| 功能 | 说明 | 模块 |
| --- | --- | --- |
| 复用缓存的摘要 | 摘要请求 = 主对话最后一次请求原样 + 末尾一条摘要指令，读提示缓存而不是重读整段对话 | `fork.ts`、`compact.ts` |
| Claude Code 的阈值 | 自动压缩在 `窗口 − min(最大输出, 20K) − 13K` 触发（多数模型约 `窗口 − 33K`）；任何有两轮以上的会话都能 `/compact` | `patches.ts` |
| Claude Code 的提示词 | 九段式摘要（先 `<analysis>` 再 `<summary>`），`/compact <指令>` 作为 Additional Instructions；摘要带 Claude Code 的续接说明 | `prompt.ts` |
| 压缩后补回文件 | 重读最近读写过的 5 个文件（每个 ≤5K token，合计 ≤50K），太大的只留一句提示 | `restore.ts` |
| 空闲压缩 | 缓存有效期 ≥1 小时的模型，闲置到有效期的 90% 且上下文 ≥20 万 token 时先压缩 | `idle.ts` |
| 关闭缓存保温 | 空闲压缩开着时把 Pi 的 `cacheWarming` 设为 `off`，关掉空闲压缩时恢复原值 | `warming.ts` |

## 压缩怎么做

Pi 自带的压缩把对话转成纯文本、换一个 system prompt 单独发请求，前缀和主对话完全不同，读不到提示缓存。
Claude Code 则在原会话上分叉：system prompt、工具、消息、思考设置都不变，末尾加一条“请总结”，缓存标记留在主对话上次写缓存的位置，只读不写。

本包照 Claude Code 的做法：

1. **录下请求**：每次普通请求发出前，记下所有扩展处理完之后的最终请求体（包装 `ExtensionRunner.emitBeforeProviderRequest`，所以别的扩展改过的字段，比如 `cache-sticky` 加的 `metadata.user_id`，也在里面）。
2. **分叉请求**：压缩时把这份请求体原样发出，只在末尾追加摘要指令。思考强度、`max_tokens` 都沿用主请求。缓存热时几乎全部命中（实测免费模型 99.4%）。支持 `anthropic-messages`、`openai-completions`、`openai-responses` 三种 API。
3. **保留范围**：录下的请求之后新增的消息原样保留，相当于 Claude Code 保留的“最后一轮”；摘要里会注明这些消息摘要没看到。这一轮本身就达到阈值时（小窗口里的超大工具结果），一并总结、不保留。
4. **兜底**：分叉不可用（还没有请求、换了模型、API 不支持、超限恢复时请求本身就超了）或失败时，退回 Claude Code 的兜底：它的摘要 system prompt，对话以纯文本发出、工具结果截到 2000 字符。两条都失败，交还 Pi 自己的压缩，并提示一次。
5. **截断照收**：摘要被输出上限截断时照样采用，和 Claude Code 一样（Pi 自带的压缩会报 “generation hit the token cap”）。

缓存冷了也照样分叉，和 Claude Code 一致；空闲压缩会让这种情况很少出现。

## 空闲压缩

压缩读的是缓存前缀，缓存热时很便宜；缓存一过期，下一次请求就要为整段对话重新付费。所以闲置太久时，趁缓存还热先压掉。

- 缓存有效期取模型的 `promptCache`（Pi 的模型配置字段，Pi 的缓存保温也读它）：设了 `PI_CACHE_RETENTION=long` 用 `long` 档，否则用 `short` 档
- **有效期 ≥1 小时才启用**，和 Claude Code 一致；5 分钟缓存不做，否则每次稍微离开都会压缩
- 一轮结束后开始计时，在“上次请求 + 90% 有效期”时触发；触发时再确认：仍然空闲、没有排队消息、没有更新的请求、上下文 ≥20 万 token（`PI_CC_IDLE_COMPACT_MIN_TOKENS` 可调，最低 10 万）、没有迟到超过 1 分钟
- 默认开启；没有配 `promptCache`（或不到 1 小时）的模型不会触发

给模型配有效期，以 `~/.pi/agent/models.json` 里的自定义模型为例：

```json
{ "id": "claude-opus-5-5", "promptCache": { "short": 300, "long": 3600 } }
```

内置模型用 `modelOverrides` 配。Anthropic 的长缓存需要 `PI_CACHE_RETENTION=long`。

### 缓存保温

Pi 的缓存保温（`cacheWarming`）和空闲压缩作用于同一份缓存，有了空闲压缩也不再需要保温。所以：

- 空闲压缩开着时，本包把 `settings.json` 里的 `cacheWarming` 设为 `off`，原值记在 `pi-cc.json` 的 `idleCompactionSavedCacheWarming`（原来没写这个键就记为 `null`）
- `/pi_cc idle off`（或 `/pi_cc compact off`）时恢复原值；原来没写就删掉这个键，回到 Pi 的默认值。期间你手动改过 `cacheWarming` 的话，以你的为准，只删掉记录
- 改动通过 Pi 自己的 `SettingsManager` 写入（加文件锁、只合并这一个键），不影响其他设置；运行中的 Pi 同步生效
- **卸载前先执行 `/pi_cc idle off`**：直接卸载没有机会恢复保温设置

## /pi_cc

本包和 pi-cc-loop、pi-cc-monitor、pi-cc-plugins 共同提供 `/pi_cc`：pi-cc 家族的设置命令，装了几个包都只有一个。

- 本包的两项：**CC compaction**（`compaction`，默认开）和 **Idle compaction**（`idleCompaction`，默认开）；`/pi_cc compact on|off`、`/pi_cc idle on|off` 切换
- 切换即时生效，不用 `/reload`：阈值从下一次检查起变化，压缩从下一次起换回 Pi 的或本包的，保温当场关闭或恢复
- 空闲压缩依赖 CC compaction：后者关掉时前者也不生效，保温随之恢复
- 环境变量 `PI_CC_COMPACTION=0`、`PI_CC_IDLE_COMPACTION=0` 可临时覆盖，面板里相应项锁定

## 兼容性

- Pi 1.3.0 / 1.4.0
- 本包改动 Pi 内部的两个方法（`SettingsManager.getCompactionSettings`、`ExtensionRunner.emitBeforeProviderRequest`），每个进程只包装一次。Pi 升级后找不到它们时，本包会提示，压缩仍然可用（走兜底请求、用 Pi 的阈值）
- **只装一个压缩插件**：Pi 依次调用所有扩展的 `session_before_compact`，最后一个返回结果的生效，两个插件都生成摘要会付两份钱、前一份被丢弃

## 本地开发

```bash
node --test tests/*.test.mjs
npx --yes typescript@5.9.3 tsc --noEmit -p tsconfig.json
```

测试加载真实的 Pi 模块（在 Pi 自己的 `SettingsManager`、`ExtensionRunner` 上安装补丁，用 Pi 的 `SettingsManager` 读写临时目录里的 `settings.json`）。
测别的 Pi 版本时，把 `PI_AGENT_DIR` 指到只装了那个版本的目录（`<dir>/install/releases/<version>`）。测试不读写真实的 `~/.pi/agent`。

### 缓存约束

提示缓存按前缀匹配（工具 → system prompt → 消息）。本包只改它被要求的那次压缩，不改普通请求：
不注册 `before_agent_start` / `context` / `before_provider_request` 等会改请求的钩子；录请求的包装原样返回同一个请求体对象。
`tests/cache.test.mjs` 守住这一点。

## 与 Claude Code 的差异

- 提示词：Claude Code 从 8 个实验分支里选摘要提示词（服务端开关），这里固定用默认的 control 分支；工具列表换成 Pi 的小写工具名
- 补回的内容：Claude Code 还会补回 plan、已加载的技能、后台任务状态，Pi 没有对应的东西；补回的文件作为摘要正文的一部分（Pi 压缩后没有附件位置），措辞相同
- 超限恢复：Claude Code 按 API 返回的 token 缺口逐步多保留尾部、最后裁掉最早的历史；这里直接走兜底的纯文本请求（工具结果截短）
- 兜底请求：Claude Code 的兜底发原始消息，这里发纯文本（工具结果截短），超限时也放得下
- 不做的：后台预先算摘要、闲置后的服务端工具结果清理、`context_hint`，它们在 Claude Code 里默认关闭（服务端开关）

## 许可证

MIT。
