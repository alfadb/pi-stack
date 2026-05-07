# ADR 0008 - ~/.pi 双重身份与 source 路由

- **状态**: **被 [memory-architecture.md](../memory-architecture.md) 改变前提**（2026-05-07）— `.gbrain-source` dotfile 机制随 gbrain 退场而作废。~/.pi 双重身份（pi-astack 开发环境 + 其他项目的 pi 基础环境）仍然成立，但不再通过 source 路由区分——改为通过项目各自的 `.pensieve/` 目录存在性自然区分。保留本 ADR 作为双重身份设计的历史档案。
- **日期**: 2026-05-05
- **决策者**: alfadb
- **依赖**: ADR 0001(pi-astack 定位)/ ADR 0002(superseded by 0012)/ ADR 0004(superseded)/ ADR 0007(offline)
- **被取代**: ADR 0012(双 target,不再需要 source 路由)

## 背景

`~/.pi` 这个 dotfiles 仓有**两个并存身份**:

| 身份 1 | 身份 2 |
|---|---|
| **pi-astack 的开发环境** | **其他项目的 pi 基础环境** |
| alfadb cd 到 ~/.pi/agent/skills/pi-astack/ 改 pi-astack 代码 | alfadb cd 到 ~/work/some-project 跑 pi |
| 这是 pi-astack 项目本身的工作 | pi 加载 ~/.pi/agent/settings.json 作为全局配置 |

两个身份共用同一个文件树,但**沉淀归属不同**。

更复杂的是 alfadb 跨设备开发:同一个 pi-astack 在设备 A 是 `~/.pi`,设备 B 是 `/data/alfadb/.pi`,设备 C 是 `~/dotfiles/pi`--路径不同,但都应解析到同一 `pi-astack` source。

## 决策

### 路由完全配合 gbrain 官方 resolver,不另造一套

gbrain v0.18 的 source resolver 已实现完备的优先级链:

| 优先级 | 来源 | pi-astack 用法 |
|---|---|---|
| 1 | `--source <id>` flag | sediment 内部写入显式传(兜底保险) |
| 2 | `GBRAIN_SOURCE` env | CI / 一次性脚本临时覆盖 |
| 3 | **`.gbrain-source` dotfile (walk-up)** | **alfadb commit 进 git,跨设备同源主路径** |
| 4 | `local_path` 注册(最长前缀) | 本机便利(每台机首次 `gbrain sources add pi-astack --path <本机绝对路径>`) |
| 5 | brain default | 用户喜好 |
| 6 | seeded `default` source | 兜底 fallback |

pi-astack **不**重复实现这套路由,**不**自己根据 cwd 推断 source 注入 env。

v6.5.1 补充:gbrain resolver 的结果对交互式 CLI 是权威;但对 background sediment write 还必须经过**写入时 source trust guard**。原因是 `.gbrain-source` 是普通仓库文件,第三方恶意仓也能伪造 `pi-astack` source id。sediment 不重写 resolver,但必须在写入前验证 resolver 结果是否来自可信路径。

### .gbrain-source 是跨设备同源关键

| 机制 | 内容 | 跨设备 | 评价 |
|---|---|---|---|
| `.gbrain-source` dotfile | source id 字符串 | ✅ 可移植(commit 进 git,多设备 clone 后同步) | **首选** |
| `local_path` 注册 | 本机绝对路径 | ⛔ 不可移植 | 本机便利,每台机自己 add |
| `GBRAIN_SOURCE` env | source id | ⚠️ 需 shell rc | 临时覆盖手段 |

### 两份 .gbrain-source

```
~/.pi/                                             ← 主 dotfiles 仓
├── .gbrain-source                                 ← commit!内容: pi-astack
└── agent/skills/pi-astack/                         ← submodule
    └── .gbrain-source                             ← commit!内容: pi-astack
```

为什么两份:
- `~/.pi/.gbrain-source` -- alfadb cd 到 ~/.pi 任何位置(不在 submodule 内)时,dotfile walk-up 命中根
- `pi-astack/.gbrain-source` -- alfadb 直接 clone pi-astack 到非 ~/.pi 路径独立调试时(如 `~/code/pi-astack`),dotfile walk-up 仍能命中

两份内容**完全相同**(`pi-astack`),不是路径,不会冲突。

### 跨设备工作流

