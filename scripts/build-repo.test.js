import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDeb,
  extractAsset,
  main,
  parseArgs,
  publishPackages,
  resolveExtracted,
  validateOptions,
  verifySha256,
  writeVersions,
} from "./build-repo.js";

const execFile = promisify(execFileCallback);

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function hasCommand(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const REPO = "i-zhirov/trusttunnel-termux-repo";
const TOKEN = "test-token";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function digestOf(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function seedRelease(id, tag, names, assetBytes) {
  return {
    id,
    tag_name: tag,
    assets: names.map((name, index) => ({
      id: id * 100 + index,
      name,
      digest: digestOf(assetBytes.get(name)),
      browser_download_url: `https://example.test/assets/${name}`,
    })),
  };
}

function createReleaseStore(seedReleases, assetBytes) {
  const releases = seedReleases;
  const calls = [];
  let nextReleaseId = 100;
  let nextAssetId = 1000;

  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method });

    if (url === `https://api.github.com/repos/${REPO}/releases?per_page=100`) {
      return jsonResponse(releases);
    }
    if (
      url === `https://api.github.com/repos/${REPO}/releases` &&
      method === "POST"
    ) {
      const body = JSON.parse(init.body);
      const release = {
        id: nextReleaseId,
        tag_name: body.tag_name,
        assets: [],
      };
      nextReleaseId += 1;
      releases.push(release);
      return jsonResponse(release, 201);
    }

    const upload = url.match(
      /^https:\/\/uploads\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets\?name=(.+)$/,
    );
    if (upload && method === "POST") {
      const release = releases.find((item) => item.id === Number(upload[1]));
      const name = decodeURIComponent(upload[2]);
      const bytes = Buffer.from(init.body);
      const asset = {
        id: nextAssetId,
        name,
        digest: digestOf(bytes),
        browser_download_url: `https://example.test/assets/${name}`,
      };
      nextAssetId += 1;
      assetBytes.set(name, bytes);
      release.assets.push(asset);
      return jsonResponse(asset, 201);
    }

    if (url.startsWith("https://example.test/assets/")) {
      const name = url.slice("https://example.test/assets/".length);
      const bytes = assetBytes.get(name);
      if (!bytes) {
        throw new Error(`no bytes for ${name}`);
      }
      return new Response(bytes, { status: 200 });
    }

    throw new Error(`unexpected request ${method} ${url}`);
  };

  return { calls, fetchImpl };
}

test("parse_args", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.root, process.cwd());
  assert.equal(defaults.site, join(process.cwd(), "site"));
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.only, null);
  assert.equal(defaults.sign, false);
  assert.equal(defaults.publish, false);

  const options = parseArgs([
    "--root",
    "/tmp/root",
    "--dry-run",
    "--only",
    "trusttunnel",
    "--sign",
    "--publish",
  ]);
  assert.equal(options.root, "/tmp/root");
  assert.equal(options.site, join("/tmp/root", "site"));
  assert.equal(options.dryRun, true);
  assert.equal(options.only, "trusttunnel");
  assert.equal(options.sign, true);
  assert.equal(options.publish, true);

  const explicitSite = parseArgs(["--site", "/tmp/site", "--root", "/tmp/root"]);
  assert.equal(explicitSite.site, "/tmp/site");

  assert.throws(() => parseArgs(["--unknown"]), /unknown/i);
  assert.throws(() => parseArgs(["--root"]), /value/i);
  assert.throws(() => parseArgs(["--only", "nope"]), /unknown/i);
});

test("validate_options", () => {
  assert.throws(
    () => validateOptions({ publish: true, sign: false }),
    /sign/i,
  );
  assert.doesNotThrow(() => validateOptions({ publish: true, sign: true }));
  assert.doesNotThrow(() => validateOptions({ publish: false, sign: false }));
});

