import { expect, test, type Page } from "@playwright/test";
import { parseDate } from "@internationalized/date";
import { localDateValue } from "../../lib/ui";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("访问密码").fill("browser-regression-password");
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await expect(page.getByRole("heading", { name: /日常有序/ })).toBeVisible();
  const listing = await (await page.request.get("/api/tasks")).json();
  for (const task of listing.tasks) {
    if (task.status !== "archived") await page.request.delete(`/api/tasks/${task.id}`, { headers: { "if-match": String(task.revision) } });
    const current = (await (await page.request.get("/api/tasks?status=archived&page=1&pageSize=50")).json()).tasks.find((item: { id: string }) => item.id === task.id);
    if (current) await page.request.delete(`/api/tasks/${task.id}?permanent=1`, { headers: { "if-match": String(current.revision) } });
  }
}

test("production HTML uses a fresh nonce for its inline scripts", async ({ page }) => {
  const readNonce = async () => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    const policy = await response?.headerValue("content-security-policy");
    const scripts = policy?.split("; ").find((directive) => directive.startsWith("script-src ")) ?? "";
    const nonce = scripts.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    const inlineNonces = await page.locator("script:not([src])").evaluateAll((elements) => elements.map((element) => (element as HTMLScriptElement).nonce));
    expect(inlineNonces.length).toBeGreaterThan(0);
    expect([...new Set(inlineNonces)]).toEqual([nonce]);
    return nonce;
  };
  const first = await readNonce();
  expect(await readNonce()).not.toBe(first);
  await login(page);
  await page.getByRole("link", { name: "所有提醒", exact: true }).click();
  await expect(page.getByRole("heading", { name: /所有提醒/ })).toBeVisible();
});

test("mobile overview prioritizes the next reminder and unsaved settings protect navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const date = localDateValue(new Date(Date.now() + 2 * 86_400_000));
  expect((await page.request.post("/api/tasks", { data: {
    name: "喝杯水，休息一下", description: "起身活动，让眼睛离开屏幕。", startsAt: `${date}T09:00:00+08:00`, preset: "daily", cron: "0 9 * * *", repeatCount: 2, endDate: null,
  } })).status()).toBe(201);
  await page.goto("/");
  await expect(page.locator(".welcome-panel")).toBeHidden();
  await expect(page.locator(".next-panel")).toBeVisible();
  await expect(page.locator(".next-task h3")).toHaveText("喝杯水，休息一下");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-overview.png"), fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings");
  const endpoint = page.getByLabel("API 服务地址");
  await endpoint.fill("https://api.day.app/");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("link", { name: "投递记录" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("link", { name: "投递记录" }).click();
  await expect(page).toHaveURL(/\/deliveries$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: "全部记录", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-deliveries.png"), fullPage: true, animations: "disabled" });
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "编辑 喝杯水，休息一下", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-tasks.png"), fullPage: true, animations: "disabled" });
  await page.goto("/settings");
  await expect(page.getByLabel("API 服务地址")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-settings.png"), fullPage: true, animations: "disabled" });
});

test("browser Back preserves dirty settings when leaving is rejected", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "所有提醒", exact: true }).click();
  await page.getByRole("link", { name: "推送设置", exact: true }).click();
  await page.getByLabel("API 服务地址", { exact: true }).fill("https://edited.example");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByLabel("API 服务地址", { exact: true })).toHaveValue("https://edited.example");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/tasks$/);
});

test("a first-load API error replaces the loading state and offers retry", async ({ page }) => {
  await login(page);
  let fail = true;
  await page.route((url) => new URL(url).pathname === "/api/tasks", async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary failure" }) });
      return;
    }
    await route.continue();
  });
  await page.goto("/tasks");
  await expect(page.locator(".notice-error")).toContainText("Temporary failure");
  await expect(page.locator(".loading-state")).toHaveCount(0);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".empty-state")).toBeVisible();
});

test("task edits made during save stay open and save against the new revision", async ({ page }) => {
  await login(page);
  const response = await page.request.post("/api/tasks", { data: { name: "Race edit", startsAt: "2030-11-04T09:00:00+08:00", preset: "daily", cron: "0 9 * * *", repeatCount: 2 } });
  const { task } = await response.json();
  await page.goto("/tasks");
  await page.getByRole("button", { name: "编辑 Race edit", exact: true }).click();
  await page.getByLabel("提醒名称", { exact: true }).fill("Submitted title");
  let release!: () => void;
  let begun!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { begun = resolve; });
  await page.route(`**/api/tasks/${task.id}`, async (route) => { begun(); await held; await route.continue(); });
  try {
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await started;
    await page.getByLabel("提醒名称", { exact: true }).fill("New local title");
    release();
    await expect(page.getByText(/保存期间的新修改仍保留/)).toBeVisible();
    await expect(page.getByLabel("提醒名称", { exact: true })).toHaveValue("New local title");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("heading", { name: "编辑提醒", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "编辑 New local title", exact: true })).toBeVisible();
  } finally { release(); }
});

