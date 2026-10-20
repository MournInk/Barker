# Barker

前后端一体的 Next.js 定时提醒小工具 —— 按 cron 周期将提醒可靠推送到你自己的 [Bark](https://bark.day.app) API。

> 运行时生成访问密码 · 墙钟 cron（`Asia/Shanghai`）· 每条到点提醒落库为 delivery · 失败指数退避无限重试绝不丢弃 · SQLite WAL 持久化

Author: **MournInk** · Version: **0.2.0** · Node `>=24`

---

## 功能

- **运行时密码授权**：未配置 `BARKER_PASSWORD` 时启动在日志打印随机密码（`🔐 Barker access password: ...`），登录后签发 `HttpOnly + SameSite=Lax` 12 小时会话；同客户端连续输错 5 次锁定 10 分钟；支持 `BARKER_TRUST_PROXY` 受控信任反代头。
- **任务管理**：名称、解释（可空）、开始时间、周期预设（每天 / 每周 / 每月，按 `Asia/Shanghai` 墙钟生成 cron）或自定义五段 cron；结束条件二选一：重复次数或截止日期。
- **可靠推送**：每个到点时刻写入 `deliveries`，`claim → sending (2 min 租约) → pending/sent` 状态机；失败按 `5s * 2^attempt` 指数退避（上限 1h）**无限重试**，服务重启自动续传，暂停 / 恢复 / 编辑会补排所有错过的 occurrence。
- **Bark 自配置**：`endpoint / deviceKey / title / sound / group / icon`，`deviceKey` 留空保持不变，一键发送测试推送。
- **前端一体**：`app/page.tsx` 单页完成登录、任务增删改、暂停/恢复、状态与重试队列展示，5s 轮询与服务端调度器保持一致。

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
docker build -t barker:0.2.0 .

# 命名卷
docker run -d --name barker -p 3000:3000 \
  -v barker-data:/app/data \
  barker:0.2.0

# 或绑定宿主机目录
mkdir -p ./data
docker run -d --name barker -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  -e BARKER_PASSWORD=change-me \
  barker:0.2.0

docker logs barker
```

### 从源码构建镜像说明

`Dockerfile` 为三阶段构建：`deps → builder (npm run build) → runner`，`runner` 仅含 `.next/standalone` + `.next/static`，以 `nextjs` 非 root 用户运行，`HEALTHCHECK` 每 30s 探测 `GET /api/session`。

镜像标签：`barker:0.2.0` / `ghcr.io/mournink/barker:0.2.0`

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
node -v  # >=24
npm install

npm run dev              # http://localhost:3000
npm run build && npm start

npm run test             # node:test 单元测试（22 用例）
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
```

启动日志：

```
🔐 Barker access password: xxxxx
Set BARKER_PASSWORD to use your own password.
```

---

## 项目结构

```
app/                # Next.js App Router 页面与 API
  api/overview|session|settings|tasks
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
```

---

## 校验

```bash
npm run test && npm run typecheck && npm run lint && npm run build
```

Docker 冒烟：

```bash
docker run -d --name barker-smoke -p 3001:3000 barker:0.2.0
curl -i http://localhost:3001/api/session  # 200 {"authenticated":false}
docker rm -f barker-smoke
```

---

## 常见问题

**Q: 忘记随机密码？** `docker logs barker` 或 `cat data/access-password.txt`；建议设置 `BARKER_PASSWORD`。

**Q: Bark 推送失败会丢失吗？** 不会。失败记录 `attempts/lastError/nextAttemptAt` 并按 5s→1h 退避无限重试，`/api/overview` 的 `retryQueue` 可见。

**Q: 端口冲突？** 修改 `docker-compose.yml` 的 `ports: ["3001:3000"]` 或设置 `PORT`。

---

## 版本

- `0.2.0` — Docker 化（standalone 镜像 + compose + healthcheck）、文档重写、依赖升级至 Next 16 / React 19.3 / zod 4.6 等，修复暂停/编辑时的到期提醒丢弃与 `deviceKey` 校验问题。
- `0.1.0` — 首个可用版本。

---

## License

MIT © MournInk
