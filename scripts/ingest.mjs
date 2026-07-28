// Logika ingest rilis, dipakai `fetch-release.mjs` (satu plugin, dipicu
// dispatch) dan `sync-repos.mjs` (semua plugin, dipicu jadwal).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  SRC_LICENSES,
  SRC_PLUGINS,
  assertAllowedUrl,
  compareSemver,
  fetchAndHash,
  licenseFileName,
  readArchiveRoot,
} from "./lib.mjs";

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

/// Kategori dikenali dari topic repo, mis. topic `reverb` → kategori `reverb`.
///
/// Ini satu-satunya metadata yang benar-benar butuh penilaian manusia, dan
/// topic adalah tempat paling murah untuk menyatakannya: satu klik di halaman
/// repo, terlihat oleh siapa pun, dan dapat diubah tanpa menyentuh katalog.
export const KNOWN_CATEGORIES = [
  "dynamics",
  "reverb",
  "eq",
  "modulation",
  "distortion",
  "utility",
];

function categoryFromTopics(topics) {
  return (topics ?? []).find((t) => KNOWN_CATEGORIES.includes(t)) ?? null;
}

/// Ambil judul, tagline, dan paragraf pembuka dari README.
///
/// Pola yang diandalkan — `# Judul`, lalu baris `**tagline**`, lalu paragraf —
/// adalah bentuk yang dipakai semua README plugin ini. Kalau sebuah README
/// tidak mengikutinya, field yang bersangkutan dibiarkan kosong dan diisi dari
/// sumber lain; tidak ada yang ditebak-tebak.
export function parseReadmeHeader(markdown) {
  const lines = (markdown ?? "").split(/\r?\n/);

  let title = null;
  let tagline = null;
  const paragraph = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    if (!title) {
      const h1 = /^#\s+(.+)$/.exec(line);
      if (h1) title = h1[1].trim();
      continue;
    }
    if (!tagline) {
      // `**Tagline**` atau `### Tagline` — keduanya dipakai di repo ini.
      const bold = /^\*\*(.+?)\*\*$/.exec(line);
      const h3 = /^#{2,4}\s+(.+)$/.exec(line);
      if (bold) tagline = bold[1].trim();
      else if (h3) tagline = h3[1].trim();
      else if (!line.startsWith("#")) paragraph.push(line);
      continue;
    }
    // Paragraf pembuka berhenti di heading berikutnya.
    if (line.startsWith("#")) break;
    paragraph.push(line);
  }

  return {
    title,
    tagline: tagline?.slice(0, 200) ?? null,
    description: paragraph.join(" ").slice(0, 2000) || null,
  };
}

/// Vendor dari `COMPANY_NAME` di CMakeLists — nama yang benar-benar tertanam
/// di plugin, bukan nama akun GitHub.
export async function vendorFromCMake(repo) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/CMakeLists.txt`, {
      headers: { "user-agent": "studio-hub-catalog-ci" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return /COMPANY_NAME\s+"([^"]+)"/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/// Buat file plugin baru dari metadata repo, README, dan CMakeLists.
///
/// `hidden` ditentukan oleh satu aturan: **sembunyikan kalau ada yang ditebak.**
/// Kategori adalah satu-satunya field yang tidak dapat diturunkan dari isi
/// repo, jadi tanpa topic kategori, plugin lahir tersembunyi. Dengan topic itu,
/// semuanya berasal dari sumber yang bisa diperiksa dan ia langsung terbit.
export async function newPluginStub(repo, pluginId, readme) {
  const header = parseReadmeHeader(readme);
  const category = categoryFromTopics(repo.topics);
  const vendor = (await vendorFromCMake(repo.full_name)) ?? repo.owner?.login ?? "Unknown";

  return {
    id: pluginId,
    name: header.title ?? repo.name,
    vendor,
    category: category ?? "utility",
    tagline: (header.tagline ?? repo.description ?? repo.name).slice(0, 200),
    tagline_i18n: {},
    description: header.description ?? repo.description ?? "",
    description_i18n: {},
    homepage_url: repo.homepage?.startsWith("https://") ? repo.homepage : repo.html_url,
    source_url: repo.html_url,
    license: repo.license?.spdx_id ?? null,
    hidden: category === null,
    deprecated: repo.archived ?? false,
    deprecation_notice: null,
    commercial: { model: "free", requires_license: false, purchase_url: null },
    user_data: { preset_paths: [], config_paths: [] },
    requirements: { os_min_build: 17763, cpu_features: ["sse2"] },
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
  return sanitizeReadme(raw, repo);
}

/// Ubah `<img src="...">` menjadi gambar bermarkdown berURL absolut.
///
/// Screenshot di README ditulis sebagai HTML dengan path relatif terhadap repo.
/// Kalau tag HTML-nya dibuang mentah-mentah, yang tersisa hanya keterangannya —
/// pengguna melihat judul "Distortion Mode" tanpa gambar apa pun di bawahnya.
function absolutizeImages(markdown, repo, ref) {
  const base = `https://raw.githubusercontent.com/${repo}/${ref}/`;

  const toAbsolute = (src) => {
    if (/^https?:\/\//i.test(src)) return src;
    return base + src.replace(/^\.?\//, "");
  };

  return (
    markdown
      // HTML: <img src="..." alt="..."> dalam urutan atribut apa pun.
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        if (!src) return "";
        const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
        return `\n![${alt}](${toAbsolute(src)})\n`;
      })
      // Markdown dengan path relatif.
      .replace(/!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g, (_m, alt, src) => {
        return `![${alt}](${toAbsolute(src)})`;
      })
  );
}

