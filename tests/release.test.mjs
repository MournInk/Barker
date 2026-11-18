import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { parseVersion, platformTag, releasePlan, registryTags } from "../scripts/release-guard.mjs";

const sha = "a".repeat(40);

test("release plans refuse immutable tag reuse and parse strict SemVer", () => {
  assert.throws(() => parseVersion("01.2.3"), /Invalid SemVer/);
  assert.throws(() => parseVersion("1.2.3-01"), /Invalid SemVer/);
  assert.equal(parseVersion("1.2.3-rc.1+linux.20261112").build, "linux.20261112");
  assert.throws(() => releasePlan("owner/repo", "1.2.3+linux", sha, []), /build metadata/);
  assert.throws(() => releasePlan("owner/repo", "1.2.3", sha, ["1.2.3"]), /immutable/);
  assert.throws(() => releasePlan("owner/repo", "1.2.3", sha, [`sha-${sha}`]), /immutable/);
  assert.equal(platformTag("1.2.3-rc.1", sha, "amd64"), `sha-${sha}-1.2.3-rc.1-amd64`);
  assert.throws(() => platformTag("1.2.3", sha, "riscv64"), /platform release identity/);
});

test("older stable releases cannot move latest backward", () => {
  const plan = releasePlan("owner/repo", "1.2.3", sha, ["1.3.0", "1.2.4", "2.0.0"]);
  assert.equal(plan.channels.includes("latest"), false);
  assert.equal(plan.channels.includes("1.2"), false);
  assert.deepEqual(plan.channels, ["1.2.3", `sha-${sha}`]);
});

test("prereleases publish immutable tags without stable channels", () => {
  const plan = releasePlan("owner/repo", "1.3.0-rc.1", sha, []);
  assert.deepEqual(plan.channels, ["1.3.0-rc.1", `sha-${sha}`]);
  assert.equal(plan.image, "ghcr.io/owner/repo");
});

test("registry pagination follows only same-origin expected next links", async () => {
  const urls = [];
  const fetcher = async (input) => {
    urls.push(String(input));
    if (String(input).includes("/token")) return Response.json({ token: "read-token" });
    if (urls.length === 2) return Response.json({ tags: ["1.0.0"] }, { headers: { link: '<https://ghcr.io/v2/owner/repo/tags/list?n=100&last=1.0.0>; rel="next"' } });
    return Response.json({ tags: ["1.1.0"] });
  };
  assert.deepEqual(await registryTags("owner/repo", "user", "token", fetcher), ["1.0.0", "1.1.0"]);
  assert.equal(urls.length, 3);
  await assert.rejects(registryTags("owner/repo", "user", "token", async (input) => String(input).includes("/token")
    ? Response.json({ token: "read-token" })
    : Response.json({ tags: [] }, { headers: { link: '<https://evil.test/list>; rel="next"' } })), /Unexpected registry/);
});

test("release and CI workflow YAML parse with the expected publication gates", () => {
  const release = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  assert.equal(release.jobs.image.if, "github.event_name == 'push' && github.ref_type == 'tag' && github.event.created && startsWith(github.ref, 'refs/tags/v')");
  assert.match(release.jobs.image.steps.find((step) => step.id === "publish").run, /sha-\$GITHUB_SHA-\$VERSION-\$architecture/);
  assert.match(release.jobs.verify.steps.find((step) => step.name === "Verify version syntax and package agreement").run, /git cat-file -t/);
  assert.match(release.jobs.verify.steps.find((step) => step.name === "Verify version syntax and package agreement").run, /git merge-base --is-ancestor/);
  assert.equal(ci.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  const steps = release.jobs.image.steps;
  assert.ok(steps.findIndex((step) => step.name === "Promote tested digest to stable channels") > steps.findIndex((step) => step.name === "Pull and verify published digest on each platform"));
  assert.doesNotMatch(steps.find((step) => step.id === "publish").run, /JSON.parse\(process.env.CHANNELS\)/);
  assert.equal(ci.jobs.checks.steps.some((step) => step.name === "Check affected browser interactions"), true);
  for (const workflow of [ci, release]) {
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(job["timeout-minutes"] > 0);
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
        if (step.run) {
          const syntax = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
          assert.equal(syntax.status, 0, `${step.name ?? step.run}: ${syntax.stderr}`);
        }
        if (step.run === "pnpm test") assert.equal(step.if, "github.event_name == 'push' && github.ref_type == 'tag' && github.event.created");
      }
    }
  }
});