test("complete agenda shows the fifth occurrence instead of linking to tasks", async ({ page }) => {
  await login(page);
  const date = localDateValue(new Date(Date.now() + 86_400_000));
  await page.request.post("/api/tasks", { data: { name: "Complete agenda", startsAt: `${date}T09:00:00+08:00`, preset: "custom", cron: "* * * * *", repeatCount: 5 } });
  await page.goto("/");
  await page.getByRole("button", { name: "查看完整排期" }).click();
  await expect(page.getByRole("dialog").getByText("Complete agenda", { exact: true })).toHaveCount(5);
});

test("copying and editing a weekly task preserves its weekday and wall clock", async ({ page }) => {
  await login(page);
  const response = await page.request.post("/api/tasks", { data: {
    name: "Monday review", description: "Original", startsAt: "2030-11-04T09:30:00+08:00", timeZone: "Asia/Shanghai",
    preset: "weekly", cron: "30 9 * * 1", repeatCount: 4, endDate: null,
  } });
  expect(response.status()).toBe(201);
  await page.goto("/tasks");
  await page.getByRole("button", { name: "更多操作 Monday review", exact: true }).click();
  await page.getByRole("menuitem", { name: "复制为新提醒" }).click();
  await expect(page.getByRole("heading", { name: "复制为新提醒" })).toBeVisible();
  await expect(page.locator(".preview-title code")).toHaveText("30 9 * * 1");
  await page.getByRole("button", { name: "创建提醒", exact: true }).click();
  await expect(page.getByRole("heading", { name: "复制为新提醒" })).toBeHidden();
  await page.getByRole("button", { name: "编辑 Monday review（副本）", exact: true }).click();
  await page.getByLabel(/^提醒内容/).fill("Edited content");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑提醒", exact: true })).toBeHidden();
  const { tasks } = await (await page.request.get("/api/tasks")).json();
  expect(tasks.find((task: { name: string }) => task.name === "Monday review（副本）")).toMatchObject({ cron: "30 9 * * 1", description: "Edited content" });
  expect(tasks.find((task: { name: string }) => task.name === "Monday review").description).toBe("Original");
});

test("copying an expired cutoff picks a fresh date in the task timezone", async ({ page }) => {
  await login(page);
  const timeZone = "Pacific/Auckland";
  const startsAt = new Date(Date.now() + 86_400_000);
  startsAt.setUTCMinutes(0, 0, 0);
  startsAt.setUTCHours(20);
  const endDate = localDateValue(new Date(startsAt.getTime() + 86_400_000), timeZone);
  const response = await page.request.post("/api/tasks", { data: {
    name: "Limited reminder", startsAt: startsAt.toISOString(), timeZone, preset: "custom", cron: "0 * * * *", endDate,
  } });
  expect(response.status()).toBe(201);

  const browserNow = new Date(startsAt.getTime() + 3 * 86_400_000);
  await page.clock.setFixedTime(browserNow);
  await page.goto("/tasks");
  await page.getByRole("button", { name: "更多操作 Limited reminder", exact: true }).click();
  const preview = page.waitForRequest((request) => request.url().endsWith("/api/tasks/preview") && request.method() === "POST");
  await page.getByRole("menuitem", { name: "复制为新提醒" }).click();
  const expected = parseDate(localDateValue(browserNow, timeZone)).add({ days: 30 }).toString();
  expect((await preview).postDataJSON()).toMatchObject({ timeZone, endDate: expected });
});