/// Buang apa yang tidak dapat dirender launcher, sisakan prosanya.
///
/// Launcher merender Markdown lewat allowlist sempit: tidak ada HTML mentah,
/// tidak ada gambar, tidak ada link (PRD §14.5). Membersihkannya di sini —
/// sekali, di CI — lebih baik daripada menampilkan `<div align="center">`
/// sebagai teks di setiap mesin pengguna.
export function sanitizeReadme(markdown, repo, ref = "HEAD") {
  return (
    markdown
      // Komentar HTML dulu, supaya <img> di dalamnya tidak ikut terangkat.
      .replace(/<!--[\s\S]*?-->/g, "")
      // Gambar diselamatkan sebelum tag HTML dibuang.
      .replace(/<img\b[^>]*>/gi, (tag) => absolutizeImages(tag, repo, ref))
      // Sisa tag HTML: <div align>, <p>, <br>, dan sebagainya.
      .replace(/<\/?[a-z][^>]*>/gi, "")
      // Path gambar relatif menjadi absolut.
      .replace(/!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g, (m, alt, src) => {
        if (/^https?:\/\//i.test(src)) return `![${alt}](${src})`;
        return `![${alt}](https://raw.githubusercontent.com/${repo}/${ref}/${src.replace(/^\.?\//, "")})`;
      })
      // Badge shields.io: hiasan yang tidak menjelaskan apa pun tentang plugin,
      // dan host-nya di luar allowlist sehingga tidak akan pernah termuat.
      .replace(/!\[[^\]]*\]\(https?:\/\/img\.shields\.io[^)]*\)/g, "")
      // Link biasa dipertahankan teksnya saja (launcher tidak merender link).
      .replace(/(^|[^!])\[([^\]]+)\]\([^)]*\)/g, "$1$2")
      // Rapikan sisa baris kosong berlebih setelah penghapusan di atas.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 80_000)
  );
}

/// Ambil teks lisensi repo.
///
/// Dibakukan ke katalog seperti README: dialog instalasi harus menampilkannya
/// sebelum pengguna menyetujui, dan itu tidak boleh bergantung pada jaringan
/// yang mungkin sedang mati.
export async function fetchLicense(repo) {
  const data = await githubJson(`https://api.github.com/repos/${repo}/license`);
  if (!data?.content) return null;
  const text = Buffer.from(data.content, "base64").toString("utf8");
  return {
    spdx: data.license?.spdx_id ?? null,
    // Teks lisensi dirender apa adanya di blok bergulir, jadi tidak perlu
    // dibersihkan seperti README — justru mengubahnya akan salah.
    text: text.slice(0, 120_000),
  };
}

/// Simpan teks lisensi ke `src/licenses/<spdx>.txt`, satu berkas per lisensi.
///
/// Ditulis hanya kalau belum ada: dua plugin GPL-3.0 menghasilkan teks yang
/// identik, dan menulis ulang berkas yang sama setiap rilis hanya menghasilkan
/// diff kosong yang mengaburkan riwayat.
export async function storeLicense(spdx, text) {
  if (!spdx || !text) return false;
  await mkdir(SRC_LICENSES, { recursive: true });
  const path = join(SRC_LICENSES, licenseFileName(spdx));
  if (existsSync(path)) return false;
  await writeFile(path, text);
  return true;
}

