import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildDeb } from "./build-repo.js";
import { assembleSite, renderLandingPage } from "./site.js";

const execFile = promisify(execFileCallback);

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasCommand(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function fixtureDeb(root) {
  const binaryPath = join(root, "trusttunnel_client");
  const licensePath = join(root, "LICENSE");
  await writeFile(binaryPath, "binary");
  await writeFile(licensePath, "license");
  return buildDeb({
    root: join(root, "build"),
    packageName: "trusttunnel-client",
    version: "1.3.0",
    arch: "x86_64",
    binaryPath,
    licensePath,
  });
}

const TEMPLATE =
  '<ul>__VERSIONS__</ul><a href="__REPO_URL__">repo</a><a href="__KEY_URL__">key</a><code>pkg install -y trusttunnel-client</code>';

test("render_landing_page", () => {
  const html = renderLandingPage(TEMPLATE, {
    versions: {
      "trusttunnel-client": "1.3.0",
      "<bad>": "1.0.0&",
    },
    repoUrl: "https://example.test/repo",
    keyUrl: "https://example.test/repo/keys/trusttunnel.gpg",
  });
  assert.match(html, /1\.3\.0/);
  assert.match(html, /&lt;bad&gt;/);
  assert.match(html, /1\.0\.0&amp;/);
  assert.match(html, /https:\/\/example\.test\/repo/);
  assert.match(html, /keys\/trusttunnel\.gpg/);
  assert.match(html, /pkg install -y trusttunnel-client/);
});

test("assemble_site_unsigned", async (t) => {
  if (!hasCommand("dpkg-deb") || !hasCommand("python3")) {
    t.skip("dpkg-deb or python3 is not installed");
    return;
  }
  const dir = await tempDir("trusttunnel-site-");
  try {
    const deb = await fixtureDeb(dir);
    const templatePath = join(dir, "index.html");
    await writeFile(templatePath, TEMPLATE);
    const siteDir = join(dir, "site");
    await assembleSite({
      siteDir,
      debsDir: dirname(deb),
      templatePath,
      versions: { "trusttunnel-client": "1.3.0" },
      sign: false,
    });
    assert.equal(await exists(join(siteDir, "index.html")), true);
    assert.equal(
      await exists(join(siteDir, "dists/termux/extras/binary-x86_64/Packages")),
      true,
    );
    assert.equal(
      await exists(
        join(siteDir, "dists/termux/extras/binary-x86_64/Packages.xz"),
      ),
      true,
    );
    assert.equal(
      await exists(join(siteDir, "dists/termux/Release")),
      true,
    );
    assert.equal(
      await exists(join(siteDir, "dists/termux/extras/Contents-x86_64")),
      true,
    );
    const packages = await readFile(
      join(siteDir, "dists/termux/extras/binary-x86_64/Packages"),
      "utf8",
    );
    assert.match(packages, /Package: trusttunnel-client/);
    assert.match(
      packages,
      /Filename: dists\/termux\/extras\/binary-x86_64\/trusttunnel-client_1\.3\.0_x86_64\.deb/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("assemble_site_signed", async (t) => {
  if (
    !hasCommand("dpkg-deb") ||
    !hasCommand("python3") ||
    !hasCommand("gpg")
  ) {
    t.skip("dpkg-deb, python3, or gpg is not installed");
    return;
  }
  const dir = await tempDir("trusttunnel-site-signed-");
  const previous = process.env.GNUPGHOME;
  try {
    const deb = await fixtureDeb(dir);
    const gnupgHome = await mkdtemp(join(dir, "gnupg-"));
    process.env.GNUPGHOME = gnupgHome;
    await execFile("gpg", [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Site Test <site@example.invalid>",
      "rsa2048",
      "sign",
      "0",
    ]);
    const publicKeyPath = join(dir, "trusttunnel.gpg");
    const exported = await execFile("gpg", ["--export"], {
      encoding: "buffer",
    });
    await writeFile(publicKeyPath, exported.stdout);
    const templatePath = join(dir, "index.html");
    await writeFile(templatePath, TEMPLATE);
    const siteDir = join(dir, "site");
    await assembleSite({
      siteDir,
      debsDir: dirname(deb),
      publicKeyPath,
      templatePath,
      versions: { "trusttunnel-client": "1.3.0" },
      sign: true,
    });
    assert.equal(
      await exists(join(siteDir, "dists/termux/InRelease")),
      true,
    );
    assert.equal(
      await exists(join(siteDir, "keys/trusttunnel.gpg")),
      true,
    );
    await execFile("gpg", [
      "--verify",
      join(siteDir, "dists/termux/InRelease"),
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.GNUPGHOME;
    } else {
      process.env.GNUPGHOME = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
