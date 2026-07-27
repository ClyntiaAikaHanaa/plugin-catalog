#!/usr/bin/env node
//
// Validasi katalog terhadap JSON Schema **dan** aturan yang tidak dapat
// diekspresikan schema (PRD §10.4).
//
// Ini gerbang yang tidak boleh dilewati: kalau validasi gagal, katalog tidak
// di-deploy. Mendorong katalog rusak ke semua pengguna jauh lebih mahal
// daripada satu build merah.

import { join } from "node:path";

// Entry point 2020-12, bukan `ajv` biasa — default export Ajv adalah draft-07
// dan akan menolak `$schema` kita dengan "no schema with key or ref".
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  ROOT,
  assertAllowedUrl,
  compareSemver,
  fail,
  ok,
  readJson,
  readPluginFiles,
} from "./lib.mjs";

const schema = await readJson(join(ROOT, "schema", "catalog.schema.json"));
const launcher = await readJson(join(ROOT, "src", "launcher.json"));
const dawProcesses = await readJson(join(ROOT, "src", "daw-processes.json"));
const categories = await readJson(join(ROOT, "src", "categories.json"));
const pluginFiles = await readPluginFiles();

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const candidate = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  catalog_ttl_seconds: 21600,
  launcher,
  daw_processes: dawProcesses,
  categories,
  plugins: pluginFiles.map((p) => p.data),
};

let failures = 0;
const reject = (message) => {
  failures += 1;
  fail(message);
};

// ── Schema ───────────────────────────────────────────────────────────────
if (!validate(candidate)) {
  for (const error of validate.errors ?? []) {
    reject(`schema ${error.instancePath || "/"} ${error.message}`);
  }
} else {
  ok("schema");
}

// ── Aturan §10.4 yang tidak dapat diekspresikan schema ───────────────────

// 1. URL harus di allowlist host (dicek juga oleh launcher, §11.6).
for (const { file, data } of pluginFiles) {
  const releases = [data.latest, ...(data.history ?? [])];
  for (const release of releases) {
    for (const build of release?.builds ?? []) {
      if (build.url === null) continue; // sah: plugin berbayar v2 (§20.3)
      try {
        assertAllowedUrl(build.url, `${file} ${release.version}`);
      } catch (e) {
        reject(e.message);
      }
    }
  }
  for (const url of [data.icon_url, data.homepage_url, data.source_url, ...(data.screenshots ?? [])]) {
    if (!url) continue;
    try {
      assertAllowedUrl(url, `${file} aset`);
    } catch (e) {
      reject(e.message);
    }
  }
}

// 4. `id` unik dan cocok dengan nama filenya.
//
// `id` adalah kunci primer di database pengguna dan tidak boleh pernah berubah
// setelah dirilis. Mengikatnya ke nama file membuat perubahan tidak sengaja
// muncul sebagai rename yang terlihat di diff.
const seen = new Map();
for (const { file, data } of pluginFiles) {
  const expected = `${data.id}.json`;
  if (file !== expected) {
    reject(`${file}: nama file harus ${expected}`);
  }
  if (seen.has(data.id)) {
    reject(`id duplikat "${data.id}" di ${file} dan ${seen.get(data.id)}`);
  }
  seen.set(data.id, file);
}

// Kategori harus terdaftar.
const categoryIds = new Set(categories.map((c) => c.id));
for (const { file, data } of pluginFiles) {
  if (!categoryIds.has(data.category)) {
    reject(`${file}: kategori "${data.category}" tidak ada di categories.json`);
  }
}

// 5. Versi `latest` harus lebih tinggi daripada semua versi di `history`.
for (const { file, data } of pluginFiles) {
  for (const old of data.history ?? []) {
    try {
      if (compareSemver(old.version, data.latest.version) >= 0) {
        reject(
          `${file}: history ${old.version} tidak lebih rendah dari latest ${data.latest.version}`
        );
      }
    } catch (e) {
      reject(`${file}: ${e.message}`);
    }
  }
  // Versi di history harus unik.
  const versions = (data.history ?? []).map((r) => r.version);
  if (new Set(versions).size !== versions.length) {
    reject(`${file}: ada versi duplikat di history`);
  }
}

// 6. Setiap `min_launcher_version` harus ≤ `launcher.latest_version`.
for (const { file, data } of pluginFiles) {
  for (const release of [data.latest, ...(data.history ?? [])]) {
    const min = release?.min_launcher_version;
    if (!min) continue;
    try {
      if (compareSemver(min, launcher.latest_version) > 0) {
        reject(
          `${file} ${release.version}: min_launcher_version ${min} melebihi launcher ${launcher.latest_version}`
        );
      }
    } catch (e) {
      reject(`${file}: ${e.message}`);
    }
  }
}

// Konsistensi `install_kind` ↔ `archive_root`. Salah di sini berarti launcher
// mengekstrak arsip lalu menolaknya karena entri akar tidak ditemukan — gagal
// setelah unduhan selesai, yang adalah pengalaman terburuk.
for (const { file, data } of pluginFiles) {
  for (const release of [data.latest, ...(data.history ?? [])]) {
    for (const build of release?.builds ?? []) {
      const expectedSuffix = build.install_kind === "vst3_bundle" ? ".vst3" : ".clap";
      if (!build.archive_root.toLowerCase().endsWith(expectedSuffix)) {
        reject(
          `${file} ${release.version}: archive_root "${build.archive_root}" tidak cocok dengan install_kind ${build.install_kind}`
        );
      }
    }
  }
}

// Rilis major harus ditandai breaking (§15.1). "Kalau ragu, tandai breaking."
for (const { file, data } of pluginFiles) {
  const [major] = data.latest.version.split(".").map(Number);
  const previous = (data.history ?? [])[0];
  if (previous) {
    const [previousMajor] = previous.version.split(".").map(Number);
    if (major > previousMajor && !data.latest.breaking) {
      reject(
        `${file}: ${previous.version} → ${data.latest.version} menaikkan major tapi tidak ditandai breaking`
      );
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} masalah — katalog TIDAK di-deploy.`);
  process.exit(1);
}

ok(`${pluginFiles.length} plugin tervalidasi`);
