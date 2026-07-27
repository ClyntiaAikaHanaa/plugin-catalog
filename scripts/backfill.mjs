#!/usr/bin/env node
//
// Isi `readme` dan `icon_url` untuk plugin yang sudah ada di katalog.
//
// Dipakai sekali saat kedua field itu ditambahkan; rilis berikutnya mengisinya
// otomatis lewat `ingest.mjs`. Disimpan di repo karena hal serupa akan terjadi
// lagi setiap kali ada field baru yang diturunkan dari repo plugin.
//
// Pemakaian:
//   node scripts/backfill.mjs [--dry-run]

import { readFile, writeFile } from "node:fs/promises";

import { fetchLicense, fetchReadme, findLogoUrl, pluginPath, storeLicense } from "./ingest.mjs";
import { readPluginFiles } from "./lib.mjs";

const dryRun = process.argv.includes("--dry-run");
const plugins = await readPluginFiles();

for (const { file, data } of plugins) {
  const source = data.source_url ?? data.homepage_url;
  if (!source) {
    console.log(`· ${file} tidak punya source_url, dilewati`);
    continue;
  }
  const repo = new URL(source).pathname.replace(/^\/+|\/+$/g, "");

  const readme = await fetchReadme(repo).catch(() => "");
  const logo = await findLogoUrl(repo).catch(() => null);
  const license = await fetchLicense(repo).catch(() => null);

  console.log(
    `${dryRun ? "·" : "↑"} ${file} — readme ${readme.length} byte, ` +
      `lisensi ${license?.spdx ?? "?"} ${license?.text.length ?? 0} byte, ` +
      `logo ${logo ?? "tidak ada"}`
  );
  if (dryRun) continue;

  const current = JSON.parse(await readFile(pluginPath(data.id), "utf8"));
  if (readme) current.readme = readme;
  if (logo) current.icon_url = logo;
  if (license?.spdx) {
    current.license = license.spdx;
    await storeLicense(license.spdx, license.text);
  }
  // Peninggalan dari saat teks lisensi disalin ke setiap entri plugin.
  delete current.license_text;
  await writeFile(pluginPath(data.id), `${JSON.stringify(current, null, 2)}\n`);
}
