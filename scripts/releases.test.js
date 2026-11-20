import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadAsset,
  ensureRelease,
  listReleases,
  packageReleases,
  retainedReleases,
  sha256File,
  uploadAsset,
} from "./releases.js";

const REPO = "i-zhirov/trusttunnel-termux-repo";
const USER_AGENT = "trusttunnel-termux-repo";
const TOKEN = "test-token";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function failingFetch() {
  return mockFetch(() => {
    throw new Error("unexpected request");
  });
}

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("list_releases", async () => {
  const releases = [{ tag_name: "trusttunnel-client-v1.3.0" }];
  const { fetchImpl, calls } = mockFetch(() => jsonResponse(releases));

  const result = await listReleases(REPO, TOKEN, fetchImpl);

  assert.deepEqual(result, releases);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${REPO}/releases?per_page=100`,
  );
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers["User-Agent"], USER_AGENT);
});

test("ensure_release_existing", async () => {
  const existing = { id: 7, tag_name: "trusttunnel-client-v1.3.0" };
  const { fetchImpl, calls } = mockFetch(() => jsonResponse([existing]));

  const result = await ensureRelease(
    REPO,
    "trusttunnel-client-v1.3.0",
    TOKEN,
    fetchImpl,
  );

  assert.deepEqual(result, existing);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method ?? "GET", "GET");
});

test("ensure_release_new", async () => {
  const created = { id: 9, tag_name: "trusttunnel-v1.3.1" };
  const { fetchImpl, calls } = mockFetch((url, init) => {
    if (init.method === "POST") {
      return jsonResponse(created, 201);
    }
    return jsonResponse([]);
  });

  const result = await ensureRelease(
    REPO,
    "trusttunnel-v1.3.1",
    TOKEN,
    fetchImpl,
  );

  assert.deepEqual(result, created);
  assert.equal(calls.length, 2);
  const post = calls[1];
  assert.equal(post.url, `https://api.github.com/repos/${REPO}/releases`);
  assert.equal(post.init.method, "POST");
  assert.deepEqual(JSON.parse(post.init.body), {
    tag_name: "trusttunnel-v1.3.1",
    name: "trusttunnel-v1.3.1",
    draft: false,
    prerelease: false,
  });
});

test("upload_asset_matching_digest_skips", async () => {
  const dir = await tempDir("trusttunnel-upload-skip-");
  try {
    const assetPath = join(dir, "trusttunnel-client_1.3.0_x86_64.deb");
    await writeFile(assetPath, "same bytes");
    const digest = await sha256File(assetPath);
    const existing = {
      id: 11,
      name: "trusttunnel-client_1.3.0_x86_64.deb",
      digest,
    };
    const { fetchImpl, calls } = failingFetch();

    const result = await uploadAsset(
      REPO,
      { id: 5, assets: [existing] },
      assetPath,
      TOKEN,
      fetchImpl,
    );

    assert.deepEqual(result, existing);
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload_asset_conflict_throws", async () => {
  const dir = await tempDir("trusttunnel-upload-conflict-");
  try {
    const assetPath = join(dir, "trusttunnel-client_1.3.0_x86_64.deb");
    await writeFile(assetPath, "local bytes");
    const existing = {
      id: 12,
      name: "trusttunnel-client_1.3.0_x86_64.deb",
      digest: `sha256:${createHash("sha256").update("other bytes").digest("hex")}`,
    };
    const { fetchImpl, calls } = failingFetch();

    await assert.rejects(
      () =>
        uploadAsset(
          REPO,
          { id: 5, assets: [existing] },
          assetPath,
          TOKEN,
          fetchImpl,
        ),
      /digest|conflict/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upload_asset_new", async () => {
  const dir = await tempDir("trusttunnel-upload-new-");
  try {
    const name = "trusttunnel-client_1.3.0_x86_64.deb";
    const assetPath = join(dir, name);
    const bytes = Buffer.from("fresh deb bytes");
    await writeFile(assetPath, bytes);
    const uploaded = { id: 13, name };
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(uploaded, 201));

    const result = await uploadAsset(
      REPO,
      { id: 5, assets: [] },
      assetPath,
      TOKEN,
      fetchImpl,
    );

    assert.deepEqual(result, uploaded);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `https://uploads.github.com/repos/${REPO}/releases/5/assets?name=${name}`,
    );
    assert.equal(calls[0].init.method, "POST");
    assert.equal(
      calls[0].init.headers["Content-Type"],
      "application/octet-stream",
    );
    assert.deepEqual(Buffer.from(calls[0].init.body), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download_asset", async () => {
  const dir = await tempDir("trusttunnel-download-");
  try {
    const destination = join(dir, "trusttunnel-client_1.3.0_x86_64.deb");
    const bytes = Buffer.from("download bytes");
    const url = "https://example.test/assets/trusttunnel-client.deb";
    const { fetchImpl, calls } = mockFetch(
      () => new Response(bytes, { status: 200 }),
    );

    await downloadAsset(
      { name: "trusttunnel-client_1.3.0_x86_64.deb", browser_download_url: url },
      destination,
      TOKEN,
      fetchImpl,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("package_releases", () => {
  const releases = [
    { tag_name: "trusttunnel-client-v1.3.0" },
    { tag_name: "trusttunnel-v1.3.1" },
  ];

  const client = packageReleases(releases, "trusttunnel-client");
  assert.equal(client.length, 1);
  assert.equal(client[0].tag_name, "trusttunnel-client-v1.3.0");

  const endpoint = packageReleases(releases, "trusttunnel");
  assert.equal(endpoint.length, 1);
  assert.equal(endpoint[0].tag_name, "trusttunnel-v1.3.1");
});

test("retained_releases", () => {
  const releases = [
    { tag_name: "trusttunnel-client-v1.0.0" },
    { tag_name: "trusttunnel-client-v1.2.0" },
    { tag_name: "trusttunnel-client-v1.1.0" },
    { tag_name: "trusttunnel-client-v1.3.0" },
    { tag_name: "trusttunnel-v1.5.0" },
  ];

  const retained = retainedReleases(releases, "trusttunnel-client");

  assert.deepEqual(
    retained.map((release) => release.tag_name),
    [
      "trusttunnel-client-v1.3.0",
      "trusttunnel-client-v1.2.0",
      "trusttunnel-client-v1.1.0",
    ],
  );
});
