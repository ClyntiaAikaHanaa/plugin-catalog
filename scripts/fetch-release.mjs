#!/usr/bin/env node
//
// Ambil metadata rilis GitHub, hitung SHA-256 sendiri, tulis ke
// `src/plugins/<id>.json` (PRD §10.5).
//
// Hasilnya: merilis plugin adalah `git tag v1.3.0 && git push --tags`. Tidak
// ada langkah manual dan tidak ada hash yang dihitung tangan — yang menurut
// §4.1 (Persona C) adalah satu-satunya cara proses ini tidak membusuk.
//
// Pemakaian:
//   node scripts/fetch-release.mjs --plugin mycomp --repo robi/MyComp \
//        --tag v1.3.0 [--breaking true] [--security true]

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SRC_PLUGINS, assertAllowedUrl, compareSemver, fetchAndHash } from "./lib.mjs";

/// Berapa banyak versi historis yang disimpan (Open Question Q5).
///
/// Tiga adalah kompromi: cukup untuk pengguna yang perlu kembali ke versi lama
/// karena project lama, tanpa membuat katalog membengkak seiring waktu.
const HISTORY_LIMIT = 3;

const args = parseArgs(process.argv.slice(2));
for (const required of ["plugin", "repo", "tag"]) {
  if (!args[required]) {
    console.error(`--${required} wajib diisi`);
    process.exit(2);
  }
}

const version = String(args.tag).replace(/^v/, "");
const pluginPath = join(SRC_PLUGINS, `${args.plugin}.json`);

const plugin = JSON.parse(await readFile(pluginPath, "utf8"));

// ── Metadata rilis ───────────────────────────────────────────────────────
const release = await githubJson(
  `https://api.github.com/repos/${args.repo}/releases/tags/${args.tag}`
);

const asset = pickWindowsAsset(release.assets ?? []);
if (!asset) {
  console.error(
    `rilis ${args.tag} tidak punya asset ZIP win64. Asset yang ada: ` +
      (release.assets ?? []).map((a) => a.name).join(", ")
  );
  process.exit(1);
}

const downloadUrl = asset.browser_download_url;
assertAllowedUrl(downloadUrl, `asset ${asset.name}`);

// Hash dihitung dari byte yang benar-benar diunduh, bukan dari nilai yang
// diberikan payload dispatch (§10.5 langkah 2).
const { sha256, sizeBytes } = await fetchAndHash(downloadUrl);
if (asset.size && asset.size !== sizeBytes) {
  console.error(
    `ukuran asset (${asset.size}) berbeda dari yang diunduh (${sizeBytes}) — dibatalkan`
  );
  process.exit(1);
}

// ── Susun entri rilis ────────────────────────────────────────────────────
const previousBuild = plugin.latest?.builds?.find((b) => b.target === "windows-x86_64");

const newRelease = {
  version,
  released_at: release.published_at ?? new Date().toISOString(),
  breaking: args.breaking === "true",
  security: args.security === "true",
  min_launcher_version: plugin.latest?.min_launcher_version ?? "1.0.0",
  changelog: normalizeChangelog(release.body ?? "", version),
  builds: [
    {
      target: "windows-x86_64",
      format: "vst3",
      url: downloadUrl,
      size_bytes: sizeBytes,
      sha256,
      // `archive_root` dipertahankan dari rilis sebelumnya jika ada: ia adalah
      // properti plugin, bukan properti rilis, dan menebaknya dari nama file
      // akan salah begitu nama repo berbeda dari nama bundle.
      archive_root: previousBuild?.archive_root ?? `${plugin.name}.vst3`,
      install_kind: "vst3_bundle",
      requires_vc_redist: previousBuild?.requires_vc_redist ?? true,
    },
  ],
};

// ── Geser latest → history ───────────────────────────────────────────────
if (plugin.latest) {
  if (compareSemver(version, plugin.latest.version) <= 0) {
    console.error(
      `versi ${version} tidak lebih tinggi dari latest ${plugin.latest.version} — dibatalkan`
    );
    process.exit(1);
  }
  plugin.history = [plugin.latest, ...(plugin.history ?? [])].slice(0, HISTORY_LIMIT);
}
plugin.latest = newRelease;

await writeFile(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
console.log(`✓ ${args.plugin} ${version} — sha256 ${sha256.slice(0, 16)}… (${sizeBytes} byte)`);

// ── Fungsi bantu ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

async function githubJson(url) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "studio-hub-catalog-ci" };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} untuk ${url}`);
  }
  return response.json();
}

/// Pilih asset ZIP Windows x64. Nama file yang tidak cocok pola lebih baik
/// gagal di sini daripada menghasilkan katalog yang menunjuk asset salah.
function pickWindowsAsset(assets) {
  return assets.find((a) => /win(64|dows)?.*\.zip$/i.test(a.name) || /\.zip$/i.test(a.name));
}

/// Body rilis GitHub sering memuat boilerplate ("Full Changelog: …").
/// Yang dipakai launcher adalah bagian yang benar-benar menjelaskan perubahan.
function normalizeChangelog(body, version) {
  const cleaned = body
    .split(/\r?\n/)
    .filter((line) => !/^\*\*Full Changelog\*\*/i.test(line.trim()))
    .join("\n")
    .trim();

  if (!cleaned) return `### ${version}\n`;
  return cleaned.startsWith("#") ? cleaned : `### ${version}\n${cleaned}`;
}
