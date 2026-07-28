#!/usr/bin/env node
//
// Gabungkan `src/plugins/*.json` → `dist/catalog.json` (PRD §10.1).
//
// `catalog.json` adalah **artefak build**, tidak pernah diedit tangan. File
// besar yang diedit manual akan sering konflik dan mudah rusak; memisahkannya
// per plugin membuat diff bersih dan memungkinkan otomatisasi menulis hanya
// file yang berubah.

import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DIST,
  ROOT,
  isPublishable,
  ok,
  readJson,
  readLicenses,
  readPluginFiles,
} from "./lib.mjs";

const launcher = await readJson(join(ROOT, "src", "launcher.json"));
const dawProcesses = await readJson(join(ROOT, "src", "daw-processes.json"));
const categories = await readJson(join(ROOT, "src", "categories.json"));
const pluginFiles = await readPluginFiles();

// Plugin yang belum punya rilis tidak diterbitkan (lihat `isPublishable`).
const publishable = pluginFiles.filter((p) => isPublishable(p.data));
for (const { file } of pluginFiles.filter((p) => !isPublishable(p.data))) {
  console.log(`· ${file} belum punya rilis, tidak diterbitkan`);
}

const catalog = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  // TTL dikendalikan server, bukan hardcoded di client (§10.3) — justru supaya
  // dapat diperpendek saat dibutuhkan.
  //
  // 6 jam (default FR-1.4). Sempat diturunkan ke 5 menit selama katalog masih
  // sering berubah, tapi itu berarti setiap launcher yang terbuka menembak
  // GitHub Pages dua belas kali per jam.
  //
  // Konsekuensi yang perlu diingat: perbaikan katalog tidak langsung terlihat
  // pengguna sampai TTL habis. Tombol Refresh di aplikasi memaksa pengambilan
  // ulang, jadi itu jalan keluarnya saat menguji sesuatu.
  //
  // Nilai ini harus sama dengan yang di scripts/validate.mjs, yang memvalidasi
  // katalog kandidat sebelum diterbitkan.
  catalog_ttl_seconds: 21600,
  launcher,
  daw_processes: dawProcesses,
  categories,
  // Hanya lisensi yang benar-benar dipakai plugin yang diterbitkan, supaya
  // berkas lisensi yang tertinggal tidak ikut membebani setiap unduhan.
  licenses: Object.fromEntries(
    Object.entries(await readLicenses()).filter(([spdx]) =>
      publishable.some((p) => p.data.license === spdx)
    )
  ),
  plugins: publishable.map((p) => p.data),
};

await mkdir(DIST, { recursive: true });
await writeFile(join(DIST, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
await cp(join(ROOT, "schema", "catalog.schema.json"), join(DIST, "catalog.schema.json"));

// Manifest updater launcher disajikan dari domain yang sama dengan katalog,
// sehingga migrasi hosting memindahkan keduanya sekaligus (R4).
const launcherManifest = join(ROOT, "src", "launcher", "latest.json");
if (existsSync(launcherManifest)) {
  await mkdir(join(DIST, "launcher"), { recursive: true });
  await cp(launcherManifest, join(DIST, "launcher", "latest.json"));
}

const assets = join(ROOT, "assets");
if (existsSync(assets)) {
  await cp(assets, join(DIST, "assets"), { recursive: true });
}

ok(`dist/catalog.json — ${catalog.plugins.length} plugin`);
