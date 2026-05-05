# pi-stack

> alfadb's personal pi distribution.

## 是什么

把 alfadb 用 pi-coding-agent 时所需的全部资源——extensions、skills、prompts、运行时材料——集中维护在一个仓里。

参考心智模型：**Linux distribution maintainer**。
- `vendor/` 跟踪上游纯净源码（read-only）
- `extensions/` `skills/` `prompts/` `runtime/` 是 alfadb 自己写的 pi 端口层
- 上游升级 = diff vendor → cherry-pick 到端口层 → bump SHA → 更新 UPSTREAM.md

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

```bash
# 看上游更新
npm run vendor:diff:gstack
npm run vendor:diff:pensieve

# 升级 vendor pointer（手动决策每次升级）
cd vendor/gstack && git checkout <new-sha> && cd ../..
git add vendor/gstack && git commit -m "chore(vendor): bump gstack to <sha>"

# 把上游有价值的改动 cherry-pick 到端口层
# （手工编辑 skills/extensions/prompts/runtime/ 内文件）
git commit -m "feat(<area>): port <feature> from gstack <sha>"

# 更新跟踪文档
$EDITOR UPSTREAM.md
git add UPSTREAM.md && git commit -m "docs(upstream): record port"
```

## 上游

- `vendor/gstack` ← `https://github.com/garrytan/gstack`
- `vendor/pensieve` ← `https://github.com/kingkongshot/Pensieve`

详细跟踪表见 [UPSTREAM.md](./UPSTREAM.md)。

## 沉淀

pi-stack 仓内**不**自带 `.pensieve/`。沉淀容器是 `~/.pi/.pensieve/`（superproject），pensieve 探测项目根时会自动走到那里。详见 ADR 0001 第 8 条硬纪律。

## 设计原则

- 单一作者发行版（不为外部 contributor 优化）
- vendor + 端口层（不 fork、不维护私有长寿命分支）
- 单一 pi-package 入口（local submodule，开发即使用）

详见 [docs/adr/0001-pi-stack-as-author-distro.md](./docs/adr/0001-pi-stack-as-author-distro.md)。

## License

MIT
