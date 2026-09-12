# Nebulaw-Ontology Pilot — 保留的 v1 入口与 v2 领域适配

`pnpm demo:plus` 及 `http://127.0.0.1:4183` 对应保留的 v1 演示入口。其八工作台、P33 参考推演和旧学习器不是本体驱动 v2 的实现或验收证据；不要据此启动、迁移或切换现有主服务。

当前建设依据为[本体驱动 Plus 设计](../../../PLUS_EXECUTABLE_DESIGN.md)，实际状态见[实施记录](../../../IMPLEMENTATION_PROGRESS.md)。v2 复用本目录的原生存储与 Task 领域适配，通过独立的 `ops/plus-v2` 入口装配已审核本体、非 Transformer 计算和原生治理。它尚未完成八工作台、完整部署和浏览器交接；`public-plus/` 的旧页面不能当作 v2 已交付界面。v1 启动细节仅供历史维护，见[旧交接文档](../../PALANTIR_PLUS_HANDOFF.md)。

## 以下为 Atlas Loop 旧隔离参考实现的历史说明

以下 4173/4174 与旧学习器说明不是当前平台入口，不得将旧实现作为新平台事实来源。旧安全测试保留，不恢复旧不安全动作。

当前版本：2026-09-05 修复版。只允许合成数据；不是法律意见系统，不是 Palantir 官方开源产品，也不是原研究 LWM 已接通的声明。

## 实际架构

浏览器 → 4173 静态资源/认证转发网关 → 4174 Open Foundry 的 /api/lwm 扩展 → 单一持久化业务状态。

开发扩展使用 SQLite WAL/FULL；生产扩展代码使用平台 PostgreSQL pool、事务和行锁。
页面没有内存业务后备模式：平台不可达时请求失败，不会显示另一套“成功”数据。
平台原生 /api/v1 下的 lwm-demo 种子对象是历史模式参考，不是此扩展的实时对象投影；不要混用。
旧 7 个 YAML 动作已停用（注册表不提供执行清单，清单本身也有 false 前置条件）。
因此本实现是 Open Foundry 上的定制命令扩展，尚未完成通用 Ontology/ObjectManager/OpenFGA 的对象级统一。

## 本地启动

需要 Node.js 24+、pnpm 9.15.4。node:sqlite 在本次 Node 24.13.0 上仍报告实验性警告。
从项目根目录运行。首次初始化：

```powershell
pnpm build
node apps/lwm-demo/setup-local.mjs
```

首次初始化拒绝覆盖已有凭据。当前工作区已初始化，不要重复执行。
本地凭据在项目 var/lwm 下，已加入 Git/Docker 忽略列表，当前 Windows 目录 ACL 已限制为当前用户。
auth.json 仅含令牌哈希；local-access.json 是本地演示发放文件，含 6 个个人角色令牌，24 小时后过期。
不要提交、上传或把整份发放文件分享给同事。正式环境必须由身份提供方给不同人员分配角色。

若旧版 4173/4174 进程还在运行，先手动关闭原启动终端或在任务管理器确认并停止对应 Node 进程。
本次工具策略拦截了停止旧进程，旧进程并未自动更新；进程号应重新核对，不能永久依赖报告中的 PID。
原合成状态已保存在 var/lwm/legacy-demo-snapshot-2026-09-05.json，不自动将未验证的旧反馈迁入训练集。

终端一：

```powershell
$env:LWM_AUTH_FILE = (Resolve-Path ./var/lwm/auth.json).Path
$env:LWM_DATABASE_PATH = Join-Path (Get-Location) 'var/lwm/foundation.sqlite'
$env:HOST = '127.0.0.1'
$env:PORT = '4174'
pnpm demo:lwm:platform
```

终端二：

```powershell
$env:LWM_PLATFORM_URL = 'http://127.0.0.1:4174'
$env:HOST = '127.0.0.1'
$env:PORT = '4173'
pnpm demo:lwm
```

