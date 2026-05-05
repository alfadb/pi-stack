# ADR 0001 — pi-stack 作为 alfadb 为 pi 打造的个人工作流仓

- **状态**: Accepted
- **日期**: 2026-05-05
- **决策者**: alfadb（唯一作者）
- **上游原则**: brain maxim `prefer-read-only-vendor-submodules-with-owned-adaptation-layers-over-forking-ext`

## 背景

alfadb 在 `~/.pi/` dotfiles 仓下维护 6 块 pi 相关代码，分散在 4 个 git repo + 2 处散文件中：

| 当前位置 | 形态 | 行数级别 | 归属 |
|---|---|---|---|
| `agent/extensions/gbrain/` | 散文件 extension | ~270 行 | alfadb 100% own |
| `agent/extensions/retry-stream-eof.ts` | 散文件 hack（等上游 PR） | ~130 行 | alfadb 临时 own |
| `agent/skills/pi-model-curator/` | in-tree（无 submodule） | ~350 行 | alfadb 100% own |
| `agent/skills/pi-multi-agent/` | submodule，独立 repo | ~2500 行 | alfadb 100% own |
| `agent/skills/pi-sediment/` | submodule，独立 repo | ~2400 行 | alfadb 100% own |
| `agent/skills/pi-gstack/` | submodule，alfadb fork 自 garrytan/gstack；内部 `vendor/gstack` submodule + 19 skill 移植 | 19 skill + 1 ext + ship.md | alfadb own port，跟踪 garrytan 上游 |
| `agent/skills/pensieve/` | submodule，kingkongshot/Pensieve `pi` 私有长寿命分支（28 commits）| pi adapter + .src/ 大量改动 | alfadb own port，应跟踪 kingkongshot main |

经过三轮 multi-model debate（claude-opus-4-7 + gpt-5.5 + deepseek-v4-pro × 2 轮 × xhigh），三方最终一致：当前形态是**用 npm 心智在用 pi**，应回到 pi 哲学的"作者为某个 harness 打造一整套工作流"形态——这与 garrytan/gstack 为 claude-code 打造的个人工作流仓是同一种心智模型。

随后基于 pi 官方 `packages.md` / `extensions.md` 文档复核，识别出 pi 原生 `bundledDependencies` 机制——但用户决策"废弃 pi-gstack 和 pensieve 的 pi 分支"明确否决了"保留 fork 仓 + 用 bundledDeps 嵌套"路线，确认：**alfadb 不再以任何形式维护 fork 仓或私有长寿命分支**。

## 决策

建立 `github.com/alfadb/pi-stack` 单一 monorepo，作为 alfadb 为 pi 打造的个人工作流仓，**以 git submodule 形式挂在 `~/.pi/agent/skills/pi-stack/`**。

### 定位与心智模型

- **不是**：Linux distribution（为不同环境打包同一软件）、npm 包集合（谁都能拿出一个独立消费单位）、为多 harness 抓各种适配的库
- **是**：作者常用 pi 这个 harness，把自己常用的、认同的工作流资源集成在一个仓里。参考 garrytan/gstack —— gstack 作者常用 claude-code，就为 claude-code 打造一套他认同的 review/qa/security/ship 工作流，不断演进。pi-stack 与 pi 的关系 = gstack 与 claude-code 的关系。
- **不为**外部 contributor 优化，也不为跨 harness 入口优化

### 仓库结构

仓库结构遵守"vendor + 自有端口层"模式：

