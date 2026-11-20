import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  debName,
  findAsset,
  packages,
  requireDigest,
  versionFromTag,
} from "./packages.js";
import { assembleSite } from "./site.js";

const execFile = promisify(execFileCallback);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const USER_AGENT = "trusttunnel-termux-repo";

export function parseArgs(argv) {
  let root = process.cwd();
  let site = null;
  let dryRun = false;
  let only = null;
  let sign = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--root":
        root = requireValue(argv, ++index, argument);
        break;
      case "--site":
        site = requireValue(argv, ++index, argument);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--only":
        only = requireValue(argv, ++index, argument);
        break;
      case "--sign":
        sign = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (only && !packages.some((item) => item.name === only)) {
    throw new Error(`unknown package: ${only}`);
  }

  return {
    root,
    site: site ?? join(root, "site"),
    dryRun,
    only,
    sign,
  };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

async function request(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { headers });
}

export async function fetchLatestRelease(repo, token) {
  const response = await request(
    `https://api.github.com/repos/${repo}/releases/latest`,
    token,
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`GitHub API ${response.status} for ${repo}: ${body}`);
  }
  return response.json();
}

export async function downloadAsset(url, destination, token) {
  const response = await request(url, token);
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`download ${response.status} for ${url}: ${body}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

export async function verifySha256(file, digest) {
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    throw new Error(`invalid sha256 digest: ${digest}`);
  }
  const bytes = await readFile(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === digest.slice("sha256:".length);
}

export async function extractAsset(archive, destination) {
  await mkdir(destination, { recursive: true });
  await execFile("tar", ["-xzf", archive, "-C", destination]);
}

export async function resolveExtracted(destination, binaryName) {
  const binaryPath = await findFile(destination, binaryName);
  if (!binaryPath) {
    throw new Error(`no ${binaryName} file under ${destination}`);
  }
  const licensePath = join(dirname(binaryPath), "LICENSE");
  try {
    await access(licensePath);
  } catch {
    throw new Error(`no LICENSE file next to ${binaryPath}`);
  }
  return { binaryPath, licensePath };
}

async function findFile(directory, name) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) {
        return found;
      }
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}

export async function buildDeb(options) {
  const definition = packages.find(
    (item) => item.name === options.packageName,
  );
  if (!definition) {
    throw new Error(`unknown package: ${options.packageName}`);
  }

  const stage = join(options.root, "stage");
  const dataRoot = join(stage, "data");
  const binDir = join(dataRoot, "data/com.termux/files/usr/bin");
  const docDir = join(
    dataRoot,
    `data/com.termux/files/usr/share/doc/${definition.name}`,
  );
  const controlDir = join(stage, "DEBIAN");

  await rm(stage, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(docDir, { recursive: true });
  await mkdir(controlDir, { recursive: true });

  const installedBinary = join(binDir, definition.binary);
  const installedLicense = join(docDir, "copyright");
  await cp(options.binaryPath, installedBinary);
  await chmod(installedBinary, 0o755);
  await cp(options.licensePath, installedLicense);
  await chmod(installedLicense, 0o644);

  const installedSize = await directorySizeKb(dataRoot);
  await writeFile(
    join(controlDir, "control"),
    [
      `Package: ${definition.name}`,
      `Version: ${options.version}`,
      `Architecture: ${options.arch}`,
      "Maintainer: TrustTunnel <devteam@adguard.com>",
      `Installed-Size: ${installedSize}`,
      "Section: net",
      "Priority: optional",
      `Homepage: ${definition.homepage}`,
      `Description: ${definition.description}`,
      "",
    ].join("\n"),
  );

  const outputDir = join(options.root, "debs");
  await mkdir(outputDir, { recursive: true });
  const output = join(
    outputDir,
    debName(options.packageName, options.version, options.arch),
  );
  await execFile("dpkg-deb", [
    "--build",
    "--root-owner-group",
    stage,
    output,
  ]);
  return output;
}

async function directorySizeKb(directory) {
  const { stdout } = await execFile("du", ["-sk", directory]);
  return Number.parseInt(stdout.trim().split(/\s+/)[0], 10);
}

export async function writeVersions(root, versions) {
  const ordered = {};
  for (const key of Object.keys(versions).sort()) {
    ordered[key] = versions[key];
  }
  await writeFile(
    join(root, "versions.json"),
    `${JSON.stringify(ordered, null, 2)}\n`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const versions = JSON.parse(
    await readFile(join(options.root, "versions.json"), "utf8"),
  );
  const selected = packages.filter(
    (item) => !options.only || item.name === options.only,
  );
  const token = process.env.GITHUB_TOKEN ?? "";
  const buildRoot = await mkdtemp(join(tmpdir(), "trusttunnel-repo-"));
  const assetsDir = join(buildRoot, "assets");
  const debs = [];
  const nextVersions = { ...versions };
  const dryRunLines = [];

  for (const item of selected) {
    const release = await fetchLatestRelease(item.repo, token);
    const version = versionFromTag(release.tag_name, item.tagSuffix ?? "");
    for (const arch of item.arches) {
      const asset = findAsset(release, arch.asset);
      requireDigest(asset);
      if (options.dryRun) {
        dryRunLines.push(
          `${item.name} ${version} ${arch.deb} ${asset.name}`,
        );
        continue;
      }
      const archive = join(
        assetsDir,
        `${item.name}_${arch.deb}_${asset.name}`,
      );
      await downloadAsset(asset.browser_download_url, archive, token);
      if (!(await verifySha256(archive, asset.digest))) {
        throw new Error(`digest mismatch for ${asset.name} in ${item.repo}`);
      }
      const extracted = join(assetsDir, `${item.name}_${arch.deb}`);
      await extractAsset(archive, extracted);
      const { binaryPath, licensePath } = await resolveExtracted(
        extracted,
        item.binary,
      );
      debs.push(
        await buildDeb({
          root: buildRoot,
          packageName: item.name,
          version,
          arch: arch.deb,
          binaryPath,
          licensePath,
        }),
      );
    }
    nextVersions[item.name] = version;
  }

  if (options.dryRun) {
    for (const line of dryRunLines) {
      console.log(line);
    }
    return;
  }

  await writeVersions(options.root, nextVersions);

  let publicKeyPath = null;
  if (options.sign) {
    publicKeyPath = join(buildRoot, "trusttunnel.gpg");
    const { stdout } = await execFile("gpg", ["--export"], {
      encoding: "buffer",
    });
    await writeFile(publicKeyPath, stdout);
  }

  await assembleSite({
    siteDir: options.site,
    debsDir: join(buildRoot, "debs"),
    publicKeyPath,
    templatePath: join(options.root, "templates/index.html"),
    versions: nextVersions,
    sign: options.sign,
  });

  for (const deb of debs) {
    console.log(deb);
  }
}

const isEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
