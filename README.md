# pi-cc-compaction

> 在 Pi 里复刻 Claude Code 的上下文压缩：摘要请求复用提示缓存，阈值和提示词与 Claude Code 一致，空闲时趁缓存未过期先压缩。

## 安装

```bash
pi install npm:pi-cc-compaction
```

安装后执行 `/reload`。本地开发时把仓库软链接到扩展目录即可：

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-cc-compaction
```

装上即接管压缩：`/compact`、自动压缩和超限恢复，只要能读到提示缓存就走本包；读不到缓存的情况（见下文）交给 Pi 自己的压缩；空闲时在缓存过期前先压缩。不动 Pi 的缓存保温。不想用时 `/pi_cc compact off` 完全回到 Pi。

## 功能

| 功能 | 说明 | 模块 |
| --- | --- | --- |
| 复用缓存的摘要 | 摘要请求 = 主对话最后一次请求原样 + 末尾一条摘要指令，读提示缓存而不是重读整段对话 | `fork.ts`、`compact.ts` |
| Claude Code 的阈值 | 自动压缩在 `窗口 − min(最大输出, 20K) − 13K` 触发（多数模型约 `窗口 − 33K`）；任何有两轮以上的会话都能 `/compact` | `patches.ts` |
| Claude Code 的失败处理 | 失败就取消并给出 Claude Code 的提示，不换算法；唯一例外是回复里没有可用 `<summary>`：先按更严格的口吻重问一次，仍不行才交给 Pi 自己的压缩 | `compact.ts`、`fork.ts`、`breaker.ts` |
| Claude Code 的提示词 | 九段式摘要（先 `<analysis>` 再 `<summary>`），`/compact <指令>` 作为 Additional Instructions；摘要带 Claude Code 的续接说明；解析也照 2.1.316 的读法（先丢第一块 analysis，再取 summary 正文） | `prompt.ts` |
| 压缩后补回文件 | 最多补回 5 个已确认成功的文件上下文：直接 read 复用已返回片段（每个 ≤5K token，合计 ≤50K）；写改和脚本调用只留路径引用，不自行重读 | `restore.ts` |
| 空闲压缩 | 缓存有效期 ≥1 小时的模型，闲置到有效期的 75%（1 小时缓存即 45 分钟）且上下文 ≥10 万 token 时先压缩 | `idle.ts` |
| 压缩提示 | 每次压缩后说明是本包还是 Pi 压缩的，交给 Pi 时写明原因 | `compact.ts` |

## 压缩怎么做

Pi 自带的压缩把对话转成纯文本、换一个 system prompt 单独发请求，前缀和主对话完全不同，读不到提示缓存。
Claude Code 则在原会话上分叉：system prompt、工具、消息、思考设置都不变，末尾加一条“请总结”，缓存标记留在主对话上次写缓存的位置，只读不写。

本包照 Claude Code 的做法：

1. **记下请求**：每次普通请求发出前，记下所有扩展处理完之后的最终请求体（包装 `ExtensionRunner.emitBeforeProviderRequest`，所以别的扩展改过的字段，比如 `cache-sticky` 加的 `metadata.user_id`，也在里面）。记的是 Pi 发出的那个对象本身，不复制：Pi 每次请求都新建请求对象，发出后它和 SDK 都不再修改它（已核对 Pi 1.3.0 / 1.4.0 的代码，并在三种 API 上实测）。只有拿到成功回复后，这次请求才成为分叉的起点；出错的请求（比如超限）没有写缓存，起点仍是上一次成功的请求。每个会话只留这一份，会话结束即释放，不写硬盘。
2. **分叉请求**：压缩时把这份请求体原样发出，只在末尾追加摘要指令。思考强度、`max_tokens` 都沿用主请求。缓存热时几乎全部命中（实测三种 API 都在 95% 以上，剩下的是摘要指令本身）。支持 `anthropic-messages`、`openai-completions`、`openai-responses`。
3. **保留范围**：分叉起点之后新增的消息原样保留，相当于 Claude Code 保留的“最后一轮”；摘要里会注明这些消息摘要没看到。
4. **超限恢复**：超限的那次请求没有回复，分叉起点自然是它前一次成功的请求：放得下（Pi 发它时已给输入加输出留了余量），缓存也是热的。超限的那一轮原样保留，压缩后 Pi 自动重发。极少数情况下摘要请求仍报超长，只调低这次请求的输出上限重试一次，缓存前缀不变。
5. **按 CC 的读法解析**：和 Claude Code 2.1.316 一样——先去掉回复里第一块 `<analysis>…</analysis>`，再取 `<summary>…</summary>` 的正文；被输出上限截断、只剩未闭合 `<summary>` 的回复也算摘要。**不猜引号或代码围栏**：模型把格式示例写进围栏里，CC 会照收，本包也照收（第一个 `</summary>` 截断，示例会压过后面真正的摘要）。和 CC 的两点差异：CC 把"整段去掉 analysis 后的文本"都存成摘要，本包只存 `<summary>` 块内正文；CC 的空块也算摘要，本包不算（另一个收紧是不接受只有散文、没有标签的回复）。没有摘要时**先在末尾追加一条更严格的追问重问一次**（Anthropic 的消息会并进最后一条 user turn，缓存前缀不变），仍不行才把这次压缩交给 Pi 自己的实现，提示里写明原因和那段回复的首尾（网络错误和超限重试仍照旧）。
6. **记下模型**：Pi 的压缩记录本身不写模型，本包在记录的 `details` 里写上做摘要的 `provider`、`model`（以及 `responseModel`，若有），字段名和 Pi 回复消息上的一致，读会话日志的用量工具可以据此认出模型。

### 文件恢复与权限

补回片段必须同时出现在**当前会话投影和最后成功请求的同 ID 工具结果**中；只取两边共同保留的文本，无法确认已经发送或脱敏版本不一致时只留引用。不调用 `fs.readFileSync`，也不检查或跟随当前磁盘上的文件、符号链接。片段明确标为历史缓存，文件可能已修改或删除；要看当前内容，仍需通过正常的 read 工具及权限检查。

- 调用必须与成功的工具结果匹配；失败、被拒绝、未完成或状态不明的调用不补回。后续失败/拒绝的同路径调用也会挡住此前片段
- edit、write 和成功的 codemode 内部调用没有可对应的 read 结果，只补路径引用；不会根据脚本参数重新读取文件
- 只复用模型可见的 `content`，不从 `structuredContent` 或图片数据重建正文，保留已有结果脱敏

### 是谁压缩的

每次压缩完成，Pi 的 `[compaction]` 框下面多一行，说明这次是谁做的：

| 提示 | 含义 |
| --- | --- |
| `Compacted by pi-cc-compaction` | 本包分叉压缩，读缓存 |
| `Compacted by Pi's own compaction · <原因>` | 读不到缓存，交给了 Pi 自己的压缩，原因见下表 |
| `Compacted while idle, before the prompt cache expired · …` | 本包的[空闲压缩](#空闲压缩) |

`/pi_cc compact off` 时压缩都是 Pi 的，不加这一行。

### 读不到缓存时：交给 Pi

以下情况任何请求都读不到缓存，压缩交给 Pi 自己的压缩，压缩后的提示里写明原因：

| 情况 | 原因 |
| --- | --- |
| 本会话还没有成功的请求 | 刚启动或恢复会话，还没发过请求 |
| 上次请求用的是别的模型或 provider | 缓存按模型、按 provider 分开 |
| 缓存已过期 | 距上次请求已超过缓存有效期（有效期怎么定见[空闲压缩](#空闲压缩)）；有效期未知的无从判断，照常分叉 |
| 三种 API 以外的 provider | 无法在请求末尾追加一轮 |

这个判断在 Pi 读取压缩设置时就做出：能分叉才把 `keepRecentTokens` 设为 1；不能分叉就保持 Pi 原值，Pi 按它自己的设置决定保留什么、要不要压缩。

`/reload` 不丢已捕获的请求：会话还在继续，捕获和熔断状态都保留，空闲压缩也会重新布防（空闲时重载不会再有新回合来布防它），重载后第一次压缩照常分叉。但会话中途才装上本包时，之前的回合没有被捕获过，第一次压缩仍交给 Pi，跑完一轮后自动恢复。

### 失败时：照 Claude Code，不换算法

- 网络中断、5xx、过载等临时错误，按 Pi 的重试设置（`retry.maxRetries`、`retry.baseDelayMs`）退避重试
- 仍然失败就取消这次压缩，显示 Claude Code 的提示：`Error during compaction: …`；摘要请求超长且无法再降时为 `Compaction failed · conversation could not be reduced below the context limit`；不足两轮时为 `Not enough messages to compact.`
- 回复里没有可用 `<summary>`（包括空回复）不算“失败”：先追加一条更严格的追问重问一次（同一前缀，Anthropic 上并入最后一条 user turn），仍不行就交给 Pi 自己的压缩，提示写成 `Compacted by Pi's own compaction · <原因>`。原因里带 `stopReason`、输出 token 数和那段回复的首尾，看得出是超输出上限截断，还是模型没按格式写。交接时 Pi 的保留范围已按本包的 `keepRecentTokens=1` 算好（保留最后一轮，其余进摘要，不是 Pi 默认的 20K）。空闲压缩交回 Pi 时只留 idle 自己的那一条提示，不重复
- 自动压缩连续失败 3 次，本会话不再自动压缩（失败熔断）；连续 3 次在压缩后 3 轮内又回到阈值，判定为抖动，同样停止（`Autocompact is thrashing: …`）。熔断后 `/compact` 仍可用，任何一次压缩成功都会解除熔断

## 空闲压缩

压缩读的是缓存前缀，缓存热时很便宜；缓存一过期，下一次请求就要为整段对话重新付费。所以闲置太久时，趁缓存还热先压掉。

- **有效期 ≥1 小时才启用**，和 Claude Code 一致；5 分钟缓存不做，否则每次稍微离开都会压缩
- 一轮结束后开始计时，在“上次请求 + 75% 有效期”时触发（1 小时缓存即闲置 45 分钟）；触发时再确认：仍然空闲、没有排队消息、没有更新的请求、上下文 ≥10 万 token（`PI_CC_IDLE_COMPACT_MIN_TOKENS` 可调高）、没有迟到超过 1 分钟
- 默认开启（`/pi_cc` 可关）

有效期看上一次请求本身要的缓存，按顺序：

1. **模型配了 `promptCache`**：用它。档位看请求：请求里带了长缓存参数（Anthropic 的 `ttl: "1h"`、OpenAI 的 `prompt_cache_retention` 等，Pi 在 `PI_CACHE_RETENTION=long` 时才带）用 `long`，否则用 `short`
2. **没配，但请求是 Anthropic 格式且要了 1 小时缓存**（`cache_control.ttl: "1h"`）：就是 1 小时，这是 API 定义的，不用配
3. 其他：有效期未知，不做空闲压缩

所以：

- **Anthropic 系**（含 Anthropic 格式的代理）：只要让 Pi 发 1 小时缓存，即给该 provider 设 `PI_CACHE_RETENTION=long`，别的不用配。可以只给某个 provider 设，写在 `~/.pi/agent/auth.json` 里它的条目下：

  ```json
  { "cloudagent": { "type": "api_key", "key": "…", "env": { "PI_CACHE_RETENTION": "long" } } }
  ```

- **OpenAI 系**（`openai-responses`、`openai-completions`）：`prompt_cache_retention` 实际保留多久由各家决定（OpenAI 官方的 `24h` 档文档写“通常约 30 分钟”），不作推断。确认服务端能保留 1 小时以上的，在 `~/.pi/agent/models.json` 给模型配 `promptCache`，两档写同一个数即可，不用管用的是哪档：

  ```json
  { "id": "my-model", "promptCache": { "short": 3600, "long": 3600 } }
  ```

  内置模型用 `modelOverrides` 配。

### 与 Pi 缓存保温的关系

两者不冲突，各管各的时间段，本包不改 `cacheWarming`：Pi 的保温只在缓存较短时起作用（它自身的安全窗口：空闲最多 30 分钟、运行中最多 60 分钟，超过约半小时的缓存实际上不保温），空闲压缩只管 1 小时以上的缓存。5 分钟档的模型（如未设 `PI_CACHE_RETENTION=long` 的 Anthropic）只有保温能救，两样都留着。

## /pi_cc

本包和 pi-cc-loop、pi-cc-monitor、pi-cc-plugins 共同提供 `/pi_cc`：pi-cc 家族的设置命令，装了几个包都只有一个。

- 本包的两项在面板的 Compact 页（Tab / Shift+Tab 切换页）：**CC compaction**（`compaction`，默认开）和 **Idle compaction**（`idleCompaction`，默认开）；`/pi_cc compact on|off`、`/pi_cc idle on|off` 切换
- 切换即时生效，不用 `/reload`：阈值从下一次检查起变化，压缩从下一次起换回 Pi 的或本包的
- 空闲压缩依赖 CC compaction：后者关掉时前者也不生效
- 环境变量 `PI_CC_COMPACTION=0`、`PI_CC_IDLE_COMPACTION=0` 可临时覆盖，面板里相应项锁定

## 兼容性

- Pi 1.3.0 / 1.4.0
- 本包包装 Pi 内部的 `SettingsManager.getCompactionSettings`、`ExtensionRunner.emitBeforeProviderRequest` 和 `ExtensionRunner.invalidate`（SDK 的 `session.dispose()` 不发 `session_shutdown`，最后一个用来清理会话状态），每个进程只包装一次。Pi 升级后找不到前两个方法时，本包会提示；记不下请求就读不到缓存，压缩交给 Pi
- 同一进程内同时运行多个带本包的 SDK 会话时，`getCompactionSettings` 无法区分调用来自哪个会话：同时存活期间禁用本包的阈值覆盖、分叉压缩和空闲压缩，交给 Pi 自己处理；只剩一个会话时恢复。普通单会话 TUI 不受影响
- **只装一个压缩插件**：Pi 依次调用所有扩展的 `session_before_compact`，最后一个返回结果的生效，两个插件都生成摘要会付两份钱、前一份被丢弃

## 本地开发

```bash
node --test tests/*.test.mjs
npx --yes -p typescript@5.9.3 tsc --noEmit -p tsconfig.json
```

测试加载真实的 Pi 模块（在 Pi 自己的 `SettingsManager`、`ExtensionRunner` 上安装补丁，用 Pi 的 `SettingsManager` 读写临时目录里的 `settings.json`）。
测别的 Pi 版本时，把 `PI_AGENT_DIR` 指到只装了那个版本的目录（`<dir>/install/releases/<version>`）。测试不读写真实的 `~/.pi/agent`。

### 缓存约束

提示缓存按前缀匹配（工具 → system prompt → 消息）。本包只改它被要求的那次压缩，不改普通请求：
不注册 `before_agent_start` / `context` 等会改请求的钩子。`before_provider_request` 注册了一个什么都不做的处理器，只是为了让 Pi 把请求交给扩展层（否则记不下请求），它原样放行；记请求的包装也原样返回同一个请求体对象。
`tests/cache.test.mjs` 守住这一点。

## 与 Claude Code 的差异

- 熔断打开后，本会话的自动压缩和 Pi 的超限恢复一起停（返回 `enabled:false`）。Claude Code 的失败熔断只拦主动压缩，超限时仍尝试恢复；这里没有等效的手段只拦其一

- 提示词：Claude Code 从 8 个实验分支里选摘要提示词（服务端开关），这里固定用默认的 control 分支；工具列表换成 Pi 的小写工具名。codemode 脚本里调用的工具按 Pi 记在结果上的 `nestedCalls` 计入（工具列表和补回的文件都是），Claude Code 没有 codemode
- 补回的内容：本包目前只补文件上下文，未恢复 plan、已加载技能或后台任务状态。为避免绕过权限，文件片段取已成功返回的 read 缓存，不自行读取当前文件；其他文件调用只给路径引用。内容作为摘要正文的一部分，并注明是历史片段
- 超限恢复：Claude Code 按 API 返回的 token 缺口逐组多保留尾部，最后裁掉最早的历史；这里从超限前最后一次成功的请求分叉，那次请求必然放得下，不需要逐组退让和裁头
- 读不到缓存时：Claude Code 照样分叉（或退到它的专用摘要请求）；这里交给 Pi 自己的压缩
- 空闲压缩：Claude Code 在 90% 有效期（1 小时缓存的第 54 分钟）、上下文 ≥20 万 token 时触发；这里提前到 75%（第 45 分钟），门槛降到它允许的下限 10 万。缓存是服务端尽力保留的，留出一刻钟余量；10 万 token 的重读已经比一次摘要贵
- 不做的：后台预先算摘要、闲置后的服务端工具结果清理、`context_hint`，它们在 Claude Code 里默认关闭（服务端开关）

## 许可证

MIT。
