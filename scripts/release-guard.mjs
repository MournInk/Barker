import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error(`Invalid SemVer version: ${value}`);
  return { core: match.slice(1, 4).map(BigInt), prerelease: match[4] ?? null, build: match[5] ?? null };
}
function compareStable(left, right) {
  const first = parseVersion(left).core;
  const second = parseVersion(right).core;
  for (let index = 0; index < 3; index += 1) {
    if (first[index] !== second[index]) return first[index] > second[index] ? 1 : -1;
  }
  return 0;
}
export function platformTag(version, sha, architecture) {
  parseVersion(version);
  if (!/^[a-f0-9]{40}$/.test(sha) || !["amd64", "arm64"].includes(architecture)) throw new Error("Invalid platform release identity");
  const tag = `sha-${sha}-${version}-${architecture}`;
  if (tag.length > 128) throw new Error("Image tag exceeds the Docker registry limit");
  return tag;
}
export function releasePlan(repository, version, sha, tags) {
  const parsed = parseVersion(version);
  if (parsed.build) throw new Error("Docker tags cannot include SemVer build metadata");
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid repository or source SHA");
  for (const immutable of [version, `sha-${sha}`]) if (tags.includes(immutable)) throw new Error(`Refusing to overwrite existing immutable image tag ${immutable}`);
  const channels = [version, `sha-${sha}`];
  const stable = tags.filter((tag) => { try { return !parseVersion(tag).prerelease; } catch { return false; } });
  if (!parsed.prerelease) {
    const minor = parsed.core.slice(0, 2).join(".");
    if (!stable.some((tag) => compareStable(tag, version) > 0)) channels.push("latest");
    if (!stable.some((tag) => tag.startsWith(`${minor}.`) && compareStable(tag, version) > 0)) channels.push(minor);
  }
  return { image: `ghcr.io/${repository.toLowerCase()}`, version, channels };
}

export async function registryTags(repository, username, password, fetcher = fetch) {
  const image = repository.toLowerCase();
  const tokenResponse = await fetcher(`https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull`, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
    redirect: "error",
  });
  if (!tokenResponse.ok) throw new Error(`Registry authentication failed (${tokenResponse.status})`);
  const { token } = await tokenResponse.json();
  if (typeof token !== "string" || !token) throw new Error("Registry did not return an access token");
  const tags = [];
  let url = new URL(`https://ghcr.io/v2/${image}/tags/list?n=100`);
  for (let page = 0; page < 1000; page += 1) {
    if (url.origin !== "https://ghcr.io" || url.pathname !== `/v2/${image}/tags/list`) throw new Error("Unexpected registry pagination URL");
    const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error" });
    if (response.status === 404 && page === 0) return [];
    if (!response.ok) throw new Error(`Unable to inspect image tags (${response.status})`);
    const body = await response.json();
    if (body.tags !== null && !Array.isArray(body.tags)) throw new Error("Invalid registry tag list");
    tags.push(...(body.tags ?? []));
    const next = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    if (!next) return tags;
    url = new URL(next[1], url);
  }
  throw new Error("Registry pagination limit exceeded");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const repository = process.env.GITHUB_REPOSITORY;
  const version = process.env.GITHUB_REF_NAME?.replace(/^v/, "");
  const tags = await registryTags(repository, process.env.GITHUB_ACTOR, process.env.GITHUB_TOKEN);
  const plan = releasePlan(repository, version, process.env.GITHUB_SHA, tags);
  if (process.argv.includes("--check-platforms")) {
    for (const architecture of ["amd64", "arm64"]) {
      if (tags.includes(platformTag(version, process.env.GITHUB_SHA, architecture))) throw new Error("A platform image already exists for this version; inspect the previous release before retrying");
    }
  }
  console.log(JSON.stringify(plan));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `image=${plan.image}\nversion=${plan.version}\nchannels=${JSON.stringify(plan.channels)}\n`);
}
