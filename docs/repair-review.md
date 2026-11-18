# 缺陷修复核对记录

本轮针对调度丢失、事件循环阻塞、认证与密钥、API 契约、界面一致性、数据维护及发布流程修改。以下记录修复后的行为与回归入口，最终执行结果见文末。

| 问题 | 修复后的行为 | 主要回归入口 |
| --- | --- | --- |
| 旧版暂停最多补排 500 条，恢复漏掉剩余时刻 | 迁移暂停截止点；补齐暂停前积压后才跳过暂停区间 | `tests/persistence.test.ts` |
| 再次暂停、归档沿用旧边界 | 先完成恢复边界，保存新的暂停或归档截止点 | `tests/scheduler.test.ts` |
| 编辑预览与保存使用不同计数规则 | 共用排期推进函数，排除已存在的 occurrence，并扣除剩余次数 | `tests/workflow.test.ts` |
| 大量历史记录让补排阻塞主线程 | 缓存语句、持久化累计排期数、小事务和时间预算，分批让出事件循环 | `tests/scheduler.test.ts` |
| 清理过期消息与恢复租约无界 | 每次最多处理 250 条过期消息与 100 个租约，领取时再次排除过期消息 | `tests/scheduler.test.ts`、`tests/workflow.test.ts` |
| 一个损坏 Cron 阻塞全部投递 | 隔离单个任务，其他任务和已有 outbox 继续运行 | `tests/scheduler.test.ts` |
| 串行发送与端点错误放大 | 4 个 worker、每轮最多 20 条；端点短冷却，正文错误单独分类 | `tests/scheduler.test.ts`、`tests/bark.test.ts` |
| 单个 worker 落库失败让整轮提前结束 | 等待所有在途 worker 完成才释放周期；失败确认保留租约，后续可以恢复 | `tests/scheduler.test.ts` |
| 忽略上游限流时间，并发错误缩短冷却 | 支持秒数、HTTP 日期及应用层 429/503；冷却只延长 | `tests/bark.test.ts`、`tests/scheduler.test.ts` |
| 错误登录锁死共享地址的管理员 | 错误尝试返回 429 和等待时间；正确密码继续可用 | `tests/auth.test.ts`、`tests/api.test.ts` |
| 注销无效、改密码不撤销旧 Cookie | 持久化服务端会话；注销删除会话，认证初始化时清理密码指纹不符的会话，改回旧密码也不会复活 | `tests/auth.test.ts`、`tests/api.test.ts` |
| 启动接受无法登录的超长密码 | 启动、持久化文件和登录统一 16–300 字符边界 | `tests/auth.test.ts` |
| 现有数据库与目录权限过宽 | 启动收紧目录 0700、数据库及密钥文件 0600 | `tests/db-init.test.ts` |
| Device Key 经上游错误泄漏 | 在网络错误、上游消息、日志、持久化和 API 读取处脱敏；轮换时清理旧错误 | `tests/bark.test.ts`、`tests/workflow.test.ts` |
| 切换服务误带旧密钥 | 更换端点必须明确提交新密钥，支持显式断开设备 | `tests/api.test.ts` |
| 一个坏图标让全部有效配置丢失 | 每字段解析，保留有效端点和密钥 | `tests/workflow.test.ts` |
| 多标签页设置与任务互相覆盖 | 修订号校验，缺少版本返回 428、冲突返回 409；配置与版本一起读取 | `tests/api.test.ts`、浏览器回归 |
| 不健康服务返回健康 | 检查数据库可写、调度器启用以及新鲜且有效的心跳 | `tests/api.test.ts`、容器冒烟 |
| Next.js 退出早于调度收尾 | 生产入口先通过 IPC 等待 outbox 发送完成，再转发终止信号 | `tests/shutdown.test.mjs`、容器冒烟 |
| 浏览器回归结束后进程挂起 | 测试服务直接启动同组子进程，转发终止信号并清理临时目录；强制结束进程组也不遗留 Next.js | `tests/shutdown.test.mjs`、浏览器命令退出检查 |
| 负载高时批次初始化耗完时间预算 | 对有到期任务的批次至少推进一个时刻，随后按预算让出，避免一次有效周期无进度 | `tests/scheduler.test.ts` |
| 中文正文或选项生成超大通知 | 标题正文 3000 UTF-8 字节、选项 1096 字节预算，发送前再检查 4096 字节 | `tests/validation.test.ts`、`tests/bark.test.ts` |
| 可强转的伪 200 被当成成功 | 只接受数值 200 或规范字符串 `"200"`，拒绝空响应、数组和 HTML | `tests/bark.test.ts` |
| 重定向、巨量上游正文不受控 | 不跟随重定向，限制响应正文大小；HTTP 错误直接按状态处理 | `tests/bark.test.ts` |
| 数据库故障伪装成用户输入错误或未登录 | 区分业务错误与 500，认证存储故障也经过 JSON 错误边界 | `tests/api.test.ts`、`tests/http.test.ts` |
| 慢请求被下一次轮询反复丢弃 | 单次在途请求，完成后再等待下一轮；卸载后取消并忽略晚到数据 | `tests/ui.test.ts`、浏览器回归 |
| 客户端把 HTML 或损坏的结构当成成功 | 校验 Content-Type、JSON 和对应端点的响应结构 | `tests/ui.test.ts` |
| 配置轮询覆盖本地编辑、保存期间编辑丢失 | 未改动时同步新配置，脏表单保留内容并提示冲突；保留保存期间的新编辑 | 浏览器回归 |
| 复制周提醒改掉星期，预览随时间过期 | 保留原任务的墙上时间和时区，预览定期刷新并显示计算错误 | `tests/ui.test.ts`、浏览器回归 |
| 排期只能使用固定时区 | 支持 IANA 任务时区，DST 输入拒绝不存在时刻；概览按北京时间统一展示 | `tests/cron.test.ts`、`tests/ui.test.ts` |
| 非上海分钟任务预测逐条计算过慢 | 普通日按时段掩码统计，DST 变更日由 Croner 决定 | `tests/cron.test.ts` |
| 每天第五条及以后的预测被静默隐藏 | 返回每日总数与隐藏数量，界面明确显示溢出提示 | `tests/cron.test.ts`、浏览器回归 |
| “最近投递”按创建时间排序 | 单独维护投递活动时间，按最新活动排序 | `lib/db.ts`、界面检查 |
| 删除后分页越界、未保存编辑丢失 | 服务端夹取页码；表单离开、刷新、关闭编辑器与退出时保护修改 | API 与浏览器回归 |
| 移动端隐藏下一条提醒、正文过小 | 移动端优先下一条提醒，隐藏欢迎装饰，提升小字号和横向标签滚动 | 浏览器截图检查 |
| “工作日”“已送达”“不会遗漏”文案失真 | 明确周一至周五，使用“Bark 已接收”，说明至少一次投递与设备展示的区别 | 界面及 README |
| 无法取消、过期或去重创建消息 | 单次取消、最大允许延迟、幂等创建键；保留所有累计计数 | `tests/api.test.ts`、`tests/workflow.test.ts` |
| 缺少尝试级审计与历史维护 | 保存最近 100 次尝试，记录中断结果，分批清理结束记录且不重置次数 | `tests/workflow.test.ts` |
| 缺少一致性备份恢复工具 | 在线 SQLite 快照、私有权限、SHA-256、完整性与外键校验；恢复拒绝覆盖，撤销会话 | `tests/data-tools.test.mjs` |
| 版本兼容与构建产物缺少保护 | 拒绝降级新数据库；检查 standalone 不含数据、环境文件及密钥，保留 MIT 许可证 | `tests/db-init.test.ts`、`tests/artifact.test.mjs` |
| CI 忽略 release workflow，发布可覆盖和倒退 | 补齐变更选择、工作流语法校验；检查不可变标签、稳定通道顺序、双平台冒烟与摘要回拉 | `tests/ci-scope.test.mjs`、`tests/release.test.mjs` |

