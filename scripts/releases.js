import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { selectRetained } from "./packages.js";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const USER_AGENT = "trusttunnel-termux-repo";

function requestHeaders(token, extra = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    ...extra,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function requireOk(response, context) {
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`${context} ${response.status}: ${body}`);
  }
}

export async function listReleases(repo, token, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${API}/repos/${repo}/releases?per_page=100`,
    { headers: requestHeaders(token) },
  );
  await requireOk(response, `GitHub API list releases for ${repo}`);
  return response.json();
}

export async function ensureRelease(repo, tag, token, fetchImpl = fetch) {
  const releases = await listReleases(repo, token, fetchImpl);
  const existing = releases.find((release) => release.tag_name === tag);
  if (existing) {
    return existing;
  }

  const response = await fetchImpl(`${API}/repos/${repo}/releases`, {
    method: "POST",
    headers: requestHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      draft: false,
      prerelease: false,
    }),
  });
  await requireOk(response, `GitHub API create release ${tag} for ${repo}`);
  return response.json();
}

export async function sha256File(path) {
  const bytes = await readFile(path);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function uploadAsset(
  repo,
  release,
  assetPath,
  token,
  fetchImpl = fetch,
) {
  const name = basename(assetPath);
  const digest = await sha256File(assetPath);
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const existing = assets.find((asset) => asset.name === name);

  if (existing) {
    if (existing.digest !== digest) {
      throw new Error(
        `release asset ${name} already exists with a different digest`,
      );
    }
    return existing;
  }

  const bytes = await readFile(assetPath);
  const response = await fetchImpl(
    `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: requestHeaders(token, {
        "Content-Type": "application/octet-stream",
      }),
      body: bytes,
    },
  );
  await requireOk(response, `GitHub API upload ${name} to ${repo}`);
  return response.json();
}

export async function downloadAsset(
  asset,
  destination,
  token,
  fetchImpl = fetch,
) {
  const url = asset.browser_download_url;
  const response = await fetchImpl(url, { headers: requestHeaders(token) });
  await requireOk(response, `download ${asset.name ?? url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

export function packageReleases(releases, packageName) {
  const prefix = `${packageName}-v`;
  const items = Array.isArray(releases) ? releases : [];
  return items.filter(
    (release) =>
      typeof release?.tag_name === "string" &&
      release.tag_name.startsWith(prefix),
  );
}

export function retainedReleases(releases, packageName, keep = 3) {
  const prefix = `${packageName}-v`;
  const items = packageReleases(releases, packageName).map((release) => ({
    release,
    tag: `v${release.tag_name.slice(prefix.length)}`,
  }));
  const retained = selectRetained(
    items.map(({ tag }) => ({ tag_name: tag })),
    keep,
  );
  const byTag = new Map(items.map(({ release, tag }) => [tag, release]));
  return retained.map(({ tag_name }) => byTag.get(tag_name));
}