```
设备 A (~/.pi)               设备 B (/data/alfadb/.pi)        设备 C (~/dotfiles/pi)
       │                              │                              │
       │ git clone ~/.pi              │ git clone ~/.pi              │ git clone ~/.pi
       ├──────────────────────────────┴──────────────────────────────┤
       │
       │  共同得到 .gbrain-source 文件(已 commit)
       │  内容都是: pi-astack
       │
       ▼
  优先级 3 命中 → 三台设备都解析为 source: pi-astack
       │
       ▼
  本机首次(可选,本机便利):
    gbrain sources add pi-astack --path <本机绝对路径> --no-federated
    (优先级 4,dotfile 已经覆盖了,这步主要为 gbrain CLI 的本机命令)
```

### Source trust guard(background write 专用)

`.gbrain-source` dotfile 必须 commit 是跨设备同源关键,但它不是认证凭据。任何第三方 repo 都可以放:

```text
.gbrain-source
pi-astack
```

若 sediment 盲信 resolver,alfadb 只要 `cd` 进该 repo,就可能把恶意仓的项目事件写入真正的 `pi-astack` source。因此 source-router 在写入前执行 trust guard:

1. 运行 gbrain 官方 resolver 得到 `resolver_source` 与命中方式(dotfile/env/local_path/default)。
2. 若 `resolver_source === default`:按 ADR 0004 default 写入合法性矩阵处理。
3. 若 `resolver_source !== default`:检查该 source 的 trusted path:
   - gbrain `sources` 注册的 `local_path`(最长前缀,realpath 规范化后)是否**精确匹配** cwd 的最近祖先 `.gbrain-source` 命中路径;或
   - `~/.pi/.gbrain-cache/source-trust.json` 中已有 alfadb 确认的 `(source_id, dotfile_path_root)` 是否**精确匹配**命中的 `.gbrain-source` 所在目录(不是 cwd 被 trusted_root 包含就算)。

   **Walk-up 祖先混滑防御(v6.5.2)**:若 cwd 为 `~/.pi/work/malicious-repo/subdir/`,walk-up 命中 `~/.pi/.gbrain-source`(祖先仓),trust guard 必须验证**命中 `.gbrain-source` 的目录** (`~/.pi/`) 是否与 trusted_root 一致,而不是验证 cwd 是否被 trusted_root 包含。避免 `~/.pi/` 的 trusted 范围意外覆盖其子目录下的恶意 repo。

4. 若 source id 与 trusted path 不匹配:视为 `untrusted_source_dotfile`,整条 candidate 进 pending,不写。
5. pending review 提供选项:信任此路径 / 改 source id / 标 scratch / discard。

**source-trust.json 完整性保护(v6.5.2)**:

该文件是安全关键资产--它决定哪些路径的 `.gbrain-source` 可被信任。防护:

1. **文件权限**:初始化时 `chmod 600`,仅 owner 可读写
2. **完整性校验**:sediment 启动时计算并记录 SHA-256 digest。每次读取前重新计算比对;不一致则 fail closed,所有写入进 pending 并告警
3. **路径规范化**:所有路径写入前调 `fs.realpathSync()` 解析 symlink,存储绝对规范化路径
4. **写入源限制**:该文件只能由 `/memory-source trust <path>` admin command 写入(sediment 运行时检测到 `source-trust.json` 被非命令来源修改 = 告警 + fail closed)
5. **文件格式**:

```typescript
// source-trust.json schema
[
  {
    "source_id": "pi-astack",
    "trusted_root": "/home/alfadb/.pi",       // realpath 规范化后
    "added_at": "2026-05-05T14:00:00Z",
    "added_by": "user",                         // user | command
    "dotfile_path": "/home/alfadb/.pi/.gbrain-source"  // git-committed dotfile 位置
  }
]
```

这不是重造 resolver;这是**写入安全 gate**。交互式 `gbrain search/put --source auto` 可继续用官方 resolver;无人值守的 sediment write 必须 fail closed。

### 路由表(cwd → resolver 行为)

| cwd 位置 | 命中优先级 | 解析 source |
|---|---|---|
| `~/.pi/` 任何位置(root + submodule + 子目录) | 优先级 3 命中 dotfile(内容 `pi-astack`) | `pi-astack` |
| `~/work/foo`(已 commit `.gbrain-source` = `foo`) | 优先级 3 命中 | `foo` |
| `~/work/foo`(无 dotfile,但已 `gbrain sources add foo --path .`) | 优先级 4 命中 local_path | `foo` |
| `~/work/foo`(无 dotfile,未注册) | 优先级 5/6 fallback | `default` |
| `/tmp` | 优先级 5/6 fallback | `default` |

### 关键约束:default 永远只接受跨项目准则

