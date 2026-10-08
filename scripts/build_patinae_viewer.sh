#!/usr/bin/env bash
set -euo pipefail
umask 022

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
metadata="${root}/vendor/patinae/UPSTREAM.toml"
rust_toolchain="$(awk -F ' = ' '$1 == "channel" { gsub(/^"|"$/, "", $2); print $2 }' "${root}/rust-toolchain.toml")"
cache_root="${ATOMWORKS_STUDIO_CACHE_DIR:-${HOME}/.cache/atomworks-studio}"
source_dir="${cache_root}/patinae"
artifact_dir="${root}/packages/web/vendor"

read_metadata() {
  awk -F ' = ' -v key="$1" '$1 == key { gsub(/^"|"$/, "", $2); print $2 }' "${metadata}"
}

repository="$(read_metadata repository)"
revision="$(read_metadata revision)"
package_name="$(read_metadata package)"
version="$(read_metadata version)"
artifact_sha256="$(read_metadata artifact_sha256)"
artifact="${artifact_dir}/patinae-viewer-${version}.tgz"
verify_artifact() {
  node - "${artifact}" "${artifact_sha256}" <<'JS'
const fs = require("node:fs");
const crypto = require("node:crypto");
const [path, expected] = process.argv.slice(2);
const actual = crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
if (actual !== expected) throw new Error(`Patinae checksum mismatch: ${actual}`);
JS
}
if [[ -f "${artifact}" && "${ATOMWORKS_STUDIO_REBUILD_PATINAE:-0}" != "1" ]]; then
  verify_artifact
  exit 0
fi

wasm_pack="${WASM_PACK:-$(command -v wasm-pack || true)}"
[[ -n "${wasm_pack}" ]] || {
  echo "Install wasm-pack 0.13.1 before rebuilding Patinae." >&2
  exit 1
}
[[ "$("${wasm_pack}" --version)" == "wasm-pack 0.13.1" ]] || {
  echo "Patinae requires wasm-pack 0.13.1 for reproducible output." >&2
  exit 1
}
if command -v wasm-opt >/dev/null 2>&1; then
  [[ "$(wasm-opt --version)" == "wasm-opt version 117 (version_117)" ]] || {
    echo "Remove wasm-opt from PATH or use Binaryen version 117 when rebuilding Patinae." >&2
    exit 1
  }
fi

mkdir -p "${cache_root}" "${artifact_dir}"
if [[ ! -d "${source_dir}/.git" ]]; then
  git clone --filter=blob:none "${repository}" "${source_dir}"
fi
if [[ -n "$(git -C "${source_dir}" status --porcelain)" ]]; then
  git -C "${source_dir}" stash push --include-untracked --message atomworks-studio-build-cleanup >/dev/null
fi
git -C "${source_dir}" fetch --quiet origin "${revision}"
git -C "${source_dir}" checkout --quiet -B atomworks-studio-build "${revision}"
git -C "${source_dir}" clean -ffdqx
git -C "${source_dir}" am --abort >/dev/null 2>&1 || true
git -C "${source_dir}" \
  -c user.name="AtomWorks Studio Build" \
  -c user.email="atomworks-studio-build@users.noreply.github.com" \
  am "${root}"/vendor/patinae/patches/*.patch

node - "${source_dir}/web/package.json" "${package_name}" "${version}" <<'JS'
const fs = require("node:fs");
const [path, name, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.name = name;
manifest.version = version;
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
JS
cat >>"${source_dir}/web/Cargo.toml" <<'TOML'

[package.metadata.wasm-pack.profile.release]
wasm-opt = ["-O", "--enable-bulk-memory", "--enable-nontrapping-float-to-int"]
TOML

(
  cd "${source_dir}/web"
  npm ci --ignore-scripts
  RUSTUP_TOOLCHAIN="${rust_toolchain}" SOURCE_DATE_EPOCH=0 CARGO_BUILD_JOBS=1 \
  RUSTFLAGS="-C codegen-units=1 --remap-path-prefix=${source_dir}=/src/patinae --remap-path-prefix=${CARGO_HOME:-${HOME}/.cargo}=/cargo" \
    "${wasm_pack}" build --target web --out-dir pkg
  ./node_modules/.bin/vite build
  ./node_modules/.bin/tsc --emitDeclarationOnly
  chmod -R u=rwX,go=rX LICENSE package.json dist
  pack_dir="$(mktemp -d)"
  npm pack --ignore-scripts --pack-destination "${pack_dir}" >/dev/null
  packed=("${pack_dir}"/*.tgz)
  [[ "${#packed[@]}" == 1 ]]
  mv "${packed[0]}" "${artifact}"
  rmdir "${pack_dir}"
)
verify_artifact
patches=("${root}"/vendor/patinae/patches/*.patch)
printf 'Built %s from %s plus %s patches\n' \
  "${artifact}" "${revision}" "${#patches[@]}"
