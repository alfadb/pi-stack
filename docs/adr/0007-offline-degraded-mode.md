# ADR 0007 — Offline 降级模式与 gbrain 部署边界

- **状态**: Accepted
- **日期**: 2026-05-05
- **决策者**: alfadb
- **依赖**: ADR 0002（gbrain 唯一记忆存储）

## 背景

ADR 0002 决定 gbrain 作为唯一记忆存储。但 gbrain = postgres + pgvector，相比 pensieve 文件型零依赖：

| 维度 | pensieve（旧） | gbrain（新） |
|---|---|---|
| 依赖 | 零（文件 + git） | postgres + pgvector + gbrain CLI/server |
| Offline | 永远可用 | 依赖 postgres 进程 + pgvector 扩展 |
| 跨设备同步 | git 自然同步 | postgres dump/restore 或多设备共用一个实例 |
| 数据可见性 | grep / cat 直接读 | 必须经 gbrain CLI |
| 故障域 | 文件损坏（罕见） | postgres 挂了 / 网络挂了 / pgvector schema 升级失败 |

v6 双 T0 批判一致指出：对一般用户 postgres 依赖代价可控；对 **author**（alfadb 自己调试 pi-astack 代码）不可控，因为"记忆系统出问题"恰好是 author 的高频场景。文件型 fallback 在这些场景里是**事实上的最后救命稻草**。

## 决策

### 部署边界（关键）

**pi-astack 不提供 gbrain 安装兜底。也不提供 local pgvector docker-compose。**alfadb 自行负责：

- 安装 gbrain CLI（`bun install -g gbrain` 或 git clone + bun link）
- 准备 postgres + pgvector 实例（local docker、远程 RDS、neon 等任意路径，alfadb 自决）
- 在 `~/.gbrain/config.toml` 配置连接字符串
- 跑一次 `gbrain migrate` 创建 schema

pi-astack 只要求"alfadb 提供可用的 gbrain 连接"，不**强制**任何特定的部署形态：
- 不内置 `docker-compose.yml`
- 不预设 postgres 端口、密码、数据卷路径
- 不提供 setup 脚本

理由：
1. alfadb 的 gbrain 部署可能本来就在某个云 postgres 上，pi-astack 强加 local docker 反而打架
2. gbrain 是 alfadb 自己的项目，pi-astack 只是 gbrain 的消费者之一，不应越界管 gbrain 怎么部署
3. brain maxim "single owner" — gbrain 的部署 own 在 gbrain 项目，pi-astack 不重复实现

pi-astack 文档里**说明前置依赖**即可（在 README 安装步骤中提示"先准备好 gbrain 实例"），不**自带**部署。

### Offline 兜底两件套

**不是三件套**（已删除"local docker-compose pgvector"那一件，归 alfadb 自决）。剩两件：

#### 1. 定期 markdown export（sediment 触发）

sediment 在每次 agent_end 后顺手做：
- `gbrain export --source pi-astack --dir ~/.pi/.gbrain-cache/markdown/pi-astack/`
- `gbrain export --source default --dir ~/.pi/.gbrain-cache/markdown/default/`

输出是 markdown 文件，可被 grep 直接读。这是 author 在 gbrain 自身故障时的最后救命稻草。

实现位置：`extensions/sediment/markdown-exporter.ts`

#### 2. 主会话 read tool fallback

`extensions/gbrain/index.ts` 的三个 read tool 增加 fallback：

```
try:
  result = await gbrain_cli(...)
catch (gbrain unavailable):
  result = await markdown_grep(~/.pi/.gbrain-cache/markdown/, query)
  return { result, _degraded: true, _reason: "gbrain unavailable, used markdown cache" }
```

主会话看到 `_degraded: true` 时知道降级了，会在回复里告知用户"当前 gbrain 不可用，结果来自 markdown 快照"。

## 关键约束

1. **必须配齐两件套**：缺任何一件 v6.5 不算落地完成
2. **markdown cache 不进 git 仓**：`~/.pi/.gitignore` 包含 `.gbrain-cache/`
3. **sediment fail closed**：gbrain 不可用时 sediment 不重试到 markdown 写入；进 pending queue 等 gbrain 恢复
4. **gbrain 部署是 alfadb 自决**：pi-astack 只读 `~/.gbrain/config.toml`，不管理其内容

## Source 配置（M5修订后）

**重要修订**：v6 原版曾提议“不写 .gbrain-source dotfile，用 GBRAIN_SOURCE env”。读完 gbrain v0.18 源码后修正：`.gbrain-source` dotfile 是 gbrain 官方为跨设备同项目设计的机制，应该**顺应使用**，而不是绕过。

### 为什么 dotfile 是跨设备正确选择

| 机制 | 内容 | 跨设备 | 说明 |
|---|---|---|---|
| `.gbrain-source` dotfile | source id 字符串（如 `pi-astack`） | ✅ 可移植 | commit 进 git，多设备 clone 后同步同一 source id |
| `local_path` 注册 | 本机绝对路径（如 `/Users/x/.pi`） | ⛔ 不可移植 | 各设备路径不同，只能本机有效 |
| `GBRAIN_SOURCE` env | source id | ⚠️ 需 shell rc | 跨设备依赖 alfadb 手动 export，dotfiles 同步 .bashrc/.zshrc |

