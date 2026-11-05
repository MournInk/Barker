# Barker

一个私有部署的提醒工作空间。用一次安排，把工作与生活中的重要时刻交给 Bark。

Next.js App Router + React 19 + HeroUI React V3 + SQLite。唯一包管理器为 pnpm，Node.js 需要 24 或更高版本。

## 工作流程

1. 启动服务，从终端或容器日志取得访问密码，进入工作空间。
2. 在「推送设置」填写 Bark 服务地址与 Device Key，保存后发送测试通知。
3. 创建提醒：名称、可选正文、开始时间、重复周期，以及重复次数或截止日期。
4. 在「工作概览」查看统计和未来七天的安排，在「所有提醒」编辑、暂停、恢复、复制或归档。
5. 在「投递记录」检查每条消息的状态、尝试次数、错误与下次重试时间；需要时可提前重试。

所有列表、统计和排期均使用实际服务端数据；没有内置演示任务。配置未完成时，也可以先创建提醒，到期消息会保留在队列中。

### 排期规则

- 时区固定为 `Asia/Shanghai`（北京时间），不随浏览器或宿主机时区改变。
- 预设包括每天、工作日、每周、每月，也支持五段 cron：`分 时 日 月 周`。
- 开始时间是允许执行的最早分钟，不是无条件立即推送。创建时已过去的排期不会补发。
- 每月预设沿用相同日历日；29–31 日在不存在该日期的月份跳过。
- 次数指总排期次数，包含已入队但尚未成功的消息。失败重试不额外消耗次数。
- 截止日期包含当天；「排期结束」不等于所有消息已送达，剩余队列仍会继续投递。
- 服务停机期间、处于进行中状态的任务会在重启后补排。明确暂停的时间段不补发。
- 编辑、暂停或归档之前，会先保存操作时已经到期的提醒。编辑不会改写旧消息的标题和正文。
- 归档停止未来排期，不删除任何投递记录或待发送消息。历史任务可以复制为新提醒，没有强制丢弃入口。

### 可靠投递的边界

每个到期时刻先以唯一的 `(task_id, occurrence_at)` 写入 SQLite outbox，再发送 HTTP 请求：

```text
pending -> sending（2 分钟租约）-> sent
              |                   ^
              +-> pending -> 重试-+
```

- 网络错误、超时、HTTP 错误、无效响应、错误 Device Key 等均保留消息，持续重试，不设失败次数上限，也不会自动暂停未来排期。
- 退避从 5 秒开始翻倍，上限 1 小时。只有收到 HTTP 成功且 JSON `code: 200` 的确认后才记为送达。
- 修改 Bark 配置会提前唤醒等待中的消息；修正错误配置后无需逐条恢复。
- 发送中的消息由租约保护；进程异常退出后，租约到期会重新领取。迟到的旧 worker 无权覆盖新租约。
- 调度器每 2 秒检查到期提醒；每轮补排最多 500 个时刻，发送最多 20 条。慢网络不阻止后续到期消息入队。
- 超过 500 条未补排积压时，编辑/暂停/归档会原子拒绝，让调度器分批补排后再操作，不截断或丢弃积压。

**这是至少一次投递，不是恰好一次。** Bark 已收到请求但确认包丢失、或进程在确认落库前退出时，重试可能产生重复通知。「已送达」表示 Bark API 已确认接收，不代表 iPhone 已显示通知。服务可用性、磁盘空间与持久化数据安全仍需由部署者保障。

## Docker 本地运行

```bash
cp .env.example .env
# 可选：在 .env 设置至少 16 字符的 BARKER_PASSWORD

docker compose up -d --build
docker compose logs -f barker
# 访问 http://localhost:3000
```

Compose 从当前代码构建 `barker:local`，不是已发布的新版本。默认只绑定 `127.0.0.1`；需要跨设备访问时，可设置 `BARKER_BIND_ADDR`，并建议置于 HTTPS 反向代理后。`.env` 中的访问密码等配置会在运行时传入容器，不进入镜像。

也可以直接使用命名卷：

```bash
docker build -t barker:local .
docker run -d --init --name barker \
  -p 127.0.0.1:3000:3000 \
  -v barker-data:/app/data \
  barker:local
docker logs barker
```

镜像基于固定版本与摘要的 Node 24 Alpine，多阶段构建 Next.js standalone，使用 UID/GID `1001:1001` 非 root 用户运行。健康检查访问 `/api/health` 并读取数据库。若使用绑定目录而非命名卷，需要确保该用户有写入权限。

构建会排除运行时数据与本地环境文件，并检查 standalone 产物中没有数据库、WAL 或密钥，避免把开发环境状态打进镜像。

停止与更新：

```bash
docker compose stop                   # 保留数据
# 更新代码后
docker compose up -d --build
```

