# dsh-input-history

输入框 **↑/↓ 输入历史** 独立插件，DeepSeek Harness (DSH) Web。

从 dsh-file-mention 拆分而来：**每次发送（回车或点发送按钮，任意会话/工作区）都同步落库**到一份**全局历史环**，↑/↓ 按键时**同步读取**，召回即时且完整——不做任何异步历史 RPC、没有失效刷新，彻底消除「历史不全/时有时无」的问题。

| 能力 | 说明 |
| --- | --- |
| **发送落库** | 输入框每次发送都**同步**记录：回车（捕获阶段 keydown，含 IME/trigger 菜单/锁定态守卫）与点发送按钮（点击后校验草稿被清空，即平台 commitSend 已执行）两条路径全覆盖 |
| **附件也记录** | 一条发送如实记录**文本 + 图片 + 文件引用**：草稿文本保留，待发送文件胶囊（dsh-file-upload）以 `@token` 引用形式、草稿图片以 `[图片: 文件名]` 标记形式并入同一条历史；图片-only/空文本发送不再被丢弃 |
| **原生召回** | ↑/↓ 召回时把历史**原样恢复成输入框原生样式**：文本进文本框、图片恢复成真实缩略图附件、文件引用恢复成待发胶囊（`[图片: …]`/`@token` 标记只留在历史文本里，不会堆进输入框）；仅当前页面会话内有效，重启后图片退化（文件 `@token` 文本仍保留） |
| **全局共享** | 历史环**不绑定会话/工作区**，任意会话、任意工作区共用一份；合并时折叠旧版 `<file>` 块回 `@路径`、跳过空白、连续重复只留一条 |
| **↑/↓ 导航** | 空输入框按 ↑ 召回上一条已发送 prompt；↑/↓ 在历史间移动；↓ 越过最新条恢复原始草稿；手动编辑自动退出浏览态；trigger 菜单打开时按键让位给菜单 |
| **持久化** | 历史环的**耐久副本**落在 DSH home 下的 `input-history.json`（`$DSH_HOME` 覆盖，默认 `~/.dsh/input-history.json`），通过宿主半的围栏 API `/input-history/api` 读写（原子写：tmp+rename，并发写串行化）。localStorage 只作**同步缓存**（瞬时召回），启动时与宿主文件做一次并集合并（宿主序在前、本地独有条目追加在后），宿主落后时回写补齐 |

## 为什么存文件而不是 localStorage

