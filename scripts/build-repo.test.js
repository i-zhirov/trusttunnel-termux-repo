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
  parseArgs,
  resolveExtracted,
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

test("parse_args", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.root, process.cwd());
  assert.equal(defaults.site, join(process.cwd(), "site"));
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.only, null);
  assert.equal(defaults.sign, false);

  const options = parseArgs([
    "--root",
    "/tmp/root",
    "--dry-run",
    "--only",
    "trusttunnel",
    "--sign",
  ]);
  assert.equal(options.root, "/tmp/root");
  assert.equal(options.site, join("/tmp/root", "site"));
  assert.equal(options.dryRun, true);
  assert.equal(options.only, "trusttunnel");
  assert.equal(options.sign, true);

  const explicitSite = parseArgs(["--site", "/tmp/site", "--root", "/tmp/root"]);
  assert.equal(explicitSite.site, "/tmp/site");

  assert.throws(() => parseArgs(["--unknown"]), /unknown/i);
  assert.throws(() => parseArgs(["--root"]), /value/i);
  assert.throws(() => parseArgs(["--only", "nope"]), /unknown/i);
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