## 产品与验证边界

- 支持默认 Bark 设备及多个可由任务选择的设备，各设备可使用独立服务地址和密钥；任务也支持独立时区。
- Bark 接收确认不能证明设备实际展示；确认丢失或异常中断后的重试可能重复。
- 数据库与备份包含秘密材料，采用权限隔离，没有静态加密。
- 新增修订号是写 API 的必需字段，旧调用方需要更新；失败恢复与数据库升级已有回归用例。
- 本地检查不代表 GitHub CI、GHCR 发布或生产部署已经成功。

## 验证结果

全部实现与回归用例完成后执行验证；收尾复查发现的 worker 落库失败竞态也已补上修复与回归。以下结果仅对应 2026-11-13（北京时间）的旧候选，当前分支复验见下一节。

| 验证 | 实际结果 |
| --- | --- |
| `pnpm test`，本机 Node.js 26.7.0 | 139 项通过，0 失败、0 跳过 |
| Node.js 24.22.2 临时验证容器中的 `pnpm test` | 139 项通过，0 失败、0 跳过 |
| `pnpm exec next typegen`、`pnpm typecheck`、`pnpm lint` | 全部通过 |
| 使用临时数据目录、禁用调度器的 `pnpm build` | 生产构建通过，standalone 检查确认没有数据库、WAL、密码、会话密钥或环境文件 |
| `pnpm test:browser` | Chromium 7 项通过；覆盖慢响应、复制周提醒、设置冲突、保存期间继续编辑、未保存关闭保护及预测溢出 |
| 桌面与移动端截图 | 已逐张检查桌面概览，以及移动端概览、提醒、投递、设置和编辑器；主要页面的横向溢出断言通过 |
| `docker build -t barker:review-20261113 .` | `linux/arm64` 镜像构建通过 |
| `docker buildx build --load --platform linux/amd64 -t barker:review-20261113-amd64 .` | `linux/amd64` 镜像构建通过 |
| 两个平台的 `scripts/container-smoke.mjs` | 非 root 启动、生成密码、认证、密钥脱敏、503 后保留、归档、正常停止、重启、自动重试及健康检查全部通过 |
| `pnpm audit --prod` | 未发现已知生产依赖漏洞 |
| `git diff --check` 与文件清单复查 | 通过；测试产物与运行期数据均未进入待交付文件清单 |