resolver 落到 `default` 时,sediment **不能**因此就把所有候选都写到 default。原因:未注册仓 fallback 到 default 是 gbrain catch-all 行为,但 sediment 自己有 voter 输出 scope,能区分**项目特有事件** vs **跨项目准则**。

**强约束**(详见 ADR 0004 § 3.3):项目特有事件不论 cwd 在哪、不论 resolver 落到什么 source,**都不得写入 default**。

写入合法性校验:

| resolver_source | scope=project | scope=cross-project | scope=derivation |
|---|---|---|---|
| 项目 source(pi-astack 等) | ✅ 写项目 | ✅ 写 default1 | ✅ 拆双写1 |
| `default`(未注册仓 fallback) | ⛔ **拒写**,pending queue | ✅ 写 default1 | ⛔ **整条 pending**(不允许半写) |

1 default 写入门槛抬高:confidence ≥ 7 + 3/3 全票同意 scope=cross-project。详见 ADR 0004 § 3.4。

这保证 `default` source 永远只是高价值跨项目抽象准则,federated search 结果不会被某项目具体事件污染。

### 未注册 / 不可信仓 review UX

详见 ADR 0004 § 3.5。alfadb 在 `/memory-pending review <id>` 时看到 4 选项:
1. 注册 source 或信任当前 path(重复使用此仓推荐)
2. 标 `.gbrain-scratch`(实验仓,跳过 sediment)
3. 强写 default(明知风险,仅 cross-project)
4. 丢弃(不值得保留)

绝大多数情况选 1,跑一行 `gbrain sources add foo --path . && echo foo > .gbrain-source && git add .gbrain-source` 就把 pending 解封 + 同时建立跨设备 dotfile。

### .gbrain-scratch marker

某些临时实验仓(短命、不值得长期沉淀),alfadb `touch .gbrain-scratch` 后 sediment 在 agent_end **完全跳过**该仓的所有写入决策(连 voter 都不跑,省 token)。

```
~/work/throwaway-experiment/
├── .git/
├── .gbrain-scratch    ← marker,sediment 看到就 skip,不需任何 review
└── ...
```

`.gbrain-scratch` 内容无关紧要,存在性即信号。

## ~/.pi 现有沉淀的归属(再确认)

`~/.pi/.pensieve/` 现有 6 maxim + 23 decision + 62 short-term + 4 pipeline,**全部**关于 ~/.pi 工作流本身,归 `pi-astack` source(federated=false)。迁移路径详见 ADR 0006 与 migration/steps.md P1。

## 配置位置

`defaults/pi-astack.defaults.json`(package-local fallback / 文档示例,不被 pi 自动加载):

```json
{
  "piStack": {
    "memory": {
      "projectSource": "pi-astack",
      "routeVia": "gbrain official resolver + sediment source trust guard"
    }
  }
}
```

运行时配置必须从官方 pi settings chain 读取:`~/.pi/agent/settings.json` + 项目 `.pi/settings.json`,嵌套对象按 pi 官方 settings 语义 merge。

`~/.pi/.gitignore`:
```
.gbrain-cache/         # markdown export 输出,每次 agent_end 刷新
.gbrain-scratch        # 临时实验仓 marker
# 不加 .gbrain-source -- 该文件必须 commit
```

`pi-astack/.gitignore`:
```
.gbrain-cache/
.gbrain-scratch
# 同上:不加 .gbrain-source
```

## 后果

### 正面
- 跨设备开发同一项目通过 dotfile 同步,绝对路径不再是阻碍
- 路由完全跟随 gbrain 官方语义,不另造一套
- default source 洁净度强约束保护(详见 ADR 0004)
- `.gbrain-scratch` 给临时仓留逃生口
- ~/.pi/.pensieve/ 历史沉淀 100% 归 pi-astack source(语义保真)

### 负面
- alfadb 在新机器首次安装:clone ~/.pi 后还要 `gbrain sources add pi-astack --path <本机路径>`(虽然 dotfile 已能让 resolver 命中,但 `local_path` 注册仍是本机便利所需,例如 `gbrain export --dir <auto>`)
- alfadb 进新项目仓首次跑 pi 会有"sediment 拒写 + pending 提示"的中断,但这是设计目标(避免污染 default)

## 引用

- ADR 0001: pi-astack 定位
- ADR 0002: gbrain 作为唯一记忆存储
- ADR 0004: sediment 写入策略(含 default 写入合法性校验)
- ADR 0007: offline 降级模式与 .gbrain-source 重新定位
- gbrain v0.18 source resolver: `~/gbrain/src/core/source-resolver.ts`
- gbrain 多源指南: `~/gbrain/docs/guides/multi-source-brains.md`
