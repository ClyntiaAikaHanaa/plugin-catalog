#!/usr/bin/env node
//
// Pindai akun GitHub, temukan repo plugin, dan tarik rilis terbarunya.
//
// Ini menjawab kebutuhan "aku tidak mau mendaftarkan plugin satu per satu"
// tanpa melanggar ADR-1. Bedanya dengan launcher yang memanggil API langsung:
//
//   * berjalan di CI dengan token → limit 5.000 req/jam, bukan 60 per IP;
//   * berjalan sekali per jadwal, bukan sekali per pengguna per buka aplikasi;
//   * hasilnya tetap file statis yang di-cache CDN;
//   * hash tetap dihitung dari byte asli, jadi jaminan integritas tidak
//     melemah sedikit pun.
//
// Repo dipilih lewat **topic**, bukan tebakan dari nama. Ini yang menutup
// keberatan ADR-1 bahwa "repo non-plugin bocor ke daftar": kamu yang menandai
// mana yang plugin, dan menghapus topic-nya mengeluarkan repo itu lagi.
//
// Pemakaian:
//   node scripts/sync-repos.mjs --owner ClyntiaAikaHanaa [--dry-run]

import { Outcome, PLUGIN_TOPIC, deriveId, githubJson, ingestRelease } from "./ingest.mjs";

const args = parseArgs(process.argv.slice(2));
const owner = args.owner ?? process.env.GITHUB_REPOSITORY_OWNER;
const dryRun = args["dry-run"] === "true";

if (!owner) {
  console.error("--owner wajib diisi (atau set GITHUB_REPOSITORY_OWNER)");
  process.exit(2);
}

if (!process.env.GH_TOKEN) {
  // Tanpa token, 60 request/jam dibagi seluruh IP runner GitHub — praktis
  // selalu habis. Gagal di sini lebih jelas daripada gagal setengah jalan.
  console.error("GH_TOKEN tidak diset; pemindaian tanpa autentikasi akan kena rate limit");
  process.exit(2);
}

console.log(`Memindai repo ${owner} dengan topic "${PLUGIN_TOPIC}"…`);

const repos = await listPluginRepos(owner);
if (repos.length === 0) {
  console.log(
    `\nTidak ada repo yang bertopic "${PLUGIN_TOPIC}".\n` +
      `Tambahkan topic itu di halaman repo plugin (ikon roda gigi di sebelah About),\n` +
      `lalu jalankan workflow ini lagi.`
  );
  process.exit(0);
}

console.log(`Ditemukan ${repos.length} repo plugin.\n`);

let created = 0;
let updated = 0;
let skipped = 0;
let failed = 0;

for (const repo of repos) {
  const pluginId = deriveId(repo.name);
  const full = repo.full_name;

  try {
    const release = await githubJson(`https://api.github.com/repos/${full}/releases/latest`);
    if (!release) {
      console.log(`· ${full} — belum ada rilis, dilewati`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`· ${full} → ${pluginId} @ ${release.tag_name} (dry run)`);
      continue;
    }

    const result = await ingestRelease({
      pluginId,
      repo: full,
      tag: release.tag_name,
      release,
      repoMeta: repo,
      // Sinkronisasi terjadwal tidak dapat tahu apakah rilis ini breaking —
      // hanya kamu yang tahu. Rilis lewat tag push membawa flag itu di payload
      // dispatch; yang masuk lewat jalur ini selalu dianggap non-breaking dan
      // harus kamu koreksi manual kalau ternyata bukan.
      breaking: false,
    });

    switch (result.outcome) {
      case Outcome.Created:
        console.log(
          `+ ${full} → ${pluginId} ${result.version}\n` +
            `    BARU — file dibuat dengan hidden:true. Sunting kategori,\n` +
            `    user_data, dan requirements-nya, lalu set hidden:false.\n` +
            `    archive_root ditebak "${result.archiveRoot}" — pastikan itu\n` +
            `    benar-benar nama folder di dalam ZIP.`
        );
        created += 1;
        break;
      case Outcome.Updated:
        console.log(`↑ ${full} → ${pluginId} ${result.version}`);
        updated += 1;
        break;
      default:
        console.log(`· ${full} — ${result.reason}`);
        skipped += 1;
    }
  } catch (e) {
    // Satu repo bermasalah tidak boleh menggagalkan sinkronisasi sembilan
    // repo lain yang sehat.
    console.error(`✗ ${full} — ${e.message}`);
    failed += 1;
  }
}

console.log(
  `\n${created} baru, ${updated} diperbarui, ${skipped} dilewati, ${failed} gagal.`
);

if (created > 0) {
  console.log(
    `\nPlugin baru sengaja hidden. Ia tidak tampil di launcher sampai kamu\n` +
      `memeriksanya — menampilkan plugin dengan kategori asal tebak dan\n` +
      `archive_root yang belum terverifikasi lebih buruk daripada tidak\n` +
      `menampilkannya sama sekali.`
  );
}

// Gagal sebagian tetap dilaporkan sebagai kegagalan supaya kamu mendapat
// notifikasi, tapi perubahan yang berhasil tetap ditulis.
if (failed > 0) process.exit(1);

// ── Fungsi bantu ─────────────────────────────────────────────────────────

async function listPluginRepos(owner) {
  const found = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubJson(
      `https://api.github.com/users/${owner}/repos?per_page=100&page=${page}&type=owner`
    );
    if (!batch || batch.length === 0) break;

    for (const repo of batch) {
      if (repo.fork || repo.archived) continue;
      if ((repo.topics ?? []).includes(PLUGIN_TOPIC)) found.push(repo);
    }
    if (batch.length < 100) break;
  }
  return found;
}

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