test("verify_sha256", async () => {
  const dir = await tempDir("trusttunnel-sha-");
  try {
    const file = join(dir, "asset.tar.gz");
    await writeFile(file, "hello");
    const digest = `sha256:${createHash("sha256").update("hello").digest("hex")}`;
    assert.equal(await verifySha256(file, digest), true);
    assert.equal(
      await verifySha256(
        file,
        `sha256:${createHash("sha256").update("other").digest("hex")}`,
      ),
      false,
    );
    await assert.rejects(() => verifySha256(file, "sha256:abc"), /digest/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extract_asset", async () => {
  const dir = await tempDir("trusttunnel-extract-");
  try {
    const packageDir = join(dir, "trusttunnel_client-v1.3.0-linux-x86_64");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "trusttunnel_client"), "binary");
    await writeFile(join(packageDir, "LICENSE"), "license");
    const archive = join(dir, "asset.tar.gz");
    await execFile("tar", [
      "-czf",
      archive,
      "-C",
      dir,
      "trusttunnel_client-v1.3.0-linux-x86_64",
    ]);

    const extracted = join(dir, "extracted");
    await extractAsset(archive, extracted);
    const result = await resolveExtracted(extracted, "trusttunnel_client");
    assert.equal(await readFile(result.binaryPath, "utf8"), "binary");
    assert.equal(await readFile(result.licensePath, "utf8"), "license");
    await assert.rejects(
      () => resolveExtracted(extracted, "missing_binary"),
      /missing_binary/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build_deb", async (t) => {
  if (!hasCommand("dpkg-deb")) {
    t.skip("dpkg-deb is not installed");
    return;
  }
  const dir = await tempDir("trusttunnel-deb-");
  try {
    const binaryPath = join(dir, "trusttunnel_client");
    const licensePath = join(dir, "LICENSE");
    await writeFile(binaryPath, "binary");
    await writeFile(licensePath, "license");

    const deb = await buildDeb({
      root: dir,
      packageName: "trusttunnel-client",
      version: "1.3.0",
      arch: "x86_64",
      binaryPath,
      licensePath,
    });
    assert.equal(deb.endsWith("trusttunnel-client_1.3.0_x86_64.deb"), true);

    const info = await execFile("dpkg-deb", ["-I", deb]);
    assert.match(info.stdout, /Package: trusttunnel-client/);
    assert.match(info.stdout, /Version: 1\.3\.0/);
    assert.match(info.stdout, /Architecture: x86_64/);
    assert.match(info.stdout, /Maintainer: TrustTunnel/);
    assert.match(info.stdout, /Section: net/);
    assert.match(info.stdout, /Priority: optional/);
    assert.match(info.stdout, /Homepage: https:\/\/github\.com\/TrustTunnel\/TrustTunnelClient/);
    assert.match(info.stdout, /Description: Command-line client/);

    const contents = await execFile("dpkg-deb", ["-c", deb]);
    assert.match(contents.stdout, /usr\/bin\/trusttunnel_client/);
    assert.match(contents.stdout, /usr\/share\/doc\/trusttunnel-client\/copyright/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write_versions", async () => {
  const dir = await tempDir("trusttunnel-versions-");
  try {
    await writeVersions(dir, {
      "trusttunnel-client": "1.3.0",
      trusttunnel: "1.3.1",
    });
    const text = await readFile(join(dir, "versions.json"), "utf8");
    assert.equal(
      text,
      '{\n  "trusttunnel": "1.3.1",\n  "trusttunnel-client": "1.3.0"\n}\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("publish_packages", async () => {
  const dir = await tempDir("trusttunnel-publish-");
  try {
    const debsDir = join(dir, "debs");
    await mkdir(debsDir, { recursive: true });

    const assetBytes = new Map([
      ["trusttunnel-client_1.2.0_x86_64.deb", Buffer.from("client 1.2.0")],
      ["trusttunnel-client_1.1.0_x86_64.deb", Buffer.from("client 1.1.0")],
      ["trusttunnel-client_1.0.0_x86_64.deb", Buffer.from("client 1.0.0")],
      ["trusttunnel_1.1.0_x86_64.deb", Buffer.from("endpoint 1.1.0")],
      ["trusttunnel_1.0.0_aarch64.deb", Buffer.from("endpoint 1.0.0")],
    ]);
    const seedReleases = [
      seedRelease(
        1,
        "trusttunnel-client-v1.2.0",
        ["trusttunnel-client_1.2.0_x86_64.deb"],
        assetBytes,
      ),
      seedRelease(
        2,
        "trusttunnel-client-v1.1.0",
        ["trusttunnel-client_1.1.0_x86_64.deb"],
        assetBytes,
      ),
      seedRelease(
        3,
        "trusttunnel-client-v1.0.0",
        ["trusttunnel-client_1.0.0_x86_64.deb"],
        assetBytes,
      ),
      seedRelease(
        4,
        "trusttunnel-v1.1.0",
        ["trusttunnel_1.1.0_x86_64.deb"],
        assetBytes,
      ),
      seedRelease(
        5,
        "trusttunnel-v1.0.0",
        ["trusttunnel_1.0.0_aarch64.deb"],
        assetBytes,
      ),
    ];
    const { calls, fetchImpl } = createReleaseStore(seedReleases, assetBytes);

    const currentNames = [
      "trusttunnel-client_1.3.0_aarch64.deb",
      "trusttunnel-client_1.3.0_x86_64.deb",
      "trusttunnel_1.3.1_x86_64.deb",
    ];
    const debs = [];
    for (const name of currentNames) {
      const path = join(debsDir, name);
      await writeFile(path, `bytes ${name}`);
      debs.push(path);
    }
    await writeFile(
      join(debsDir, "trusttunnel-client_1.2.0_x86_64.deb"),
      "kept local",
    );

    await publishPackages({
      packages: [{ name: "trusttunnel-client" }, { name: "trusttunnel" }],
      debs,
      debsDir,
      versions: { "trusttunnel-client": "1.3.0", trusttunnel: "1.3.1" },
      repo: REPO,
      token: TOKEN,
      fetchImpl,
    });

    const lists = calls.filter(
      (call) =>
        call.url === `https://api.github.com/repos/${REPO}/releases?per_page=100`,
    );
    assert.equal(lists.length, 4);
    assert.deepEqual(lists.map((call) => call.method), [
      "GET",
      "GET",
      "GET",
      "GET",
    ]);

    const creates = calls.filter(
      (call) => call.url === `https://api.github.com/repos/${REPO}/releases`,
    );
    assert.deepEqual(creates.map((call) => call.method), ["POST", "POST"]);

    const uploads = calls.filter((call) =>
      call.url.startsWith("https://uploads.github.com/"),
    );
    assert.deepEqual(uploads.map((call) => call.method), [
      "POST",
      "POST",
      "POST",
    ]);
    const expectedUploads = [
      "100 trusttunnel-client_1.3.0_aarch64.deb",
      "100 trusttunnel-client_1.3.0_x86_64.deb",
      "101 trusttunnel_1.3.1_x86_64.deb",
    ];
    assert.deepEqual(
      uploads
        .map((call) => {
          const match = call.url.match(
            /\/releases\/(\d+)\/assets\?name=(.+)$/,
          );
          return `${match[1]} ${decodeURIComponent(match[2])}`;
        })
        .sort(),
      [...expectedUploads].sort(),
    );

    const downloadPrefix = "https://example.test/assets/";
    const downloads = calls.filter((call) =>
      call.url.startsWith(downloadPrefix),
    );
    assert.deepEqual(downloads.map((call) => call.method), [
      "GET",
      "GET",
      "GET",
    ]);
    assert.deepEqual(
      downloads.map((call) => call.url.slice(downloadPrefix.length)).sort(),
      [
        "trusttunnel-client_1.1.0_x86_64.deb",
        "trusttunnel_1.0.0_aarch64.deb",
        "trusttunnel_1.1.0_x86_64.deb",
      ].sort(),
    );

    assert.equal(
      calls.some(
        (call) => call.method === "PATCH" || call.method === "PUT",
      ),
      false,
    );
    assert.equal(
      await readFile(
        join(debsDir, "trusttunnel-client_1.2.0_x86_64.deb"),
        "utf8",
      ),
      "kept local",
    );
    assert.deepEqual(
      await readFile(join(debsDir, "trusttunnel-client_1.1.0_x86_64.deb")),
      assetBytes.get("trusttunnel-client_1.1.0_x86_64.deb"),
    );
    assert.deepEqual(
      await readFile(join(debsDir, "trusttunnel_1.1.0_x86_64.deb")),
      assetBytes.get("trusttunnel_1.1.0_x86_64.deb"),
    );
    assert.deepEqual(
      await readFile(join(debsDir, "trusttunnel_1.0.0_aarch64.deb")),
      assetBytes.get("trusttunnel_1.0.0_aarch64.deb"),
    );
    await assert.rejects(() =>
      readFile(join(debsDir, "trusttunnel-client_1.0.0_x86_64.deb")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("publish_conflict", async () => {
  const dir = await tempDir("trusttunnel-publish-conflict-");
  try {
    const debsDir = join(dir, "debs");
    await mkdir(debsDir, { recursive: true });
    const name = "trusttunnel-client_1.3.0_x86_64.deb";
    const deb = join(debsDir, name);
    await writeFile(deb, "local bytes");

    const existing = {
      id: 7,
      tag_name: "trusttunnel-client-v1.3.0",
      assets: [
        {
          id: 8,
          name,
          digest: `sha256:${createHash("sha256").update("other bytes").digest("hex")}`,
        },
      ],
    };
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method });
      if (
        url === `https://api.github.com/repos/${REPO}/releases?per_page=100`
      ) {
        return jsonResponse([existing]);
      }
      throw new Error(`unexpected request ${method} ${url}`);
    };

    await assert.rejects(
      () =>
        publishPackages({
          packages: [{ name: "trusttunnel-client" }],
          debs: [deb],
          debsDir,
          versions: { "trusttunnel-client": "1.3.0" },
          repo: REPO,
          token: TOKEN,
          fetchImpl,
        }),
      /digest|conflict/i,
    );
    assert.equal(
      calls.some((call) => call.url.startsWith("https://uploads.github.com/")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("publish_skips_older_upstream", async (t) => {
  if (
    !hasCommand("dpkg-deb") ||
    !hasCommand("gpg") ||
    !hasCommand("python3")
  ) {
    t.skip("dpkg-deb, gpg, or python3 is not installed");
    return;
  }

  const root = await tempDir("trusttunnel-publish-older-");
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const originalHome = process.env.GNUPGHOME;
  try {
    const versionsText = '{\n  "trusttunnel-client": "1.4.0"\n}\n';
    await writeFile(join(root, "versions.json"), versionsText);
    await mkdir(join(root, "templates"), { recursive: true });
    await writeFile(
      join(root, "templates/index.html"),
      "<html>__VERSIONS__</html>",
    );

    const seedRoot = join(root, "seed");
    const seedBinary = join(seedRoot, "trusttunnel_client");
    const seedLicense = join(seedRoot, "LICENSE");
    await mkdir(seedRoot, { recursive: true });
    await writeFile(seedBinary, "published binary");
    await writeFile(seedLicense, "license");
    const name = "trusttunnel-client_1.4.0_x86_64.deb";
    const deb = await buildDeb({
      root: join(seedRoot, "build"),
      packageName: "trusttunnel-client",
      version: "1.4.0",
      arch: "x86_64",
      binaryPath: seedBinary,
      licensePath: seedLicense,
    });
    const debBytes = await readFile(deb);
    const assetBytes = new Map([[name, debBytes]]);
    const published = seedRelease(
      1,
      "trusttunnel-client-v1.4.0",
      [name],
      assetBytes,
    );

    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      if (
        url ===
        "https://api.github.com/repos/TrustTunnel/TrustTunnelClient/releases/latest"
      ) {
        return jsonResponse({
          tag_name: "v1.2.0",
          assets: [
            {
              name: "trusttunnel_client-v1.2.0-linux-x86_64.tar.gz",
              digest: `sha256:${"0".repeat(64)}`,
              browser_download_url: "https://example.test/older.tar.gz",
            },
          ],
        });
      }
      if (url === `https://api.github.com/repos/${REPO}/releases?per_page=100`) {
        return jsonResponse([published]);
      }
      if (url.startsWith("https://example.test/assets/")) {
        const assetName = url.slice("https://example.test/assets/".length);
        return new Response(assetBytes.get(assetName), { status: 200 });
      }
      throw new Error(`unexpected request ${init.method ?? "GET"} ${url}`);
    };

    const gnupg = join(root, "gnupg");
    await mkdir(gnupg, { recursive: true, mode: 0o700 });
    process.env.GITHUB_TOKEN = TOKEN;
    process.env.GITHUB_REPOSITORY = REPO;
    process.env.GNUPGHOME = gnupg;
    await execFile("gpg", [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Older Test <older@example.invalid>",
      "rsa2048",
      "sign",
      "0",
    ]);

    await main([
      "--root",
      root,
      "--site",
      join(root, "site"),
      "--only",
      "trusttunnel-client",
      "--publish",
      "--sign",
    ]);

    assert.equal(
      calls.some((call) => call.url === "https://example.test/older.tar.gz"),
      false,
    );
    assert.equal(
      calls.some((call) => call.url.startsWith("https://uploads.github.com/")),
      false,
    );
    assert.equal(
      calls.some(
        (call) =>
          call.url === `https://api.github.com/repos/${REPO}/releases` &&
          call.method === "POST",
      ),
      false,
    );
    assert.equal(await readFile(join(root, "versions.json"), "utf8"), versionsText);
    assert.deepEqual(
      await readFile(
        join(root, "site", `dists/termux/extras/binary-x86_64`, name),
      ),
      debBytes,
    );
    assert.match(
      await readFile(
        join(root, "site", "dists/termux/extras/binary-x86_64/Packages"),
        "utf8",
      ),
      /Version: 1\.4\.0/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalRepository;
    }
    if (originalHome === undefined) {
      delete process.env.GNUPGHOME;
    } else {
      process.env.GNUPGHOME = originalHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("publish_skips_published_assets", async (t) => {
  if (
    !hasCommand("dpkg-deb") ||
    !hasCommand("gpg") ||
    !hasCommand("python3")
  ) {
    t.skip("dpkg-deb, gpg, or python3 is not installed");
    return;
  }

  const root = await tempDir("trusttunnel-publish-skip-");
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const originalHome = process.env.GNUPGHOME;
  try {
    await writeFile(
      join(root, "versions.json"),
      '{\n  "trusttunnel-client": "1.3.0"\n}\n',
    );
    await mkdir(join(root, "templates"), { recursive: true });
    await writeFile(
      join(root, "templates/index.html"),
      "<html>__VERSIONS__</html>",
    );

    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "trusttunnel_client"), "upstream binary");
    await writeFile(join(source, "LICENSE"), "license");
    const archive = join(root, "asset.tar.gz");
    await execFile("tar", ["-czf", archive, "-C", source, "."]);
    const archiveBytes = await readFile(archive);
    const archiveDigest = digestOf(archiveBytes);

    const seedRoot = join(root, "seed");
    const seedBinary = join(seedRoot, "trusttunnel_client");
    const seedLicense = join(seedRoot, "LICENSE");
    await mkdir(seedRoot, { recursive: true });
    await writeFile(seedBinary, "published binary");
    await writeFile(seedLicense, "license");
    const assetBytes = new Map();
    for (const arch of ["aarch64", "arm", "x86_64"]) {
      const name = `trusttunnel-client_1.3.0_${arch}.deb`;
      const deb = await buildDeb({
        root: join(seedRoot, arch),
        packageName: "trusttunnel-client",
        version: "1.3.0",
        arch,
        binaryPath: seedBinary,
        licensePath: seedLicense,
      });
      assetBytes.set(name, await readFile(deb));
    }
    const published = seedRelease(
      1,
      "trusttunnel-client-v1.3.0",
      [...assetBytes.keys()],
      assetBytes,
    );

    const tarballNames = [
      "trusttunnel_client-v1.3.0-linux-aarch64.tar.gz",
      "trusttunnel_client-v1.3.0-linux-armv7.tar.gz",
      "trusttunnel_client-v1.3.0-linux-x86_64.tar.gz",
    ];
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      if (
        url ===
        "https://api.github.com/repos/TrustTunnel/TrustTunnelClient/releases/latest"
      ) {
        return jsonResponse({
          tag_name: "v1.3.0",
          assets: tarballNames.map((name, index) => ({
            name,
            digest: archiveDigest,
            browser_download_url: `https://example.test/asset-${index}.tar.gz`,
          })),
        });
      }
      if (url === `https://api.github.com/repos/${REPO}/releases?per_page=100`) {
        return jsonResponse([published]);
      }
      if (url.startsWith("https://example.test/asset-")) {
        return new Response(archiveBytes, { status: 200 });
      }
      if (url.startsWith("https://example.test/assets/")) {
        const name = url.slice("https://example.test/assets/".length);
        return new Response(assetBytes.get(name), { status: 200 });
      }
      throw new Error(`unexpected request ${init.method ?? "GET"} ${url}`);
    };

    const gnupg = join(root, "gnupg");
    await mkdir(gnupg, { recursive: true, mode: 0o700 });
    process.env.GITHUB_TOKEN = TOKEN;
    process.env.GITHUB_REPOSITORY = REPO;
    process.env.GNUPGHOME = gnupg;
    await execFile("gpg", [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Publish Test <publish@example.invalid>",
      "rsa2048",
      "sign",
      "0",
    ]);

    await main([
      "--root",
      root,
      "--site",
      join(root, "site"),
      "--only",
      "trusttunnel-client",
      "--publish",
      "--sign",
    ]);

    assert.equal(
      calls.some((call) => call.url.startsWith("https://uploads.github.com/")),
      false,
    );
    assert.equal(
      calls.some((call) => call.url.startsWith("https://example.test/asset-")),
      false,
    );
    assert.equal(
      await readFile(join(root, "site", "dists/termux/InRelease")).then(
        () => true,
      ),
      true,
    );
    for (const arch of ["aarch64", "arm", "x86_64"]) {
      const name = `trusttunnel-client_1.3.0_${arch}.deb`;
      assert.deepEqual(
        await readFile(
          join(root, "site", `dists/termux/extras/binary-${arch}`, name),
        ),
        assetBytes.get(name),
      );
      assert.equal(
        await readFile(
          join(root, "site", `dists/termux/extras/binary-${arch}/Packages`),
        ).then(() => true),
        true,
      );
    }
    assert.equal(
      await readFile(
        join(root, "site", "dists/termux/extras/binary-x86_64/Packages"),
        "utf8",
      ).then((text) => text.includes("Version: 1.3.0")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalRepository;
    }
    if (originalHome === undefined) {
      delete process.env.GNUPGHOME;
    } else {
      process.env.GNUPGHOME = originalHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("publish_sign_key_checked_before_upload", async (t) => {
  if (!hasCommand("dpkg-deb") || !hasCommand("gpg")) {
    t.skip("dpkg-deb or gpg is not installed");
    return;
  }

  const root = await tempDir("trusttunnel-publish-order-");
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalHome = process.env.GNUPGHOME;
  try {
    const gnupg = join(root, "gnupg");
    await mkdir(gnupg, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "versions.json"), "{}\n");

    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "trusttunnel_endpoint"), "binary");
    await writeFile(join(source, "LICENSE"), "license");
    const archive = join(root, "asset.tar.gz");
    await execFile("tar", ["-czf", archive, "-C", source, "."]);
    const archiveBytes = await readFile(archive);
    const digest = digestOf(archiveBytes);

    const assetNames = [
      "trusttunnel_endpoint-v1.3.1-linux-aarch64.tar.gz",
      "trusttunnel_endpoint-v1.3.1-linux-x86_64.tar.gz",
    ];
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      if (
        url ===
        "https://api.github.com/repos/TrustTunnel/TrustTunnel/releases/latest"
      ) {
        return jsonResponse({
          tag_name: "v1.3.1",
          assets: assetNames.map((name, index) => ({
            name,
            digest,
            browser_download_url: `https://example.test/asset-${index}.tar.gz`,
          })),
        });
      }
      if (url === `https://api.github.com/repos/${REPO}/releases?per_page=100`) {
        return jsonResponse([]);
      }
      if (url.startsWith("https://example.test/asset-")) {
        return new Response(archiveBytes, { status: 200 });
      }
      throw new Error(`unexpected request ${init.method ?? "GET"} ${url}`);
    };
    process.env.GITHUB_TOKEN = TOKEN;
    process.env.GNUPGHOME = gnupg;

    await assert.rejects(
      () =>
        main([
          "--root",
          root,
          "--site",
          join(root, "site"),
          "--only",
          "trusttunnel",
          "--publish",
          "--sign",
        ]),
      /signing key/i,
    );
    assert.equal(
      calls.some((call) => call.url.startsWith("https://uploads.github.com/")),
      false,
    );
    assert.equal(
      calls.some(
        (call) =>
          call.url === `https://api.github.com/repos/${REPO}/releases`,
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalHome === undefined) {
      delete process.env.GNUPGHOME;
    } else {
      process.env.GNUPGHOME = originalHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});