Node 24 首次检查中，工作流语法回归因 Alpine 验证容器缺少 Bash 无法启动；在临时验证容器补齐 Bash 后，全套 139 项通过。Bash 是工作流语法测试的依赖。

amd64 构建与冒烟在本机 Docker 的架构模拟下执行。容器检查使用独立卷、随机本地端口和模拟 Bark，已清理自己的容器与卷；没有用真实设备验证通知展示。新增回归覆盖修复后的行为，并非每条都在旧代码上执行了逐项红绿对照。

该历史候选的镜像仅保存在本机；当时未执行 GitHub Actions、GHCR 发布、真实 amd64 主机或生产部署。当时的工作树尚未提交、推送或创建版本标签。

## 当前分支复验（2026-11-19）

| 验证 | 实际结果 |
| --- | --- |
| 受影响的 17 个单测模块 | 160 项通过；Node.js 26.7.0 |
| `pnpm exec next typegen`、`pnpm typecheck`、`pnpm lint` | 全部通过 |
| `BARKER_DATA_DIR=$(mktemp -d) BARKER_DISABLE_SCHEDULER=1 pnpm build` | Next.js 16.4.6 生产构建与 standalone 隔离检查通过 |
| `pnpm test:browser` | Chromium 与 WebKit 共 22 项通过，包含首次加载失败后重试 |
| `docker build` 与 `pnpm test:container` | 本机 Linux/ARM64 Docker；非 root、鉴权、失败保留、停机、重启、自动重试与健康检查通过 |
| `pnpm audit --prod` | 未发现已知生产依赖漏洞；Next.js 更新至 16.4.6 |

容器冒烟使用本地模拟 Bark 和独立测试卷；本次未使用真实设备。上述仅为本地验证，不代替最终 PR SHA 的 GitHub Actions 检查；本次不创建版本标签、不发布镜像或部署服务。
