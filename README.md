# pi-stack

> alfadb's personal pi workflow — 专为 pi 打造的个人工作流仓。

## 是什么

把 alfadb 用 pi-coding-agent 时所需的全部资源——extensions、skills、prompts、运行时材料——集中维护在一个仓里。

参考心智模型：**gstack 之于 claude-code 的关系，pi-stack 之于 pi 的关系一样**。作者为自己常用的某个 harness agent 打造一整套工作流，集成自己认同的 review/qa/security/multi-agent/memory 等能力，不断演进。不是发行版（不为不同环境打包同一软件），不是仓库集合（不是谁都可以拿出一个独立包），是**作者自用 + 作者认可的完整工作流**。

- `vendor/` 跟踪上游纯净源码（read-only）——主要是那些为别的 harness（如 claude-code）设计、需要移植才能为 pi 使用的项目
- `extensions/` `skills/` `prompts/` `runtime/` 是 alfadb 自己写、适配 pi 机制的端口层
- 上游升级 = LLM 阅读 diff → 判断哪些变更适用于 pi 的使用语境 → 移植到端口层 → bump SHA → 更新 UPSTREAM.md

## 安装方式

### alfadb 自己（开发即使用）

挂为 `~/.pi/agent/skills/pi-stack/` submodule，settings.json 用 local path 加载。这样改一行立即生效，无需 push/install 周转。

```bash
# 一次性挂载（在 ~/.pi 仓内执行）
cd ~/.pi
git submodule add git@github.com:alfadb/pi-stack.git agent/skills/pi-stack
git submodule update --init --recursive   # 拉取 pi-stack 自己的 vendor/* 嵌套 submodules

# settings.json 只需一行 local path:
#   "packages": ["~/.pi/agent/skills/pi-stack"]
```

日常开发：

```bash
cd ~/.pi/agent/skills/pi-stack
$EDITOR extensions/multi-agent/runner.ts    # 直接改
git add . && git commit -m "fix: ..."
git push                                    # 推到 GitHub

cd ~/.pi
git add agent/skills/pi-stack
git commit -m "chore: bump pi-stack to <sha>"
git push                                    # ~/.pi 追踪 submodule 指针
```

### 假想他人安装

```bash
pi install git:github.com/alfadb/pi-stack
```

这条路径**不是 alfadb 自己的工作流**，仅作展示用途。alfadb 永远走 submodule + local path。

## 内容

### Extensions（pi 行为扩展）
- `multi-agent/` — 多模型并行 / debate / chain / ensemble 子代理调度
- `sediment/` — 后台沉淀代理：Pensieve writes + gbrain put
- `model-curator/` — 模型能力快照与选择建议
- `gbrain/` — gbrain CLI 包装（search / get / query）
- `pensieve-context/` — Pensieve 项目记忆侧边栏 + 自动加载
- `browse/` — 浏览器自动化（来自 garrytan/gstack）
- `retry-stream-eof.ts` — 单文件 hack，等上游 PR 合并

### Skills（pi 技能）
- `pensieve-wand/` — Pensieve 知识库查询助手
- 来自 garrytan/gstack 的 19 个 skill：autoplan, review, qa, qa-only, cso, investigate, retro, ship-related, plan-ceo-review, plan-eng-review, plan-design-review, plan-devex-review, office-hours, document-release, land-and-deploy, setup-deploy, canary, scrape, health, benchmark

### Prompts
- `ship.md`（来自 garrytan/gstack）
- `multi-*.md`（来自 alfadb/pi-multi-agent）

### Runtime
- `runtime/pensieve/` — Pensieve 完整运行时（init / sync / sediment / 模板），由 `extensions/pensieve-context/` 调度

## 维护节奏

上游升级**不**通过机械脚本，而是 LLM 协作工作流：

1. 在 pi 当前会话里让助手 `git fetch` + `git log --oneline HEAD..origin/main` 列出上游未合入的 commit
2. 助手对每条 commit 跑 `git show` 看 diff，按性质分类（bug 修复 / 新功能 / 与 pi 无关 / 与端口层冲突）
3. 助手把分类结果呈给 alfadb，逐条讨论每个变更是否值得移植、移植到哪、有什么连锁改动
4. 决策后助手用 edit 工具在 `extensions/skills/prompts/runtime` 端口层改文件
5. `chore(vendor)` commit bump SHA，紧跟 `feat(<area>)` commit 完成端口适配
6. 助手同步更新 [UPSTREAM.md](./UPSTREAM.md)

详细工作流见 UPSTREAM.md 的「上游升级工作流」章节。

## 上游

- `vendor/gstack` ← `https://github.com/garrytan/gstack`（外部上游，alfadb 是 read-only 消费者）
- `vendor/pensieve` ← `https://github.com/kingkongshot/Pensieve`（pensieve 项目上游，alfadb 是其中一名维护者）

详细跟踪表见 [UPSTREAM.md](./UPSTREAM.md)。

## 沉淀

pi-stack 仓内**不**自带 `.pensieve/`。沉淀容器是 `~/.pi/.pensieve/`（superproject），pensieve 探测项目根时会自动走到那里。详见 ADR 0001 第 8 条硬纪律。

## 设计原则

- 作者自用的 pi 工作流仓（不为多外部 contributor 优化，也不为多 harness 优化）
- vendor + 端口层（不 fork、不维护私有长寿命分支）
- 单一 pi-package 入口（local submodule，开发即使用）

详见 [docs/adr/0001-pi-stack-as-personal-pi-workflow.md](./docs/adr/0001-pi-stack-as-personal-pi-workflow.md)。

## License

MIT