alfadb 可能同一个 pi-astack 在：
- 设备 A：`~/.pi`
- 设备 B：`/data/alfadb/.pi`
- 设备 C：`~/dotfiles/pi`

路径不同，但三台都需要解析到同一个 `pi-astack` source。dotfile 是唯一随 git 同步、内容与路径无关的机制。

### 两份需要 commit 的 dotfile

```
~/.pi/                                             ← 主 dotfiles 仓
├── .gbrain-source                                 ← commit！内容: pi-astack
└── agent/skills/pi-astack/                         ← submodule
    └── .gbrain-source                             ← commit！内容: pi-astack
```

为什么两份：
- `~/.pi/.gbrain-source` —— alfadb cd 到 ~/.pi 任何子目录（不在 submodule 内）时，dotfile walk-up 命中根
- `pi-astack/.gbrain-source` —— alfadb 独立 clone pi-astack 到非 ~/.pi 路径（如 `~/code/pi-astack` 临时调试）时，dotfile walk-up 仍能命中

两份内容完全相同（`pi-astack`），不是路径，不会冲突。

### `defaults/pi-astack.defaults.json` 与官方 settings chain

```json
{
  "piStack": {
    "memory": {
      "projectSource": "pi-astack"
    }
  }
}
```

`defaults/pi-astack.defaults.json` **不被 pi 自动加载**。它只提供 package-local fallback / 文档示例。运行时配置必须从官方 pi settings chain 读取（`~/.pi/agent/settings.json` + 项目 `.pi/settings.json`，nested object merge）。

该字段**不**用于路由 sediment 写入（路由完全交给 gbrain resolver + ADR 0008 source trust guard）。它有两项辅助用途：
1. **初始化提示**：pi-astack 首次被加载时检查当前仓是否已有 dotfile。没有则提示 alfadb 创建。
2. **pending review UX**：resolver 返回 default 但 voter scope=project 时，提示 alfadb 该仓可能应该注册为哪个 source id。

### `~/.pi/.gitignore` 修改

```
.gbrain-cache/         # markdown export 输出，不进 git
.gbrain-scratch        # alfadb 标记临时不沉淀的 marker
# 不加 .gbrain-source！该文件必须 commit
```

## ~/.pi 双重身份的 source 路由

`~/.pi` 同时是：
- pi-astack 的开发环境（cwd 在 pi-astack 内的子目录）
- 其他项目的 pi 基础环境（用户 cd 到任意项目跑 pi）

source 路由策略（详见 ADR 0008）：
- cwd 落在 `~/.pi/agent/skills/pi-astack/` 下 → dotfile walk-up 解析为 `pi-astack`
- cwd 落在 `~/.pi/` 下但不在 pi-astack/ → dotfile walk-up 解析为 `pi-astack`（dotfiles 仓本身的工作流也归 pi-astack 项目记忆）
- cwd 落在 `~/.pi/` 之外的注册项目 → 该项目 source（dotfile 或 local_path）
- cwd 落在 `~/.pi/` 之外的未注册项目 → resolver fallback default；sediment 根据 voter scope fail closed / pending，不能把项目事件写 default
- resolver 命中非 default source 时，sediment 写入前仍执行 source trust guard，防第三方仓伪造 `.gbrain-source`。

注：~/.pi/.pensieve/ 现有沉淀关于的就是 ~/.pi 工作流本身，迁移后归 pi-astack source 合理。

## 后果

### 正面
- author offline 体验从"灾难"降到"轻度退化"
- gbrain 自身故障（schema 升级 / 索引重建 / postgres 挂）时主会话仍能 grep markdown
- 跨设备：alfadb 在新机器上拉 ~/.pi 后，需要 alfadb 手动准备 gbrain 实例 + import，pi-astack 不代办
- 数据可见性：markdown export 让 alfadb 随时能 grep / cat 看记忆全貌
- 单一职责：gbrain 部署归 gbrain 项目，pi-astack 不越界

### 负面
- markdown export 写入有 IO 成本（每次 agent_end）
- markdown 与 gbrain 主体可能短暂不一致（最后一次 export 之后的写入）
- ~/.pi/.gbrain-cache/ 占盘空间（粗估前 6 个月 < 50MB）
- alfadb 首次在新机器上安装 pi-astack 需要先安装 gbrain（多一步）

## 跨设备同步策略

不在本 ADR 决定（YAGNI）。当前 alfadb 单设备使用为主。未来需要时再写新 ADR。

可能方案（alfadb 自行选择，pi-astack 不预设）：
- (a) postgres dump/restore via cron
- (b) 多设备共用一个云端 gbrain 实例（如 neon、supabase）
- (c) 用 git annex 同步 ~/.pi/.gbrain-cache/postgres-data

## 引用

- ADR 0002: gbrain 作为唯一记忆存储
- ADR 0008: ~/.pi 双重身份与 source 路由
- v6 双 T0 批判: claude-opus-4-7-xhigh 关于 author offline 体验的强意见
- gbrain 命令: `gbrain export --source <id> --dir <path>`（已存在）