DSH Web 桌面端每次启动都在**随机回环端口**上提供服务（例如 `127.0.0.1:64414`），而 localStorage 以**源（host+port）为作用域**——端口一变，旧源的历史就「没了」。因此历史环的耐久副本必须落在宿主进程管理的**用户目录文件**里（`~/.dsh/input-history.json`），重启、换端口、清 localStorage 都不会丢。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-input-history
```

`dsh.bundle.patch` 声明会让 CLI 自动把本包追加进 profile 的 bundles：宿主半挂载 `/input-history/api` 围栏路由并管理 `~/.dsh/input-history.json`，客户端半负责记录、导航与启动时对账。然后**重启 DSH 桌面应用**并刷新页面。零运行时依赖，无 peer / 构建要求。

卸载：`dsh plugin --profile web remove dsh-input-history`。

开发迭代：改完代码运行 `scripts/deploy.sh`（同步 lib 到 profile 安装目录）后重启。

## 配置

历史环上限默认 100 条；可在浏览器 console 里覆盖（下次发送生效，删除该键恢复默认）：

```js
localStorage.setItem("dsh-input-history:history-limit", "200")
```

> 上限也会随每次写入持久化进宿主文件；**重启后若未设置本地覆盖，会自动沿用宿主文件里的上限**（否则换端口后上限会因 localStorage 丢失而重置回 100）。

## 架构

```
┌ composer (ui-conversation, 不改) ─────────────────────────────┐
│ Enter keydown（window 捕获）→ 守卫（IME/菜单/锁定/忙碌）      │
│   → recordFullSend：文本 + 待发胶囊 + 图片 Files → 落库       │
│ 发送按钮 click（捕获）→ 快照草稿+图片+待发胶囊 → 校验清空     │
│   → recordCaptured(快照)                                       │
│ ↑/↓ keydown（捕获）→ loadHistory() 同步读全局环              │
│   → historyNav 纯函数 → applyRecall：                          │
│     原生召回 = 原文本 setDraft + 图片重建附件 + 胶囊回 rail    │
│ 内存附件表：Map<历史条目文本, {text, files, imageFiles}>       │
│   （仅本页面会话；重启后清空 → 退化为文本召回）                │
│ 发送捕获：imageIds → conversation.draftImages() 取 File/文件名│
│   待发胶囊：window.__dsh_file_upload_pending__.chipsOf(session)│
│   召回回写：window.__dsh_file_upload_pending__.setChips(...)   │
│ 启动对账 → GET 宿主环 → 并集合并 → 本地落后则回写宿主        │
│ 每次落库 → 防抖 300ms 回写宿主（页面卸载 keepalive 兜底）    │
│ 启动 warm → 一次性合并当前会话历史 prompt + 迁移旧键         │
└──────────────────────────────────────────────────────────────┘
        │ 宿主半 (index.js)：围栏 POST 路由
        │   history.read  -> 读 ~/.dsh/input-history.json
        │   history.write -> 校验/截断/上限 -> tmp+rename 原子写
        ▼
   ~/.dsh/input-history.json   ← 耐久副本
```

- 客户端 bundle 以 `window.__ModuleLoader__.load` 约定注册，**不 require 任何模块**（纯逻辑，无 React），规避 externals 漂移，无需打包器。
- 键盘仲裁、IME 守卫、菜单渲染全部由 DSH 内建管线承担；本插件只在捕获阶段补记录与历史导航。
- 宿主半复用与 `/api` 网关一致的浏览器信任围栏（回环 Host 或 `webRuntime.trustedHosts` + 同源标记），POST-only、JSON 体上限 1MB。
- 与 dsh-file-mention / dsh-file-upload 解耦：三者可独立安装/卸载/升级；历史数据通过旧键迁移平滑交接。文件引用（`@token`，dsh-file-mention 已在草稿文本里；dsh-file-upload 待发胶囊经其 `window.__dsh_file_upload_pending__` 钩子读取/回写）与图片（`[图片: 文件名]` 标记）都并入历史入口。

## 已知限制

- **原生召回（图片缩略图 + 文件胶囊）只在同一页面会话内有效**：附件的 File 对象与胶囊信息只存内存表，重启后召回退化为历史文本（文件 `@token` 保留、可重发；图片只剩 `[图片: 文件名]` 标记，不可重建）
- keydown/点击命中依赖 DOM 结构约定（`data-composer-card`），DSH 前端大版本变更时需适配
- 预热迁移依赖 `sessions.history` RPC（尽力而为，失败则从空环开始累积，不影响发送落库与 ↑/↓ 导航）
- 宿主写为防抖（300ms）+ 页面卸载兜底，多窗口同时写时「最后一次写赢」；文件损坏按空环处理并随后续发送重建
- 与 dsh-file-upload 的衔接依赖其暴露的 `window.__dsh_file_upload_pending__` 钩子（`chipsOf` 读取 / `setChips` 回写）；该插件缺席或尚未挂载时，待发文件引用退化为不记录（草稿文本照常记录）

## 测试

```sh
node --test test/*.test.js
```

26 个用例：客户端（块折叠、图片/待发文件合成、历史状态机、历史环落库、上限覆盖/损坏容错、旧键迁移、prompt 提取（含图片）、并集合并、宿主 API 调用、启动对账幂等）+ 宿主（路径解析、环归一化、文件原子读写、路由与围栏、并发写串行化、插件形状）。
