// Perkakas bersama untuk script katalog.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_PLUGINS = join(ROOT, "src", "plugins");
/// Teks lisensi disimpan sekali per SPDX id, bukan per plugin.
///
/// GPL-3.0 sendiri 35 KB. Menyalinnya ke setiap entri plugin membuat katalog
/// tumbuh linear terhadap jumlah plugin padahal isinya identik — dan katalog
/// itu diunduh ulang setiap kali TTL habis.
export const SRC_LICENSES = join(ROOT, "src", "licenses");
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
  // Katalog tanpa satu pun entri adalah keadaan yang SAH: repo yang baru
  // dibuat, atau semua entri sengaja dikosongkan untuk dibangun ulang sync.
  // Melempar di sini membuat CI gagal sebelum sync sempat mengisi apa pun —
  // yaitu tepat saat perkakas ini paling dibutuhkan.
  let names;
  try {
    names = (await readdir(SRC_PLUGINS)).filter((n) => n.endsWith(".json")).sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
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

/// Baca seluruh teks lisensi menjadi peta `SPDX id → teks`.
export async function readLicenses() {
  const out = {};
  let names;
  try {
    names = await readdir(SRC_LICENSES);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => n.endsWith(".txt")).sort()) {
    out[name.replace(/\.txt$/, "")] = await readFile(join(SRC_LICENSES, name), "utf8");
  }
  return out;
}

/// Nama berkas lisensi dari SPDX id, dibersihkan agar aman sebagai nama berkas.
export function licenseFileName(spdx) {
  return `${String(spdx).replace(/[^A-Za-z0-9.+-]/g, "_")}.txt`;
}

/// True jika plugin layak masuk `catalog.json`.
///
/// Plugin yang terdaftar tapi belum punya rilis adalah keadaan yang sah: kamu
/// menandai repo dengan topic, mengisi metadatanya, lalu rilis pertamanya
/// menyusul. Yang tidak boleh adalah entri seperti itu bocor ke katalog —
/// launcher menuntut `latest` ada, dan entri tanpa rilis akan dilewatinya
/// sebagai data rusak. Lebih baik tidak diterbitkan sejak awal.
export function isPublishable(plugin) {
  return Boolean(plugin?.latest?.builds?.length);
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
  return { sha256: sha256(buffer), sizeBytes: buffer.length, buffer };
}

/// Baca nama entri dari direktori pusat sebuah ZIP.
///
/// Ditulis manual alih-alih menambah dependensi: satu-satunya yang dibutuhkan
/// adalah daftar nama, dan setiap paket baru di CI adalah permukaan
/// supply-chain baru (semangat yang sama dengan T11 di PRD).
export function readZipEntryNames(buffer) {
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;

  // EOCD ada di akhir berkas, didahului komentar yang panjangnya maksimum
  // 65535 byte. Dicari mundur dari ujung.
  let eocd = -1;
  const from = Math.max(0, buffer.length - (0xffff + 22));
  for (let i = buffer.length - 22; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("bukan berkas ZIP yang valid (EOCD tidak ditemukan)");

  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);

  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(p) !== CDH_SIG) {
      throw new Error("direktori pusat ZIP rusak");
    }
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    names.push(buffer.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/// Entri akar sebuah arsip bundle — nama folder `.vst3` di dalamnya.
///
/// Melempar kalau arsipnya tidak berbentuk seperti bundle. Ini yang membuat
/// `archive_root` di katalog TIDAK MUNGKIN berbeda dari isi arsip; sebelumnya
/// ia ditebak dari nama plugin, dan tebakan yang salah baru ketahuan di mesin
/// pengguna setelah unduhan selesai.
export function readArchiveRoot(buffer) {
  const names = readZipEntryNames(buffer);

  for (const name of names) {
    if (name.includes("\\")) {
      throw new Error(
        `nama entri "${name}" memakai backslash; spesifikasi ZIP menetapkan "/". ` +
          "Arsip seperti ini dihasilkan Compress-Archive di Windows dan ditolak launcher."
      );
    }
  }

  const roots = [...new Set(names.map((n) => n.split("/")[0]).filter(Boolean))];
  if (roots.length !== 1) {
    throw new Error(
      `entri akar harus tepat satu, ditemukan: ${roots.join(", ") || "(tidak ada)"}`
    );
  }
  if (!roots[0].toLowerCase().endsWith(".vst3")) {
    throw new Error(`entri akar "${roots[0]}" bukan bundle .vst3`);
  }
  if (!names.some((n) => /Contents\/x86_64-win\/.+\.vst3$/i.test(n))) {
    throw new Error("tidak ada DLL di Contents/x86_64-win/ — bundle tidak lengkap");
  }
  return roots[0];
}

export function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

export function ok(message) {
  console.log(`✓ ${message}`);
}
