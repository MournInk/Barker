# Barker

一个私有部署的 Bark 周期提醒工作空间。Next.js App Router、React 19、HeroUI React V3 与 SQLite 组成单一应用；唯一包管理器是 pnpm，运行时要求 Node.js 24 或更高版本。

## 工作流程

1. 启动服务，从首次启动日志取得自动生成的访问密码，或通过 `BARKER_PASSWORD` 指定密码。
2. 在「推送设置」填写 Bark 服务地址与 Device Key，保存后发送测试通知。
3. 创建提醒：名称、可选正文、开始时间、重复周期、任务时区，以及重复次数或截止日期。
4. 在「工作概览」查看接下来七天的安排、待投递数量和最近活动。
5. 在「所有提醒」编辑、暂停、恢复、复制或归档；在「投递记录」查看尝试历史、手动重试或取消等待中的单次投递。

所有列表、统计和排期都来自服务端数据，没有内置演示任务。尚未配置 Bark 时也可以创建提醒，到期消息会持久保存在队列中。

## 排期规则

- 每个任务使用一个有效 IANA 时区，默认 `Asia/Shanghai`。预设周期会按该任务时区的墙上时间生成五段 cron。
- 概览、投递记录和今日统计统一按北京时间展示；任务本身仍按各自时区执行。
- 开始时间是最早允许执行的分钟。新建任务时已经过去的排期不会补发。
- 每月预设沿用相同日历日；29–31 日在不存在的月份跳过。
- 次数指累计排期次数，包含已入队、已取消或已过期的排期。失败重试不额外消耗次数。
- 截止日期包含当天；「排期结束」只表示不再生成未来排期，已有队列仍会继续处理。
- 服务停机期间，进行中的任务会在重启后补排；用户明确暂停的时间段不补发。
- 编辑、暂停、归档或删除前，会先保存在操作时已经到期的提醒。历史投递保留创建时的标题和正文快照。
- 更新任务内容时，请求内最多补排 500 个历史时刻；仍有积压会返回冲突。暂停、恢复和归档会保存明确的时间边界，由调度器继续分批追平，避免截断或丢消息。

## 投递模型

每个到期时刻先以唯一的 `(task_id, occurrence_at)` 写入 SQLite outbox：

```text
pending -> sending（2 分钟租约）-> sent
   |             |
   |             +-> pending（失败退避）
   +-> cancelled / expired
```

- 每轮最多补排 500 个时刻、发送 20 条，并使用 4 个并发发送 worker；补排会主动让出事件循环。
- 网络错误、超时、HTTP 错误、无效响应和错误 Device Key 都保留消息。失败后从 5 秒开始指数退避，单条退避上限为 1 小时。
- HTTP `429` 和 `503` 的 `Retry-After` 同时支持秒数与 HTTP 日期，最长延后 7 天。
- 同一 Bark 端点失败后会短暂冷却：永久错误冷却 60 秒，临时错误冷却 5 秒，减少并发请求同时撞上坏配置。
- Device Key 只在服务端使用，响应、错误和日志会脱敏；修改设置会提前唤醒等待中的消息并清除旧冷却。
- 成功条件必须是 HTTP 2xx 且 Bark JSON 返回数值 `200` 或规范字符串 `"200"`。空响应、HTML、数组及可强转的伪 200 都不算送达。
- 最终 Bark JSON 不超过 4096 字节。任务标题和正文合计不超过 3000 个 UTF-8 字节，密钥与通知选项合计最多 1096 字节，为正文保留空间。
- 任务可以设置「允许延迟」；超过计划时间加允许延迟仍处于 `pending` 的消息会标记为 `expired`。发送中的请求可能已经被上游接收，无法撤回。
- 投递记录可以手动重试；等待中的单次消息也可以取消。已结束记录保留正文和最近 100 次尝试，设置页面分批清理 30 天前的记录；清理 API 允许自定义至少 7 天前的截止点。

**这是至少一次投递，不是恰好一次投递。** 如果 Bark 已接收请求但确认包丢失，或进程在确认落库前退出，重试可能产生重复通知。「Bark 已接收」表示 Bark API 确认接收，不代表设备一定展示通知。服务可用性、磁盘空间和数据安全仍需由部署者负责。

## 并发编辑与 API

