# Barker

前后端一体的 Next.js 定时提醒小工具 —— 按 cron 周期将提醒可靠推送到你自己的 [Bark](https://bark.day.app) API。

> 运行时生成访问密码 · 墙钟 cron（`Asia/Shanghai`）· 每条到点提醒落库为 delivery · 失败指数退避无限重试绝不丢弃 · SQLite WAL 持久化

Author: **MournInk** · Version: **0.3.2** · Node `>=24` · pnpm `>=12`（唯一包管理器）

---

## 功能

- **运行时密码授权**：未配置 `BARKER_PASSWORD` 时启动在日志打印随机密码（`🔐 Barker access password: ...`），登录后签发 `HttpOnly + SameSite=Lax` 12 小时会话；同客户端连续输错 5 次锁定 10 分钟；支持 `BARKER_TRUST_PROXY` 受控信任反代头。
- **任务管理**：名称、解释（可空）、开始时间、周期预设（每天 / 每周 / 每月，按 `Asia/Shanghai` 墙钟生成 cron）或自定义五段 cron；结束条件二选一：重复次数或截止日期。
- **可靠推送**：每个到点时刻写入 `deliveries`，`claim → sending (2 min 租约) → pending/sent` 状态机；失败按 `5s * 2^attempt` 指数退避（上限 1h）**无限重试**，服务重启自动续传，暂停 / 恢复 / 编辑会补排所有错过的 occurrence。
- **Bark 自配置**：`endpoint / deviceKey / title / sound / group / icon`，`deviceKey` 留空保持不变，一键发送测试推送。
- **多页面布局**：`/` 概览仪表盘 · `/tasks` 任务分页（8 条/页，状态与关键词筛选）· `/settings` 独立配置页；侧边栏导航 + 移动端抽屉，5s 轮询与服务端调度器保持一致。

---

## 快速开始 — Docker（推荐）

> 镜像基于 `node:24-alpine` + Next.js `output: standalone`，数据持久化到 `/app/data`（`barker.sqlite` WAL）。

### 方式 A：Docker Compose

```bash
git clone https://github.com/MournInk/Barker.git
cd Barker

# 可选：固定密码，避免每次查看日志
# echo "BARKER_PASSWORD=your-secret" >> .env

docker compose up -d --build
docker logs -f barker   # 未设 BARKER_PASSWORD 时在此查看随机密码
# 打开 http://localhost:3000 输入密码登录
```

`docker-compose.yml` 已配置命名卷 `barker-data:/app/data`，升级时数据不丢失。

### 方式 B：docker run

```bash
docker build -t barker:0.3.2 .

# 命名卷
docker run -d --name barker -p 3000:3000 \
  -v barker-data:/app/data \
  barker:0.3.2

# 或绑定宿主机目录
mkdir -p ./data
docker run -d --name barker -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  -e BARKER_PASSWORD=change-me \
  barker:0.3.2

docker logs barker
```

### 从源码构建镜像说明

`Dockerfile` 为三阶段构建：`deps → builder (pnpm run build) → runner`，`runner` 仅含 `.next/standalone` + `.next/static`，以 `nextjs` 非 root 用户运行，`HEALTHCHECK` 每 30s 探测 `GET /api/session`。

镜像标签：正式版本由 CI 推送到 `ghcr.io/mournink/barker`（`0.3.2` / `0.3` / `latest`）；本地构建用 `docker build -t barker:0.3.2 .`。`deps` 阶段会把 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 一起拷入，确保 `pnpm install --frozen-lockfile` 能按 `allowBuilds` 放行原生构建脚本。

---

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `BARKER_PASSWORD` | 否 | 随机生成并打印到日志 | 访问密码。留空则每次启动生成新密码 |
| `BARKER_SESSION_SECRET` | 否 | 写入 `data/session-secret.txt` | 会话签名密钥，首次生成后持久化 |
| `BARKER_DATA_DIR` | 否 | `./data`（容器内 `/app/data`） | SQLite 与密钥文件目录 |
| `BARKER_TRUST_PROXY` | 否 | 空（不信任） | 设为 `1/true/yes` 时才信任 `X-Forwarded-* / X-Real-IP` 用于限流与 `Secure` 判定；直连公网时切勿开启 |
| `PORT` | 否 | `3000` | 监听端口 |
| `HOSTNAME` | 否 | `0.0.0.0` | 监听地址 |
| `TZ` | 否 | `Asia/Shanghai` | 容器与调度时区，`Dockerfile`/`compose` 已设为上海时区 |

详见 [.env.example](.env.example)。

---

## 数据

- 默认 `./data/barker.sqlite`（WAL + `busy_timeout=10000`），`tasks / deliveries / settings` 全量持久化。
- `instrumentation.ts` 启动调度器：每 2s 执行 `enqueueDueOccurrences + processOneDelivery(最多 20 条)`，空闲 `timer.unref()` 不阻止退出。
- 任务删除前所有 `delivery` 必须为 `sent`，否则返回 `409` 并提示「请等发送成功后再删除」；积压 `>500` 条时操作会提示等待调度器补排而非丢弃。

备份：直接拷贝 `data/barker.sqlite*`（含 `-wal/-shm`）或快照命名卷。

---

## 本地开发（不使用 Docker）

```bash
node -v                # >=24
corepack enable        # 按 packageManager 字段启用 pnpm 12
pnpm install           # 首次安装

pnpm dev               # http://localhost:3000
pnpm build && pnpm start

pnpm test              # node:test 单元测试（23 用例）
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint（eslint-config-next 16 原生 flat config）
```

> 包管理器统一为 pnpm：仓库只保留 `pnpm-lock.yaml`，不要把 npm/yarn 的锁文件带回来。
> pnpm 12 默认禁止依赖执行安装脚本，仅 `esbuild` / `unrs-resolver` 在 `pnpm-workspace.yaml` 的 `allowBuilds` 中放行。

启动日志：

```
🔐 Barker access password: xxxxx
Set BARKER_PASSWORD to use your own password.
```

---

## 项目结构

```
app/                # Next.js App Router
  page.tsx          # / 概览仪表盘
  tasks/page.tsx    # /tasks 分页
  settings/page.tsx # /settings 配置
  api/overview|session|settings|tasks
components/         # nav / gate / pagination / task-card
lib/
  db.ts             # SQLite + deliveries 状态机 + 事务补排
  auth.ts           # 密码 / HMAC 会话 / 限流
  cron.ts           # Asia/Shanghai 墙钟 cron（croner）
  scheduler.ts      # enqueue + claim/lease + 指数退避
  bark.ts           # Bark push 适配
  validation.ts     # zod 校验
tests/              # node:test 用例
Dockerfile
docker-compose.yml
pnpm-workspace.yaml # pnpm 12 工作区设置（allowBuilds）
.github/workflows/release.yml  # 打版本标签时校验并发布镜像
```

---

## 校验

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

CI 在推送 `v*` 版本标签时自动执行同一组校验，并构建多架构镜像推送到 GHCR，不必在本地复刻整条流水线。

Docker 冒烟：

```bash
docker run -d --name barker-smoke -p 3001:3000 barker:0.3.2
curl -i http://localhost:3001/api/session  # 200 {"authenticated":false}
docker rm -f barker-smoke
```

---

## 发布新版本

1. 同步版本号：`package.json` 的 `version` 与 README 顶部版本号。
2. 提交后打标签并推送（标签即版本创建动作）：

```bash
git tag -a v0.3.2 -m "0.3.2"
git push origin v0.3.2
```

3. [`.github/workflows/release.yml`](.github/workflows/release.yml) 自动执行：
   - 版本一致性守卫：标签 `v0.3.2` 必须等于 `package.json` 的 `version`，否则失败；
   - 校验：`pnpm install --frozen-lockfile` → `typecheck` → `lint` → `test` → `build`；
   - 发布：构建 `linux/amd64` + `linux/arm64` 镜像并推送 `ghcr.io/mournink/barker`，标签为 `0.3.2` / `0.3` / `latest`（预发布版本不带 `latest`）。

`workflow_dispatch` 可手动触发同一套校验，但不会推送镜像；流水线需要 `packages: write` 权限（工作流已声明）。

---

## 常见问题

**Q: 忘记随机密码？** `docker logs barker` 或 `cat data/access-password.txt`；建议设置 `BARKER_PASSWORD`。

**Q: Bark 推送失败会丢失吗？** 不会。失败记录 `attempts/lastError/nextAttemptAt` 并按 5s→1h 退避无限重试，`/api/overview` 的 `retryQueue` 可见。

**Q: 端口冲突？** 修改 `docker-compose.yml` 的 `ports: ["3001:3000"]` 或设置 `PORT`。

---

## 版本

- `0.3.2` — 工程化收尾：以 pnpm 为唯一包管理器（移除 npm 锁文件与未被引用的 tailwind/postcss 依赖，新增 `pnpm-workspace.yaml` 放行原生构建脚本）、`eslint-config-next` 升至 16 并改用原生 flat config、修复 React 19 新 lint 规则下的前端问题与设置页数据目录显示、限流记录有界化、新增 `v*` 标签触发的发布流水线（校验 + 多架构 GHCR 镜像）。
- `0.3.1` — 迁移至 pnpm（`packageManager` + `pnpm-lock.yaml` + `Dockerfile` 启用 `corepack`），文档与脚本统一为 `pnpm`。
- `0.3.0` — 多页面重构（`/` 概览 · `/tasks` 分页 · `/settings` 独立页）、侧边栏导航与移动端抽屉、设计系统与分页组件重塑，API 支持 `page/pageSize/status/q` 分页查询。
- `0.2.0` — Docker 化（standalone 镜像 + compose + healthcheck）、文档重写、依赖升级至 Next 16 / React 19.3 / zod 4.6 等，修复暂停/编辑时的到期提醒丢弃与 `deviceKey` 校验问题。
- `0.1.0` — 首个可用版本。

---

## License

MIT © MournInk
