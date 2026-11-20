export const packages = [
  {
    name: "trusttunnel-client",
    repo: "TrustTunnel/TrustTunnelClient",
    binary: "trusttunnel_client",
    description: "Command-line client for the TrustTunnel VPN protocol",
    homepage: "https://github.com/TrustTunnel/TrustTunnelClient",
    arches: [
      { deb: "aarch64", asset: /-linux-aarch64\.tar\.gz$/ },
      { deb: "arm", asset: /-linux-armv7\.tar\.gz$/ },
      { deb: "x86_64", asset: /-linux-x86_64\.tar\.gz$/ },
    ],
  },
  {
    name: "trusttunnel",
    repo: "TrustTunnel/TrustTunnel",
    binary: "trusttunnel_endpoint",
    description: "VPN endpoint with the TrustTunnel protocol",
    homepage: "https://github.com/TrustTunnel/TrustTunnel",
    arches: [
      { deb: "aarch64", asset: /-linux-aarch64\.tar\.gz$/ },
      { deb: "x86_64", asset: /-linux-x86_64\.tar\.gz$/ },
    ],
  },
];

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

export function versionFromTag(tag, tagSuffix = "") {
  let value = String(tag ?? "");
  if (value.startsWith("v")) {
    value = value.slice(1);
  }
  if (tagSuffix) {
    if (!value.endsWith(tagSuffix)) {
      throw new Error(`tag ${tag} does not end with suffix ${tagSuffix}`);
    }
    value = value.slice(0, -tagSuffix.length);
  }
  if (!VERSION.test(value)) {
    throw new Error(`tag ${tag} is not a version tag`);
  }
  return value;
}

export function findAsset(release, pattern) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((item) => pattern.test(item.name));
  if (!asset) {
    throw new Error(
      `release ${release?.tag_name ?? "<unknown>"} has no asset matching ${pattern}`,
    );
  }
  return asset;
}

export function requireDigest(asset) {
  const digest = asset?.digest;
  if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
    throw new Error(
      `asset ${asset?.name ?? "<unknown>"} has no valid sha256 digest`,
    );
  }
  return digest;
}

export function debName(packageName, version, arch) {
  return `${packageName}_${version}_${arch}.deb`;
}

export function releaseTag(packageName, version) {
  return `${packageName}-v${version}`;
}

function parseVersion(tag) {
  const match = VERSION_TAG.exec(String(tag ?? ""));
  if (!match) {
    throw new Error(`invalid version tag: ${tag}`);
  }
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
}

function compareVersions(leftTag, rightTag) {
  const left = parseVersion(leftTag);
  const right = parseVersion(rightTag);
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) {
      return left.parts[index] - right.parts[index];
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (!left.prerelease) {
    return 1;
  }
  if (!right.prerelease) {
    return -1;
  }
  return left.prerelease.localeCompare(right.prerelease);
}

export function selectRetained(releases, keep = 3) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error("keep must be a positive integer");
  }
  return [...releases]
    .sort((left, right) => compareVersions(right.tag_name, left.tag_name))
    .slice(0, keep);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`package field ${field} is required`);
  }
}

export function validateManifest(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("manifest must be a non-empty array");
  }
  const names = new Set();
  for (const item of items) {
    requireString(item?.name, "name");
    requireString(item?.repo, "repo");
    requireString(item?.binary, "binary");
    requireString(item?.description, "description");
    requireString(item?.homepage, "homepage");
    if (names.has(item.name)) {
      throw new Error(`duplicate package name: ${item.name}`);
    }
    names.add(item.name);
    if (!Array.isArray(item.arches) || item.arches.length === 0) {
      throw new Error(`package ${item.name} must list at least one arch`);
    }
    const archNames = new Set();
    for (const arch of item.arches) {
      requireString(arch?.deb, `arches.deb for ${item.name}`);
      if (!(arch?.asset instanceof RegExp)) {
        throw new Error(
          `package ${item.name} arch ${arch.deb} needs a RegExp asset`,
        );
      }
      if (archNames.has(arch.deb)) {
        throw new Error(
          `duplicate arch ${arch.deb} in package ${item.name}`,
        );
      }
      archNames.add(arch.deb);
    }
  }
}

validateManifest(packages);
