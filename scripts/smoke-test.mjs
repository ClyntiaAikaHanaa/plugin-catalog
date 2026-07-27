#!/usr/bin/env node
//
// Smoke test yang benar-benar mengunduh setiap URL di katalog dan memverifikasi
// hash-nya (mitigasi R10).
//
// Dijalankan terjadwal, bukan di setiap PR: ia memakai bandwidth nyata. Yang
// dideteksinya adalah kelas kegagalan yang tidak terlihat sampai pengguna
// pertama mencoba memasang — asset yang dihapus, tag yang dipindah, rilis yang
// diganti dengan build baru diam-diam.

import { join } from "node:path";

import { DIST, fetchAndHash, readJson } from "./lib.mjs";

const catalog = await readJson(join(DIST, "catalog.json"));

let checked = 0;
let failures = 0;

for (const plugin of catalog.plugins) {
  for (const release of [plugin.latest, ...(plugin.history ?? [])]) {
    for (const build of release.builds ?? []) {
      if (!build.url) continue;
      checked += 1;

      try {
        const { sha256, sizeBytes } = await fetchAndHash(build.url);
        if (sha256 !== build.sha256) {
          failures += 1;
          console.error(
            `✗ ${plugin.id} ${release.version}: hash berbeda\n` +
              `    katalog: ${build.sha256}\n` +
              `    aktual : ${sha256}`
          );
        } else if (sizeBytes !== build.size_bytes) {
          failures += 1;
          console.error(
            `✗ ${plugin.id} ${release.version}: ukuran berbeda (${build.size_bytes} vs ${sizeBytes})`
          );
        } else {
          console.log(`✓ ${plugin.id} ${release.version} ${build.target}`);
        }
      } catch (e) {
        failures += 1;
        console.error(`✗ ${plugin.id} ${release.version}: ${e.message}`);
      }
    }
  }
}

console.log(`\n${checked} artefak diperiksa, ${failures} bermasalah.`);
if (failures > 0) process.exit(1);