- 任务编辑、暂停/恢复、归档以及设置保存都带修订号；版本落后时返回 `409`，缺少修订号时返回 `428`。
- 新建任务可带 `Idempotency-Key: <16–128 位 A-Z/a-z/0-9/_/->`。相同键和相同内容会返回同一任务，不同内容返回 `409`。
- API 请求体上限为 64 KiB；`POST`、`PUT`、`PATCH` 只接受同源 `application/json`，所有写请求都会拒绝跨站浏览器来源。
- API 处理函数中的错误统一返回 JSON；数据库或认证存储故障返回脱敏后的 500。启动配置或数据库迁移失败时，服务拒绝启动，健康检查不会返回成功。

## Docker 运行

```bash
cp .env.example .env
# 可选：在 .env 设置 16–300 字符的 BARKER_PASSWORD

docker compose up -d --build
docker compose logs -f barker
# 访问 http://localhost:3000
```

Compose 从当前代码构建 `barker:local`。默认只绑定 `127.0.0.1`；跨设备访问时设置 `BARKER_BIND_ADDR`，并建议放在 HTTPS 反向代理后。`.env` 在运行时传入容器，不进入镜像。

也可以使用命名卷直接运行：

```bash
docker build -t barker:local .
docker run -d --init --name barker \
  --stop-timeout 30 \
  -p 127.0.0.1:3000:3000 \
  -v barker-data:/app/data \
  barker:local
docker logs barker
```

镜像使用固定 Node 24 Alpine 摘要、多阶段 standalone 构建和 UID/GID `1001:1001` 非 root 用户。健康检查同时验证 SQLite 可写和调度器心跳；调度器被禁用、数据库只读或心跳过期时，`/api/health` 返回 `503`。

生产启动入口使用进程间通知停止调度：先等待正在发送的请求完成，再把终止信号交给 Next.js 关闭 HTTP 服务。最多等待 20 秒；超时中断的租约由下次启动恢复。

停止与更新：

```bash
docker compose stop
docker compose up -d --build
```

`docker compose down -v` 会删除任务、队列、配置和密钥，除非明确希望清空数据，否则不要使用。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BARKER_PASSWORD` | 自动生成 | 16–300 字符；未设置时首次生成并写入数据目录，生成后的密码只在首次启动日志打印一次 |
| `BARKER_SESSION_SECRET` | 自动生成并持久化 | 16–300 字符，用于 HMAC 会话签名 |
| `BARKER_DATA_DIR` | `./data`；容器 `/app/data` | SQLite、密码和会话密钥目录 |
| `BARKER_TRUST_PROXY` | 不信任 | 仅在可信反代后设置 `1/true/yes`，用于限流地址与 HTTPS Cookie 判断 |
| `BARKER_COOKIE_SECURE` | 不强制 | `1/true/yes` 强制 Secure Cookie；纯 HTTP 环境不要开启 |
| `BARKER_BIND_ADDR` | `127.0.0.1` | 仅 Compose，宿主机绑定地址 |
| `BARKER_PORT` | `3000` | 仅 Compose，宿主机端口 |
| `PORT` | `3000` | standalone 服务内部监听端口 |
| `HOSTNAME` | 容器 `0.0.0.0` | standalone 监听地址 |

`BARKER_DISABLE_SCHEDULER=1` 只用于隔离构建、浏览器回归和预览。正常运行时必须移除该变量，否则健康检查会失败且不会投递。

会话有效期 12 小时，退出登录会撤销服务端会话；密码指纹变化会使旧会话失效。连续 5 次错误后，该客户端键的错误尝试在 10 分钟内返回 `429` 与 `Retry-After`；正确密码仍可登录，避免共享地址下的恶意请求挡住管理员。失败登录表有容量上限；直接暴露服务时仍应使用足够长的随机密码。

如果首次自动生成的密码日志已经丢失，可由数据目录所有者读取 `access-password.txt`，或显式设置 `BARKER_PASSWORD` 并重启服务。

## 本地开发与验证

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev

pnpm test
pnpm exec next typegen
pnpm typecheck
pnpm lint
BARKER_DATA_DIR="$(mktemp -d)" BARKER_DISABLE_SCHEDULER=1 pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

单元与集成测试使用临时数据目录，不读取现有 `data/`。浏览器测试会启动隔离的生产服务，禁用调度器，不连接真实 Bark。

工作流语法回归需要 Bash；在 Alpine 测试环境中运行 `pnpm test` 前需要安装该测试依赖。

构建后使用 `pnpm start` 启动 standalone 服务；入口会补齐本地静态资源。可通过 `HOSTNAME` 和 `PORT` 指定监听地址及端口。

### 容器端到端冒烟

```bash
docker build -t barker:local .
pnpm test:container
```

脚本使用独立命名卷、随机本地端口和本地模拟 Bark，验证非 root 启动、认证、设置密钥脱敏、失败入库、归档后继续投递、停止/重启恢复、自动重试及健康检查。通常需要 1–2 分钟，完成后会清理自己的容器与卷。

## 备份与恢复

不要只复制正在运行的 `barker.sqlite`，因为 WAL 中可能还有数据。项目提供基于 SQLite 在线备份 API 的一致性快照：

```bash
# 默认从 ./data 或 BARKER_DATA_DIR 备份到新目录
pnpm data:backup /secure/backups/barker-20261112

