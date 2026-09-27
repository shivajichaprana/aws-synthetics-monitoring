#!/usr/bin/env bash
#
# Packages the canary scripts into the bundle the Synthetics service expects.
#
# The service does not read a flat directory of scripts. A Node.js canary is a
# zip whose contents sit under `nodejs/node_modules/`, and a handler of
# `api-canary.handler` means the service loads `nodejs/node_modules/api-canary.js`
# and calls its exported `handler`. Anything laid out differently fails at the
# first run with a module-not-found error that says nothing about the layout.
#
# Shared helpers keep their relative position, so `require('./lib/config')`
# resolves identically here and in the bundle. That is the property that makes
# the helpers testable without the runtime.
#
# The result is written to `dist/` and is what `canary_code.zip_path` points at.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${SCRIPT_DIR}/dist}"
BUNDLE_NAME="${BUNDLE_NAME:-canaries.zip}"
STAGING_DIR=""

# The staging directory is removed on every exit path, including a failure
# part-way through, so a later run never picks up a half-built tree.
cleanup() {
  if [[ -n "${STAGING_DIR}" && -d "${STAGING_DIR}" ]]; then
    rm -rf -- "${STAGING_DIR}"
  fi
}
trap cleanup EXIT

log() {
  printf '%s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v zip >/dev/null 2>&1 || die "zip is not installed; it is required to build the bundle."
command -v node >/dev/null 2>&1 || die "node is not installed; it is required to syntax-check the scripts."

# Every canary script, by convention: a .js file at the top of this directory.
# Helpers live in lib/ and are copied wholesale, so adding one needs no change
# here.
mapfile -t SCRIPTS < <(find "${SCRIPT_DIR}" -maxdepth 1 -name '*.js' -type f -printf '%f\n' | sort)
[[ ${#SCRIPTS[@]} -gt 0 ]] || die "no canary scripts found in ${SCRIPT_DIR}"

log "Checking syntax of ${#SCRIPTS[@]} canary script(s) and the shared helpers."
while IFS= read -r -d '' file; do
  node --check "${file}" || die "syntax error in ${file#"${SCRIPT_DIR}/"}"
done < <(find "${SCRIPT_DIR}" -name '*.js' -type f -not -path '*/dist/*' -not -path '*/node_modules/*' -print0)

STAGING_DIR="$(mktemp -d)"
BUNDLE_ROOT="${STAGING_DIR}/nodejs/node_modules"
mkdir -p "${BUNDLE_ROOT}"

for script in "${SCRIPTS[@]}"; do
  cp -- "${SCRIPT_DIR}/${script}" "${BUNDLE_ROOT}/${script}"
done

if [[ -d "${SCRIPT_DIR}/lib" ]]; then
  cp -R -- "${SCRIPT_DIR}/lib" "${BUNDLE_ROOT}/lib"
fi

mkdir -p "${OUTPUT_DIR}"
BUNDLE_PATH="${OUTPUT_DIR}/${BUNDLE_NAME}"
rm -f -- "${BUNDLE_PATH}"

# -X drops extra file attributes and -r recurses. Dropping the attributes
# keeps the archive byte-identical between machines for unchanged sources,
# which is what stops a rebuild from showing up as a change to apply.
( cd "${STAGING_DIR}" && zip -q -r -X "${BUNDLE_PATH}" nodejs )

BUNDLE_SIZE="$(wc -c < "${BUNDLE_PATH}" | tr -d ' ')"
log "Built ${BUNDLE_PATH} (${BUNDLE_SIZE} bytes) containing:"
zip -sf "${BUNDLE_PATH}" >&2

# The service rejects a bundle over 10 MB uploaded inline. Catching it here is
# a one-line message instead of a failed apply.
MAX_INLINE_BYTES=$((10 * 1024 * 1024))
if (( BUNDLE_SIZE > MAX_INLINE_BYTES )); then
  die "bundle is ${BUNDLE_SIZE} bytes, over the ${MAX_INLINE_BYTES}-byte inline limit; upload it to S3 and use canary_code.s3_bucket instead."
fi

printf '%s\n' "${BUNDLE_PATH}"
