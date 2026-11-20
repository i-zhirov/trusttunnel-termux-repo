import test from "node:test";
import assert from "node:assert/strict";

import {
  debName,
  findAsset,
  packages,
  releaseTag,
  requireDigest,
  selectRetained,
  validateManifest,
  versionFromTag,
} from "./packages.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function release(tag, assets = []) {
  return { tag_name: tag, assets };
}

test("version_from_tag", () => {
  assert.equal(versionFromTag("v1.3.0"), "1.3.0");
  assert.equal(versionFromTag("1.3.0"), "1.3.0");
  assert.equal(versionFromTag("v1.4.13-release", "-release"), "1.4.13");
  assert.throws(() => versionFromTag("latest"), /version/i);
  assert.throws(() => versionFromTag("v1.3"), /version/i);
  assert.throws(() => versionFromTag("v1.3.0", "-release"), /suffix/i);
});

test("find_asset_priority", () => {
  const assets = [
    { name: "trusttunnel_client-v1.3.0-linux-x86_64-dbgsym.tar.gz" },
    { name: "trusttunnel_client-v1.3.0-linux-armv7.tar.gz" },
    { name: "trusttunnel_client-v1.3.0-windows-x86_64.zip" },
    { name: "trusttunnel_client-v1.3.0-linux-x86_64.tar.gz" },
    { name: "trusttunnel_client-v1.3.0-linux-x86_64.tar.gz.sig" },
  ];
  const found = findAsset(
    release("v1.3.0", assets),
    /-linux-x86_64\.tar\.gz$/,
  );
  assert.equal(
    found.name,
    "trusttunnel_client-v1.3.0-linux-x86_64.tar.gz",
  );
});

test("find_asset_missing", () => {
  assert.throws(
    () => findAsset(release("v1.3.0"), /-linux-x86_64\.tar\.gz$/),
    /v1\.3\.0/,
  );
});

test("require_digest", () => {
  assert.equal(
    requireDigest({ name: "trusttunnel_client", digest: DIGEST }),
    DIGEST,
  );
  assert.throws(
    () => requireDigest({ name: "trusttunnel_client" }),
    /digest/i,
  );
  assert.throws(
    () => requireDigest({ name: "trusttunnel_client", digest: "sha256:abc" }),
    /digest/i,
  );
  assert.throws(
    () =>
      requireDigest({
        name: "trusttunnel_client",
        digest: `md5:${"a".repeat(32)}`,
      }),
    /digest/i,
  );
});

test("deb_name", () => {
  assert.equal(
    debName("trusttunnel-client", "1.3.0", "aarch64"),
    "trusttunnel-client_1.3.0_aarch64.deb",
  );
  assert.equal(
    debName("trusttunnel", "1.3.1", "x86_64"),
    "trusttunnel_1.3.1_x86_64.deb",
  );
});

test("release_tag", () => {
  assert.equal(
    releaseTag("trusttunnel-client", "1.3.0"),
    "trusttunnel-client-v1.3.0",
  );
  assert.equal(releaseTag("trusttunnel", "1.3.1"), "trusttunnel-v1.3.1");
});

test("select_retained", () => {
  const input = [
    release("v1.2.0"),
    release("v1.10.0"),
    release("v1.4.0-rc.1"),
    release("v1.4.0"),
    release("v1.9.0"),
  ];
  const copy = [...input];
  const result = selectRetained(input, 3);
  assert.deepEqual(
    result.map((item) => item.tag_name),
    ["v1.10.0", "v1.9.0", "v1.4.0"],
  );
  assert.deepEqual(input, copy);
  assert.equal(selectRetained(input).length, 3);
  assert.throws(() => selectRetained(input, 0), /keep/i);
});

test("validate_manifest", () => {
  const base = {
    name: "trusttunnel-client",
    repo: "TrustTunnel/TrustTunnelClient",
    binary: "trusttunnel_client",
    description: "Command-line client for the TrustTunnel VPN protocol",
    homepage: "https://github.com/TrustTunnel/TrustTunnelClient",
    arches: [{ deb: "aarch64", asset: /-linux-aarch64\.tar\.gz$/ }],
  };
  assert.doesNotThrow(() => validateManifest([base]));
  assert.throws(() => validateManifest([base, base]), /duplicate/i);
  assert.throws(
    () => validateManifest([{ ...base, arches: [] }]),
    /arch/i,
  );
  assert.throws(
    () =>
      validateManifest([
        { ...base, arches: [base.arches[0], { ...base.arches[0] }] },
      ]),
    /duplicate/i,
  );
  assert.throws(() => validateManifest([{ ...base, name: "" }]), /name/i);
  assert.throws(() => validateManifest([{ ...base, binary: "" }]), /binary/i);
});

test("manifest_contract", () => {
  assert.equal(packages.length, 2);
  const client = packages.find(
    (item) => item.name === "trusttunnel-client",
  );
  const server = packages.find((item) => item.name === "trusttunnel");
  assert.ok(client);
  assert.ok(server);
  assert.equal(client.repo, "TrustTunnel/TrustTunnelClient");
  assert.equal(client.binary, "trusttunnel_client");
  assert.deepEqual(
    client.arches.map((arch) => arch.deb),
    ["aarch64", "arm", "x86_64"],
  );
  assert.equal(server.repo, "TrustTunnel/TrustTunnel");
  assert.equal(server.binary, "trusttunnel_endpoint");
  assert.deepEqual(
    server.arches.map((arch) => arch.deb),
    ["aarch64", "x86_64"],
  );
  assert.match(
    "trusttunnel_client-v1.3.0-linux-aarch64.tar.gz",
    client.arches[0].asset,
  );
  assert.match(
    "trusttunnel_client-v1.3.0-linux-armv7.tar.gz",
    client.arches[1].asset,
  );
  assert.match(
    "trusttunnel_client-v1.3.0-linux-x86_64.tar.gz",
    client.arches[2].asset,
  );
  assert.match(
    "trusttunnel-v1.3.1-linux-aarch64.tar.gz",
    server.arches[0].asset,
  );
  assert.match(
    "trusttunnel-v1.3.1-linux-x86_64.tar.gz",
    server.arches[1].asset,
  );
  assert.doesNotMatch(
    "trusttunnel-v1.3.1-linux-x86_64-dbgsym.tar.gz",
    server.arches[1].asset,
  );
});