test("a stale settings tab cannot overwrite a newer saved configuration", async ({ page, context }) => {
  await login(page);
  await page.goto("/settings");
  const initial = await (await page.request.get("/api/settings")).json();
  const other = await context.newPage();
  await other.route("**/api/settings", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: initial });
    else await route.continue();
  });
  await other.goto("/settings");
  await other.getByText("更多通知选项", { exact: true }).click();
  await other.getByLabel("通知分组", { exact: true }).fill("Older tab edits");
  await page.getByText("更多通知选项", { exact: true }).click();
  await page.getByLabel("通知分组", { exact: true }).fill("Latest configuration");
  await page.getByLabel("Device Key", { exact: true }).fill("browser-test-key");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByText("设置已保存。队列中的提醒将使用新配置继续尝试。", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(other.getByRole("alert").filter({ hasText: "其他页面修改" })).toBeVisible();
  await expect(other.getByLabel("通知分组", { exact: true })).toHaveValue("Older tab edits");
  const actual = await (await page.request.get("/api/settings")).json();
  expect(actual.settings.group).toBe("Latest configuration");
  expect(actual.settings.deviceKey).toBeUndefined();
  await other.close();
});

test("disconnecting clears a typed replacement key before saving", async ({ page }) => {
  await login(page);
  const before = await (await page.request.get("/api/settings")).json();
  const saved = await page.request.put("/api/settings", { data: { ...before.settings, revision: before.revision, deviceKey: "browser-connected-key" } });
  expect(saved.status()).toBe(200);
  await page.goto("/settings");
  const key = page.getByLabel("Device Key", { exact: true });
  await key.fill("unsaved-key");
  await page.getByRole("button", { name: "断开设备", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "断开设备", exact: true }).click();
  await expect(key).toHaveValue("");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "设备连接已清除" })).toBeVisible();
  expect((await (await page.request.get("/api/settings")).json()).deviceKeyConfigured).toBe(false);
});

test("calendar overflow is visible and overview remains usable on desktop", async ({ page }) => {
  await login(page);
  const date = localDateValue(new Date(Date.now() + 86_400_000));
  const response = await page.request.post("/api/tasks", { data: {
    name: "Busy morning", startsAt: `${date}T09:00:00+08:00`, preset: "custom", cron: "* * * * *", repeatCount: 5, endDate: null,
  } });
  expect(response.status()).toBe(201);
  await page.goto("/");
  await page.locator(".week-strip button").filter({ hasText: "5 条" }).click();
  await expect(page.locator(".upcoming-row")).toHaveCount(4);
  await expect(page.locator(".forecast-overflow")).toContainText("当天共 5 条，另有 1 条未展开");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath("desktop-overview.png"), fullPage: true, animations: "disabled" });
});

test("list responses taking six seconds complete without polling starvation", async ({ page }) => {
  await login(page);
  const created = await page.request.post("/api/tasks", { data: {
    name: "Slow response task", startsAt: "2030-11-04T09:00:00+08:00", preset: "daily", cron: "0 9 * * *", repeatCount: 2, endDate: null,
  } });
  expect(created.status()).toBe(201);
  let requests = 0;
  await page.route("**/api/tasks?**", async (route) => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 6100));
    await route.fulfill({ response: await route.fetch() });
  });
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "编辑 Slow response task", exact: true })).toBeVisible({ timeout: 12_000 });
  expect(requests).toBe(1);
});

test("settings edits made while saving remain unsaved until the next save", async ({ page }) => {
  await login(page);
  await page.goto("/settings");
  await page.getByText("更多通知选项", { exact: true }).click();
  const group = page.getByLabel("通知分组", { exact: true });
  await group.fill("Submitted group");
  let release!: () => void;
  let received!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT") { received(); await pending; }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await started;
    await group.fill("Newer local edit");
    release();
    await expect(page.getByText("设置已保存。队列中的提醒将使用新配置继续尝试。", { exact: true })).toBeVisible();
    await expect(group).toHaveValue("Newer local edit");
    await expect(page.getByText("有尚未保存的修改", { exact: true })).toBeVisible();
    expect((await (await page.request.get("/api/settings")).json()).settings.group).toBe("Submitted group");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByText("修改配置后，记得保存", { exact: true })).toBeVisible();
    expect((await (await page.request.get("/api/settings")).json()).settings.group).toBe("Newer local edit");
  } finally { release(); }
});

test("closing a changed mobile task editor requires discarding its contents", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "新建提醒", exact: true }).last().click();
  await page.getByLabel("提醒名称", { exact: true }).fill("尚未保存的提醒");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "关闭编辑器", exact: true }).click();
  await expect(page.getByLabel("提醒名称", { exact: true })).toHaveValue("尚未保存的提醒");
  await page.screenshot({ path: test.info().outputPath("mobile-editor.png"), fullPage: true, animations: "disabled" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "关闭编辑器", exact: true }).click();
  await expect(page.getByRole("heading", { name: "留一个提醒给未来", exact: true })).toBeHidden();
});