打开 [本地控制台](http://127.0.0.1:4173)，使用自己的本地令牌登录。令牌只存于页面内存，刷新即清除。
开发平台和网关默认且强制绑定回环地址；不要为了容器连通而开启开发 allow-all 对外监听。
正式部署使用生产启动入口，而不是 openfoundry-dev.mjs。

## 角色和演示步骤

| 角色 | 可执行操作 |
|---|---|
| investigator | 新增合成事项、创建证据提交 |
| case_reviewer | 独立核验证据、批准/修正/拒绝建议、请求补证 |
| data_reviewer | 独立核验反馈结果与数据资格、撤回标签 |
| trainer | 执行训练及评测 |
| model_owner | 发布候选、回滚 |
| viewer | 查看同一合成工作区 |

1. 调查人提交来源引用、证据文件 SHA-256 和结果。状态变成 AWAITING_REVIEW，门仍然阻断。
2. 另一名复核员核对原证据和摘要，输入依据并确认。服务端检查不同主体、对象关联、任务终态和事项状态后重新计算合成规则。
3. 复核员裁定；反馈为 PENDING，不立即入训。REJECT 不自动把原状态当成正确标签。
4. 独立 data_reviewer 核对真实结果标签及资格后，反馈才为 ELIGIBLE。
5. trainer 训练。90 条明确标注的合成启动样本加合格反馈形成不可变快照；36 条固定合成留出样本参与评测。
6. 符合门槛时生成候选，不符合时自动 HELD。model_owner 不能与训练人相同。
7. 发布后 /api/lwm/infer 确实读取新制品；回滚严格使用已登记且通过哈希验证的上一制品。
8. 使用“新增合成事项”重复流程，验证第二轮学习。重启不会清空已记录的数据。

补证摘要由人工对文件核对，并非服务端已下载、扫描或验证文件真实性；本地规则仅是 synthetic-v2。
这是 CPU 分类计数参考学习器，特征只有来源状态；不能据留出集高分推断法律任务泛化能力。
原研究 M4.1B/LWM 的结构化公开输入和监督契约与此反馈格式不同，尚未实现可信映射。

## API 约束

所有业务读取需要 Bearer 身份；写入同时需要 If-Match: <revision> 和唯一 Idempotency-Key。
身份来自令牌，提交的 reviewer/approver 文本不构成权限。
401=未认证；403=角色或工作区不符；428=缺少版本条件；409=冲突或业务门阻断。
冲突后应刷新状态重新审查；传输失败重试应复用原请求的幂等键。
reset 接口已移除，防止未经授权重置持久数据。

## 后台学习与事件归档

默认手动训练，没有虚构的“下一训练窗口”。
本地可在启动平台前设置 LWM_TRAIN_INTERVAL_MS=60000，启用定时检查、候选训练及本地事件归档；永不自动晋级。
事件先投递到按 ID 去重的追加型归档，再确认源 outbox。已测试“投递成功但确认前中断”的重放。
本地归档在数据库路径后追加 .archive.sqlite；SQLite 触发器和哈希链不是外部 WORM 存储。
生产后台任务要求 LWM_ARCHIVE_URL（HTTPS）和 LWM_ARCHIVE_TOKEN；HTTP 归档适配器会发送同租户审计事件，只有收到匹配事件 ID、哈希及 durable=true 的回执才确认投递。
归档服务须由部署方提供幂等写入与保留策略，并独立验证 WORM；未调用或验收任何外部归档服务，不能把本地测试当作生产事件系统验收。

## 备份

SqliteStore.backup(destination) 使用 VACUUM INTO 生成新备份，拒绝覆盖非空目标。
恢复时使用已验证备份的新路径，并在服务停止后变更 LWM_DATABASE_PATH；不要直接覆盖正在使用的 WAL 数据库。
当前测试包含独立进程恢复和备份读回。云端 PostgreSQL PITR、权限隔离和灾备仍需单独演练。

## 验证与生产禁行

```powershell
pnpm build
pnpm typecheck
pnpm demo:lwm:test
pnpm test
node audit/continuous-learning-readiness.mjs --local-only
```

不加 --local-only 时，审计脚本仍以非零退出，因为生产验收未完成；不要把本地测试通过等同于上线批准。
生产路径需要 LWM_EXTENSION_ENABLED=true、平台要求的 PostgreSQL/OIDC/OpenFGA/CEL 配置和 HTTPS。
API Dockerfile 已更新到 Node 24 并包含扩展代码，但容器未构建验证（本机 Docker daemon 未就绪）。
详情见项目根目录的 LWM_REMEDIATION_2026-09-05.md。
