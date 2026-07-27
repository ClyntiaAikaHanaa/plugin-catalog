// Perkakas bersama untuk script katalog.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_PLUGINS = join(ROOT, "src", "plugins");
export const DIST = join(ROOT, "dist");

/// Host yang boleh menjadi sumber unduhan.
///
/// Daftar ini harus tetap sinkron dengan `DOWNLOAD_HOST_ALLOWLIST` di
/// `hub-core/src/lib.rs`. Keduanya ada dengan sengaja: CI mencegah katalog
/// rusak keluar, launcher mencegah katalog rusak masuk. Kalau satu daftar
/// diperbarui, perbarui yang lain di commit yang sama.
export const HOST_ALLOWLIST = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
];

export const HOST_SUFFIX_ALLOWLIST = [".githubusercontent.com", ".github.io"];

export function hostIsAllowed(host) {
  const normalized = String(host).replace(/\.$/, "").toLowerCase();
  if (HOST_ALLOWLIST.includes(normalized)) return true;
  return HOST_SUFFIX_ALLOWLIST.some((suffix) => normalized.endsWith(suffix));
}

export function assertAllowedUrl(raw, context) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${context}: URL tidak valid — ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${context}: URL bukan https — ${raw}`);
  }
  if (!hostIsAllowed(url.hostname)) {
    throw new Error(`${context}: host di luar allowlist — ${url.hostname}`);
  }
  return url;
}

export async function readPluginFiles() {
  const names = (await readdir(SRC_PLUGINS)).filter((n) => n.endsWith(".json")).sort();
  const plugins = [];
  for (const name of names) {
    const raw = await readFile(join(SRC_PLUGINS, name), "utf8");
    try {
      plugins.push({ file: name, data: JSON.parse(raw) });
    } catch (e) {
      throw new Error(`${name}: JSON tidak dapat diparsing — ${e.message}`);
    }
  }
  return plugins;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/// Bandingkan dua semver. Sengaja tidak memakai perbandingan string: itu bug
/// `1.10.0 < 1.9.0` yang persis kita hindari di launcher.
export function compareSemver(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v).replace(/^v/, ""));
    if (!m) throw new Error(`versi tidak valid: ${v}`);
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ?? null,
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  // Pre-release selalu lebih rendah daripada rilis final dengan angka sama.
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/// Unduh asset dan hitung hash-nya sendiri.
///
/// Nilai yang ditulis manusia (atau dikirim workflow lain) **tidak dipercaya**
/// — PRD §10.5 langkah 2. Ini yang menjamin katalog tidak dapat berbeda dari
/// kenyataan.
export async function fetchAndHash(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "studio-hub-catalog-ci" },
  });
  if (!response.ok) {
    throw new Error(`gagal mengunduh ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { sha256: sha256(buffer), sizeBytes: buffer.length };
}

export function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

export function ok(message) {
  console.log(`✓ ${message}`);
}
