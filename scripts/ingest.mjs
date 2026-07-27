// Logika ingest rilis, dipakai `fetch-release.mjs` (satu plugin, dipicu
// dispatch) dan `sync-repos.mjs` (semua plugin, dipicu jadwal).

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SRC_PLUGINS, assertAllowedUrl, compareSemver, fetchAndHash } from "./lib.mjs";

/// Berapa banyak versi historis yang disimpan (Open Question Q5).
///
/// Tiga adalah kompromi: cukup untuk pengguna yang perlu kembali ke versi lama
/// karena project lama, tanpa membuat katalog membengkak seiring waktu.
export const HISTORY_LIMIT = 3;

/// Topic yang menandai sebuah repo sebagai plugin (lihat `sync-repos.mjs`).
export const PLUGIN_TOPIC = "studio-hub-plugin";

export async function githubJson(url) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "studio-hub-catalog-ci",
  };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;

  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} untuk ${url}`);
  }
  return response.json();
}

/// `id` katalog diturunkan dari nama repo. Ia adalah kunci primer di database
/// pengguna dan tidak boleh pernah berubah setelah dirilis — jadi begitu file
/// pluginnya ada, id-nya tidak pernah dihitung ulang.
export function deriveId(repoName) {
  return repoName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function pluginPath(pluginId) {
  return join(SRC_PLUGINS, `${pluginId}.json`);
}

/// Buat file plugin baru dari metadata repo.
///
/// Field yang tidak dapat diketahui dari GitHub — kategori, `user_data`,
/// `requirements` — diisi default yang aman dan **harus** kamu sunting sendiri.
/// Karena itu plugin baru lahir dengan `hidden: true`: ia tidak tampil di
/// launcher sampai kamu memeriksanya. Menampilkan plugin dengan kategori asal
/// tebak lebih buruk daripada tidak menampilkannya sama sekali.
export function newPluginStub(repo, pluginId) {
  return {
    id: pluginId,
    name: repo.name,
    vendor: repo.owner?.login ?? "Unknown",
    category: "utility",
    tagline: (repo.description ?? repo.name).slice(0, 200),
    description: repo.description ?? "",
    homepage_url: repo.homepage?.startsWith("https://") ? repo.homepage : repo.html_url,
    source_url: repo.html_url,
    license: repo.license?.spdx_id ?? null,
    hidden: true,
    deprecated: repo.archived ?? false,
    deprecation_notice: null,
    commercial: { model: "free", requires_license: false, purchase_url: null },
    user_data: { preset_paths: [], config_paths: [] },
    requirements: {},
  };
}

/// Ambil README repo dan siapkan untuk renderer terbatas di launcher.
///
/// Dibakukan ke katalog saat ingest, bukan diambil saat aplikasi jalan:
/// halaman detail tetap terbaca offline, dan membuka sebuah plugin tidak
/// memicu request jaringan baru.
export async function fetchReadme(repo) {
  const data = await githubJson(`https://api.github.com/repos/${repo}/readme`);
  if (!data?.content) return "";
  const raw = Buffer.from(data.content, "base64").toString("utf8");
  return sanitizeReadme(raw);
}

/// Buang apa yang tidak dapat dirender launcher, sisakan prosanya.
///
/// Launcher merender Markdown lewat allowlist sempit: tidak ada HTML mentah,
/// tidak ada gambar, tidak ada link (PRD §14.5). Membersihkannya di sini —
/// sekali, di CI — lebih baik daripada menampilkan `<div align="center">`
/// sebagai teks di setiap mesin pengguna.
export function sanitizeReadme(markdown) {
  return (
    markdown
      // Blok HTML mentah, termasuk <div>, <img>, <p align=...>.
      .replace(/<\/?[a-z][^>]*>/gi, "")
      // Badge shields.io dan gambar lain: tidak dapat dimuat, dan barisnya
      // menjadi deretan tanda kurung yang tidak berarti.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // Link dipertahankan teksnya saja.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Komentar HTML.
      .replace(/<!--[\s\S]*?-->/g, "")
      // Rapikan sisa baris kosong berlebih setelah penghapusan di atas.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 80_000)
  );
}

/// Cari logo di repo untuk dipakai sebagai thumbnail.
///
/// URL menunjuk `raw.githubusercontent.com` pada tag rilis — host itu ada di
/// allowlist unduhan, dan menyematkan tag berarti ikon tidak berubah diam-diam
/// saat repo diperbarui.
export async function findLogoUrl(repo, tag) {
  const candidates = [
    "screenshot/logo.png",
    "Screenshot/Logo.png",
    "screenshot/Logo.png",
    "Screenshot/logo.png",
    "assets/logo.png",
    "docs/logo.png",
    "logo.png",
  ];
  for (const path of candidates) {
    const url = `https://raw.githubusercontent.com/${repo}/${tag}/${encodeURI(path)}`;
    try {
      const head = await fetch(url, {
        method: "HEAD",
        headers: { "user-agent": "studio-hub-catalog-ci" },
      });
      if (head.ok) return url;
    } catch {
      // Jaringan bermasalah untuk satu kandidat bukan alasan menggagalkan
      // ingest — ikon hanyalah hiasan.
    }
  }
  return null;
}

/// Pilih asset ZIP Windows x64.
function pickWindowsAsset(assets) {
  const zips = assets.filter((a) => /\.zip$/i.test(a.name));
  return zips.find((a) => /win(64|dows)/i.test(a.name)) ?? zips[0] ?? null;
}