/// Cari logo di repo untuk dipakai sebagai thumbnail.
///
/// `ref` sengaja menunjuk branch utama, **bukan** tag rilis. Logo adalah
/// identitas visual yang berlaku sekarang, bukan artefak yang harus cocok
/// dengan versi tertentu — menyematkannya ke tag berarti logo yang kamu
/// perbarui setelah merilis tidak akan pernah muncul. Tidak ada jaminan
/// integritas yang hilang karenanya: berkasnya tetap divalidasi magic bytes
/// oleh launcher, dan ia hanya dirender sebagai gambar.
export async function findLogoUrl(repo, ref = "HEAD") {
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
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${encodeURI(path)}`;
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

  // README diambil lebih dulu: entri baru menurunkan judul, tagline, dan
  // paragraf pembukanya dari sana.
  const readme = await fetchReadme(repo).catch(() => "");

  if (existsSync(path)) {
    plugin = JSON.parse(await readFile(path, "utf8"));
  } else {
    const meta = repoMeta ?? (await githubJson(`https://api.github.com/repos/${repo}`));
    if (!meta) throw new Error(`repo ${repo} tidak ditemukan`);
    plugin = await newPluginStub(meta, pluginId, readme);
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
  const { sha256, sizeBytes, buffer } = await fetchAndHash(downloadUrl);
  if (asset.size && asset.size !== sizeBytes) {
    throw new Error(
      `${repo}: ukuran asset (${asset.size}) berbeda dari yang diunduh (${sizeBytes})`
    );
  }

  // `archive_root` DIBACA dari arsipnya, tidak ditebak dari nama plugin.
  // Tebakan yang salah lolos setiap pemeriksaan di sini dan baru gagal di
  // mesin pengguna, setelah unduhan selesai — mode kegagalan termahal di
  // seluruh alur ini.
  let archiveRoot;
  try {
    archiveRoot = readArchiveRoot(buffer);
  } catch (e) {
    throw new Error(`${repo} ${version}: arsip ditolak — ${e.message}`);
  }

  const previousBuild = plugin.latest?.builds?.find((b) => b.target === "windows-x86_64");
  if (previousBuild && previousBuild.archive_root !== archiveRoot) {
    // Nama bundle berubah antar rilis berarti plugin lama tidak akan tertimpa
    // saat update — pengguna berakhir dengan dua salinan di folder VST3.
    console.warn(
      `  ⚠ ${pluginId}: nama bundle berubah dari "${previousBuild.archive_root}" ` +
        `menjadi "${archiveRoot}". Pengguna yang memperbarui akan punya dua salinan.`
    );
  }

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
        archive_root: archiveRoot,
        install_kind: "vst3_bundle",
        requires_vc_redist: previousBuild?.requires_vc_redist ?? true,
      },
    ],
  };

  if (plugin.latest) {
    plugin.history = [plugin.latest, ...(plugin.history ?? [])].slice(0, HISTORY_LIMIT);
  }
  plugin.latest = newRelease;

  // Git tidak melacak direktori kosong, jadi setelah seluruh entri dihapus,
  // `src/plugins` tidak ada sama sekali di checkout bersih. Membuatnya di sini
  // membuat regenerasi penuh dari nol berhasil — dan itu justru satu-satunya
  // keadaan di mana sync menjadi satu-satunya jalan memulihkan katalog.
  await mkdir(SRC_PLUGINS, { recursive: true });

  // README dan logo disegarkan setiap rilis: keduanya berubah seiring plugin
  // berkembang, dan yang ditampilkan launcher harus versi terbaru.
  if (readme) plugin.readme = readme;
  try {
    const license = await fetchLicense(repo);
    if (license?.spdx) {
      plugin.license = license.spdx;
      await storeLicense(license.spdx, license.text);
    }
  } catch (e) {
    console.warn(`  lisensi ${repo} tidak terambil: ${e.message}`);
  }
  try {
    const logo = await findLogoUrl(repo);
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
    archiveRoot,
    hidden: plugin.hidden === true,
    category: plugin.category,
  };
}