1. **vendor/**（read-only nested submodule，跟踪上游纯净源）
   - `vendor/gstack/` → `garrytan/gstack@bf65487`（继承 pi-gstack 当前基线；外部上游，alfadb 是 read-only 消费者）
   - `vendor/pensieve/` → `kingkongshot/Pensieve@main`（pensieve 项目的上游主仓；alfadb 作为该项目的维护成员之一参与上游协作，不是作者也不是个人 fork）

2. **extensions/ skills/ prompts/**（pi 资源端口层，alfadb 100% own）
   - 不再有 fork 关系
   - vendor 升级 → diff → 决定哪些值得 cherry-pick 进端口层

3. **runtime/**（非 pi 资源、被某个 extension 调度的运行时材料）
   - `runtime/pensieve/` 包含 pensieve 完整可执行运行时（.src/ 移植 + alfadb 添加的 hook 脚本 + 模板覆盖）
   - 由 `extensions/pensieve-context/` 调度安装到具体项目

### "使用即开发"工作流（关键约束）

alfadb 是 **pi-stack 的唯一作者，也是唯一使用者**。这意味着：
- pi-stack **必须**以 git submodule 形式挂在 `~/.pi/agent/skills/pi-stack/`，可随时 `cd` 进入直接编辑
- pi 加载方式是 `settings.json: packages: ["~/.pi/agent/skills/pi-stack"]`（**local path**，不是 `git:` URL）—— 改一行不需要 push 再 pi update
- `pi install git:github.com/alfadb/pi-stack` 仅作为"假想他人安装"的备用入口，不是 alfadb 自己的工作流
- 所有提交都在 pi-stack submodule 内做，~/.pi 仓只追踪 submodule 指针 SHA

### 沉淀延续策略

`~/.pi/.pensieve/`（62 个 short-term + 完整 maxims/decisions/knowledge）**不动**：
- pi-stack submodule **不**自带 `.pensieve/` 目录
- sediment 利用 pensieve 已有的 superproject 探测能力（pensieve commit `7b81567 fix: detect git submodule in project_root() and walk up to superproject`），从 pi-stack 内任何位置触发都会找到 ~/.pi 作为 project root
- 沉淀对象的语义是"alfadb 的 pi 工作流整体"，不是某个具体 submodule
- 未来加新 submodule（其他工作流仓）也共享同一沉淀容器

## 废弃清单

| 实体 | 处置 | 原因 |
|---|---|---|
| `alfadb/pi-gstack` repo | archive，README 指向 pi-stack | 个人工作流仓不需要独立 fork 仓 |
| `alfadb/pi-multi-agent` repo | archive（subtree merge 入 pi-stack 保历史） | 同上 |
| `alfadb/pi-sediment` repo | archive（subtree merge 入 pi-stack 保历史） | 同上 |
| `kingkongshot/Pensieve@feature/auto-sediment-hook` 分支 | 删除 | 私有长寿命分支是 brain maxim 明确反对的形态 |
| `kingkongshot/Pensieve@pi` 分支 | 删除 | 同上 |
| `~/.pi/agent/extensions/gbrain/` | 移入 pi-stack | 散文件归位 |
| `~/.pi/agent/extensions/retry-stream-eof.ts` | 移入 pi-stack | 同上，注释好上游 PR 链接 |
| `~/.pi/agent/skills/pi-model-curator/` | 移入 pi-stack | in-tree 副本归位 |

## 后果

### 正面
- `~/.pi/agent/settings.json` 从 13 行 packages/skills/extensions/prompts 配置降到 1 行 local path
- 单作者跨"6 块代码"的同步开销基本归零（之前 debate 估月省 3-4 小时）
- 上游升级路径清晰 (LLM 阅 diff → 语义判断 → 端口层适配)
- 废弃私有长寿命分支，符合 brain maxim 的明确指引
- alfadb 改一行立即生效（local submodule + `/reload`），无需 `pi update` 周转
- 62 条 short-term 沉淀连续无断点

### 负面
- 单仓体积变大（vendor submodules + 端口层 + runtime）
- 上游升级需要手工 cherry-pick 而非 merge（这正是路线选择的代价，也是收益的来源）
- ~/.pi 仓需要追踪 pi-stack submodule SHA，每次 pi-stack 提交后多一步 `cd ~/.pi && git add agent/skills/pi-stack && git commit`

## 硬纪律（执行铁律）

### 1. vendor/ 严格只读
- **任何**对 vendor/ 内文件的修改都必须通过 `patches/` 目录或迁移到端口层
- vendor/ 只为两件事服务：(a) 移植参考源 (b) 升级 diff 源
- 端口层永远不能 `import` 或 `source` `vendor/*/...` 路径
- runtime/pensieve/ 是 vendor/pensieve 的**完整移植副本**，不是引用

### 2. 单向依赖
```
extensions/ → 调用 → runtime/ + skills/ + prompts/
extensions/ → 不依赖 → vendor/
runtime/ → 不依赖 → vendor/
skills/ prompts/ → 不依赖 → 任何代码
```

### 3. UPSTREAM.md 必须实时维护
- vendor SHA 升级必须同时更新 UPSTREAM.md
- 每条端口层资源必须能从 UPSTREAM.md 找到上游来源行
- 不允许"我记得是从那里来的"式的口头追溯

### 4. vendor bump 独立 commit
- `chore(vendor): bump gstack to <sha>` 不夹其他改动
- 紧跟着的 commit 是端口层的适配（如有需要）
- 这一对 commit 永远成对出现

### 5. 第一阶段不抽 shared/ 包
- 哪怕 vision-core / imagine-core / gbrain-cli / agent-loop 看起来重复
- 等 rule of three（≥3 个真实消费者）自然浮现
- 这条来自 claude-opus 在 debate 中的强意见

### 6. 棘轮规则（rule-of-three 的具体化）
- 同一 utility 出现第 2 个 caller → 提取到 internal 共享位置
- 同一 vendor 文件被改动第 2 次 → 升格为正式 patch 文件
- gbrain ad-hoc retry 出现第 2 种 pattern → 收进 gbrain 的统一 client

### 7. 与 brain maxim 的偏离点（有意识的偏离）
brain maxim 推荐 **patches queue** 模式来管理对 vendor 内容的修改。本 ADR 选择了"完整端口层"模式（runtime/pensieve/ 把 .src/ 全部 own 一份），原因：
- 用户明确选了"4-i 覆盖"（不是 ii patches 队列）
- pensieve 上 `.src/` 改动量大（28 commits 涉及 ~30 个文件）+ 横跨脚本/模板/引用文档三类，patches 队列在这种规模下手工成本高于"一次 own 一份"
- 副作用：vendor/pensieve 的核心改动需要靠 UPSTREAM.md 手工标注哪些已 cherry-pick，无法 `git apply` 自动验证
- **缓解**：UPSTREAM.md 必须维护"runtime/pensieve 的每个目录对应 vendor/pensieve 的哪些文件"映射表，让升级 diff 可以定位

如果未来发现 runtime/pensieve 升级痛苦超过预期，可以转向 patches queue（向 maxim 靠拢）。

### 8. 沉淀容器是 ~/.pi/.pensieve/，不在 pi-stack 内
- pi-stack 仓内**不创建** `.pensieve/` 目录
- pensieve 探测项目根时通过 `git rev-parse --show-superproject-working-tree` 走到 ~/.pi
- 任何"想给 pi-stack 单独沉淀"的需求都先来回顾这条 ADR

## 不在本 ADR 决策的事（YAGNI）

- 是否在 npm registry 发布 pi-stack
- 是否抽 `packages/` 共享原语
- 是否做 affected-only CI
- 是否抽 lint / shellcheck CI

这些等真实需求出现再决策。

### 已明确否定的事

- **不通过 `npm run` 脚本机械化 vendor bump 与 diff 判断**：上游变更的语义判断必须经过 LLM 阅读 diff + alfadb 讨论。详见 UPSTREAM.md 的「上游升级工作流」章节。

## 引用

- brain maxim: `prefer-read-only-vendor-submodules-with-owned-adaptation-layers-over-forking-ext`（2026-05-05 沉淀）
- pi 官方文档: `packages.md`、`extensions.md`、`skills.md`
- 三轮 debate 结论: 三模型一致同意"作者为某个 harness 打造一整套工作流仓"形态（类比 garrytan/gstack 之于 claude-code）
- pensieve superproject 探测: kingkongshot/Pensieve commit `7b81567`