/// Body rilis GitHub sering memuat boilerplate. Yang dipakai launcher adalah
/// bagian yang benar-benar menjelaskan perubahan.
function normalizeChangelog(body, version) {
  const cleaned = (body ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\*\*Full Changelog\*\*/i.test(line.trim()))
    .join("\n")
    .trim();

  if (!cleaned) return `### ${version}\n`;
  return cleaned.startsWith("#") ? cleaned : `### ${version}\n${cleaned}`;
}

/// Hasil ingest, supaya pemanggil dapat melaporkan apa yang terjadi.
/// `skipped` bukan kegagalan: repo tanpa rilis atau yang versinya sudah ada di
/// katalog adalah kondisi normal saat sinkronisasi terjadwal berjalan.
export const Outcome = {
  Updated: "updated",
  Created: "created",
  Skipped: "skipped",
};

/**
 * Ambil satu rilis, hitung SHA-256 sendiri, tulis ke `src/plugins/<id>.json`.
 *
 * `release` boleh diberikan langsung (saat pemanggil sudah mengambilnya) atau
 * dibiarkan `null` untuk diambil dari `tag`.
 */
export async function ingestRelease({
  pluginId,
  repo,
  tag,
  breaking = false,
  security = false,
  release = null,
  repoMeta = null,
}) {
  const path = pluginPath(pluginId);
  let plugin;
  let created = false;

  if (existsSync(path)) {
    plugin = JSON.parse(await readFile(path, "utf8"));
  } else {
    const meta = repoMeta ?? (await githubJson(`https://api.github.com/repos/${repo}`));
    if (!meta) throw new Error(`repo ${repo} tidak ditemukan`);
    plugin = newPluginStub(meta, pluginId);
    created = true;
  }

  const data = release ?? (await githubJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`));
  if (!data) {
    return { outcome: Outcome.Skipped, reason: `rilis ${tag} tidak ditemukan` };
  }

  const version = String(data.tag_name ?? tag).replace(/^v/, "");

  // Versi yang tidak lebih tinggi dari `latest` bukan error — sinkronisasi
  // terjadwal akan melihat rilis yang sama berkali-kali.
  if (plugin.latest && compareSemver(version, plugin.latest.version) <= 0) {
    return { outcome: Outcome.Skipped, reason: `${version} sudah ada di katalog` };
  }

  const asset = pickWindowsAsset(data.assets ?? []);
  if (!asset) {
    // Sebutkan asset yang benar-benar ada. "Tidak punya asset ZIP" saja
    // membuat orang mengira rilisnya kosong, padahal masalahnya formatnya.
    const names = (data.assets ?? []).map((a) => a.name);
    return {
      outcome: Outcome.Skipped,
      reason:
        `rilis ${version} tidak punya asset ZIP berisi bundle .vst3` +
        (names.length ? ` (yang ada: ${names.join(", ")})` : " (rilis tanpa asset)"),
    };
  }

  const downloadUrl = asset.browser_download_url;
  assertAllowedUrl(downloadUrl, `${repo} asset ${asset.name}`);

  // Hash dihitung dari byte yang benar-benar diunduh, bukan dari nilai yang
  // diberikan payload dispatch (PRD §10.5 langkah 2).
  const { sha256, sizeBytes } = await fetchAndHash(downloadUrl);
  if (asset.size && asset.size !== sizeBytes) {
    throw new Error(
      `${repo}: ukuran asset (${asset.size}) berbeda dari yang diunduh (${sizeBytes})`
    );
  }

  const previousBuild = plugin.latest?.builds?.find((b) => b.target === "windows-x86_64");

  const newRelease = {
    version,
    released_at: data.published_at ?? new Date().toISOString(),
    breaking: breaking === true || breaking === "true",
    security: security === true || security === "true",
    min_launcher_version: plugin.latest?.min_launcher_version ?? "1.0.0",
    changelog: normalizeChangelog(data.body, version),
    builds: [
      {
        target: "windows-x86_64",
        format: "vst3",
        url: downloadUrl,
        size_bytes: sizeBytes,
        sha256,
        // `archive_root` adalah properti plugin, bukan properti rilis.
        // Menebaknya dari nama file akan salah begitu nama repo berbeda dari
        // nama bundle, jadi ia dipertahankan dari rilis sebelumnya kalau ada.
        archive_root: previousBuild?.archive_root ?? `${plugin.name}.vst3`,
        install_kind: "vst3_bundle",
        requires_vc_redist: previousBuild?.requires_vc_redist ?? true,
      },
    ],
  };

  if (plugin.latest) {
    plugin.history = [plugin.latest, ...(plugin.history ?? [])].slice(0, HISTORY_LIMIT);
  }
  plugin.latest = newRelease;

  // README dan logo disegarkan setiap rilis: keduanya berubah seiring plugin
  // berkembang, dan yang ditampilkan launcher harus versi terbaru.
  try {
    const readme = await fetchReadme(repo);
    if (readme) plugin.readme = readme;
  } catch (e) {
    console.warn(`  README ${repo} tidak terambil: ${e.message}`);
  }
  try {
    const logo = await findLogoUrl(repo, data.tag_name ?? tag);
    if (logo) plugin.icon_url = logo;
  } catch (e) {
    console.warn(`  logo ${repo} tidak terambil: ${e.message}`);
  }

  await writeFile(path, `${JSON.stringify(plugin, null, 2)}\n`);

  return {
    outcome: created ? Outcome.Created : Outcome.Updated,
    version,
    sha256,
    sizeBytes,
    archiveRoot: newRelease.builds[0].archive_root,
  };
}