# 从新目录恢复，源目录必须已经备份
pnpm data:restore /srv/barker/data-restored /secure/backups/barker-20261112
```

备份目录必须不存在；命令创建权限为 `0700` 的目录和 `0600` 的文件，并生成包含 SHA-256 校验和的 `manifest.json`。恢复同样拒绝覆盖任何已有目录，会验证完整性、外键和 schema 版本，并清除恢复副本中的会话与运行期调度状态。

先从旧实例停机，再把 `BARKER_DATA_DIR` 指向恢复目录并启动。密码和会话密钥文件若不存在，需通过受控环境变量提供；否则服务会生成新密码和新会话密钥。

数据目录包含 `barker.sqlite`、WAL/SHM、`access-password.txt` 与 `session-secret.txt`。Device Key 保存在 SQLite 中，**没有静态加密**，数据目录和备份都应按秘密材料保护。不要把 SQLite 放在不支持文件锁和可靠写入的网络文件系统上，也不要让多个实例共同挂载同一数据目录。

升级时自动执行事务式增量迁移，保留旧版任务和投递历史，并补齐旧版暂停任务的排期边界。升级前仍应先备份；升级后不要用旧版本继续写新数据库。

## 发布与 CI

`.github/workflows/ci.yml` 根据改动选择所属测试、类型检查、生产构建、浏览器交互和容器冒烟，不会用全量测试掩盖选择错误。

`.github/workflows/release.yml` 只对新建的 `v<semver>` tag 发布镜像，并要求 tag 与 `package.json` 版本一致。流程会：

- 在发布前运行测试、构建和浏览器回归；
- 分别构建并冒烟 `linux/amd64` 与 `linux/arm64`；
- 拒绝覆盖版本镜像或同一版本对应的平台镜像，失败后使用新版本继续发布；
- 推送不可变的 per-architecture 摘要，再创建多架构版本清单；
- 只允许 `latest` 和次版本通道向前移动；
- 重新按清单摘要拉取两个平台并再次运行容器冒烟。

本地构建、分支 CI、tag 发布与生产部署是不同步骤；合并代码不会自动部署。

## 代码结构

```text
app/                         概览、提醒、投递、设置及 API
components/                  认证、导航、编辑器、HeroUI 组合组件
lib/db.ts                    SQLite 迁移、outbox、租约、修订、备份所需数据模型
lib/cron.ts                  任务时区、cron 预设、七日预测
lib/scheduler.ts             有界补排、并发发送、端点冷却、健康心跳
lib/bark.ts                  Bark 协议、超时、Retry-After、严格成功确认
lib/auth.ts                  密码、持久会话、撤销、按客户端失败限流
lib/http.ts                  请求上限、CSRF 防线、JSON 错误边界
scripts/start-server.mjs     调度收尾与 HTTP 退出之间的进程协调
scripts/data-tools.mjs       一致性备份、校验和、拒绝覆盖的恢复
scripts/release-guard.mjs    SemVer、镜像不可变性与通道保护
scripts/container-smoke.mjs  隔离容器端到端检查
tests/                       业务、安全、迁移、重启、UI、CI 与发布回归
```

前端使用 `@heroui/react` V3 公共组件、自托管 Manrope 字体和本地 Gravity 图标。界面不依赖外部图片或运行时 CDN。

## License

MIT © MournInk
