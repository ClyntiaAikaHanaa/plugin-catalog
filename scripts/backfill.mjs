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

import { fetchReadme, findLogoUrl, pluginPath } from "./ingest.mjs";
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
  const tag = data.latest?.version ? `v${data.latest.version}` : "HEAD";

  const readme = await fetchReadme(repo).catch(() => "");
  const logo = await findLogoUrl(repo, tag).catch(() => null);

  console.log(
    `${dryRun ? "·" : "↑"} ${file} — readme ${readme.length} byte, logo ${logo ?? "tidak ada"}`
  );
  if (dryRun) continue;

  const current = JSON.parse(await readFile(pluginPath(data.id), "utf8"));
  if (readme) current.readme = readme;
  if (logo) current.icon_url = logo;
  await writeFile(pluginPath(data.id), `${JSON.stringify(current, null, 2)}\n`);
}
