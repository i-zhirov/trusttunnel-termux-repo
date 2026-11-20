import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

const REPO_URL = "https://trusttunnel.github.io/termux-repo/";
const KEY_URL =
  "https://trusttunnel.github.io/termux-repo/keys/trusttunnel.gpg";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderLandingPage(template, data) {
  const versions = Object.entries(data.versions ?? {})
    .map(
      ([name, version]) =>
        `<li><code>${escapeHtml(name)}</code> ${escapeHtml(version)}</li>`,
    )
    .join("\n");
  return template
    .replaceAll("__VERSIONS__", versions)
    .replaceAll("__REPO_URL__", escapeHtml(data.repoUrl ?? REPO_URL))
    .replaceAll("__KEY_URL__", escapeHtml(data.keyUrl ?? KEY_URL));
}

export async function runTermuxAptRepo(options) {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "vendor",
    "termux-apt-repo",
  );
  const args = [
    script,
    options.inputDir,
    options.outputDir,
    "termux",
    "extras",
  ];
  if (options.sign) {
    args.push("--sign");
  }
  await execFile("python3", args);
}

export async function assembleSite(options) {
  await rm(options.siteDir, { recursive: true, force: true });
  await mkdir(options.siteDir, { recursive: true });
  const template = await readFile(options.templatePath, "utf8");
  const html = renderLandingPage(template, {
    versions: options.versions,
    repoUrl: REPO_URL,
    keyUrl: KEY_URL,
  });
  await writeFile(join(options.siteDir, "index.html"), html);
  if (options.publicKeyPath) {
    const keyDir = join(options.siteDir, "keys");
    await mkdir(keyDir, { recursive: true });
    await cp(options.publicKeyPath, join(keyDir, "trusttunnel.gpg"));
  }
  await runTermuxAptRepo({
    inputDir: options.debsDir,
    outputDir: options.siteDir,
    sign: options.sign === true,
  });
}