不要使用 `docker compose down -v`，除非确实希望删除任务、队列、配置与密钥。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BARKER_PASSWORD` | 自动生成 | 至少 16 字符；未设置时首次生成并写入数据目录，后续启动复用、在日志打印 |
| `BARKER_SESSION_SECRET` | 自动生成并持久化 | 至少 16 字符，用于 HMAC 会话签名 |
| `BARKER_DATA_DIR` | `./data`；容器 `/app/data` | SQLite 数据库与密钥文件目录 |
| `BARKER_TRUST_PROXY` | 不信任 | 仅在可信反代后设置 `1/true/yes`，用于限流地址和 HTTPS Cookie 判定 |
| `BARKER_COOKIE_SECURE` | 不强制 | `1/true/yes` 强制会话 Cookie 的 Secure 属性；不要在纯 HTTP 环境开启 |
| `BARKER_BIND_ADDR` | `127.0.0.1` | 仅 Compose，宿主机绑定地址 |
| `BARKER_PORT` | `3000` | 仅 Compose，宿主机端口 |
| `PORT` | `3000` | standalone 服务的内部监听端口；开发时使用 `pnpm dev --port 3100` |
| `HOSTNAME` | 容器 `0.0.0.0` | standalone 监听地址 |

`BARKER_DISABLE_SCHEDULER=1` 仅供隔离预览和构建验证使用，**正常运行不要设置**，否则不会自动投递。

会话有效期为 12 小时，Cookie 使用 `HttpOnly + SameSite=Lax`。连续输错 5 次会锁定对应限流键 10 分钟；不信任反代头时，所有客户端共享该限流键。密钥文件过短或损坏会导致启动失败，需要先备份并人工处理，避免空密码或弱签名继续运行。

## 本地开发与验证

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev

pnpm test
pnpm exec next typegen
pnpm typecheck
pnpm lint
pnpm build
pnpm start
```

测试使用临时数据目录，不使用现有的 `data/`。生产构建如需完全隔离本地数据，可以指定临时的 `BARKER_DATA_DIR` 并设置 `BARKER_DISABLE_SCHEDULER=1`；运行时不要沿用后者。

### 容器端到端冒烟

```bash
docker build -t barker:local .
pnpm test:container
```

该脚本使用独立命名卷、随机本地端口和本地模拟 Bark，不会连接真实设备。它实际等待一个分钟级排期，验证：非 root 启动、随机密码、未授权拦截、配置密钥脱敏、HTTP 503 后保留、归档后继续投递、停止/重启后自动恢复、成功确认及健康检查。通常需要 1–2 分钟，结束时清理自己的容器与卷。

## 数据与升级

数据目录包含 `barker.sqlite`、SQLite 的 WAL/SHM 文件、`access-password.txt` 与 `session-secret.txt`。Device Key 存在服务端 SQLite 中，不会由设置接口回显；它**没有进行静态加密**，数据目录和备份均应按秘密材料保护。

推荐备份步骤：

1. 停止 Barker，确认没有其他进程写入同一数据库。
2. 备份整个数据目录或命名卷，包含数据库和密钥文件。
3. 启动 Barker。

在线备份应使用 SQLite 一致性快照，不能在运行中分别复制数据库和 WAL 来代替一致性备份。不要在网络文件系统上共享 SQLite，也不建议启动多个实例共同挂载同一目录。此项目需要常驻 Node 进程和持久磁盘，不适合短生命周期 serverless 部署。

本次重构对既有数据库做事务式增量迁移，不清空任务和投递历史。旧 delivery 没有历史消息快照，迁移时只能使用当时的任务内容补齐；此后新消息内容不可变。旧版本因永久错误自动暂停的任务仍保持暂停，需要手动恢复。建议更新前完成备份，升级后不要直接用旧代码写入新数据库。

长期失败和历史记录不会自动删除，需监控磁盘空间；自动清理不能以丢弃未送达消息为代价。

## 代码结构

```text
app/                       概览、提醒、投递、设置四个页面
app/api/                   会话、任务、预览、投递/重试、设置、健康检查
components/                认证入口、工作空间、导航、任务编辑器、HeroUI 组合组件
lib/db.ts                  SQLite 迁移、outbox、租约、事务式任务操作
lib/cron.ts                时区、cron 预设、编辑预览、七日安排
lib/scheduler.ts           有界补排、发送、持续重试
lib/bark.ts                Bark HTTP 协议、超时、显式成功确认
lib/auth.ts                密码、签名 Cookie、限流
lib/validation.ts          Zod 输入约束
scripts/container-smoke.mjs 真实容器端到端检查
scripts/verify-standalone.mjs 构建产物的隐私数据检查
scripts/ci-scope.mjs        按改动选择 CI 验证范围
tests/                     业务、API、安全、迁移和重启持久化测试
```

前端使用实际的 `@heroui/react` V3 组件、Manrope 自托管字体及本地 Gravity 图标；采用暖白、森林绿、圆角表面和响应式侧栏。HeroUI Pro React MCP 未提供可用授权，Figma Kit 的 MCP 访问受当前配额限制，因此本次实现采用 HeroUI V3 公共组件与所提供的设计准则，不声称像素级复刻 Figma 或使用付费 Pro 组件。

分支、PR 和合并队列的检查在 `.github/workflows/ci.yml`，根据改动选择对应单元测试；应用改动检查类型与生产构建，调度或容器改动追加独立容器冒烟。默认不接触真实 Bark，也不发布镜像。

现有版本发布流程保留在 `.github/workflows/release.yml`。本地验证、提交、远程 CI、镜像发布与部署是不同步骤；构建或修改本项目不代表已发布新版本。

## License

MIT © MournInk
