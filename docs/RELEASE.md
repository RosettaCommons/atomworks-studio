# Releasing Studio

Studio follows the tag-and-artifact approach used by
[AtomWorks](https://github.com/RosettaCommons/atomworks/blob/production/.github/workflows/release_and_docs.yaml)
and [tmol](https://github.com/uw-ipd/tmol/blob/master/.github/workflows/publish.yml):
build once, test the installed packages, then publish those artifacts in a separate job.
Documentation builds separately, as in RFD4, and is included in every release.

The editor keeps `atomworks[ml]==3.0.1`, including Torch. Native PyMOL is an optional host application; inference is outside Studio.

## One-time setup

The publishing repository is `RosettaCommons/atomworks-studio`.
Development history stays in the private `baker-laboratory/atomworks-studio-dev` repository.
Only reviewed source snapshots are copied to RosettaCommons; its Git history starts
with one initial commit. Repository visibility is managed separately from releases.

Create a GitHub environment named `pypi`. Register a
[PyPI Trusted Publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)
for each distribution below, using owner `RosettaCommons`, repository
`atomworks-studio`, workflow `release.yaml`, and environment `pypi`:

- `atomworks-studio`
- `atomworks-studio-editing`
- `atomworks-studio-pymol`
- `atomworks-annotation-studio-rfd4`

No PyPI API token or private dependency token is needed. CI uses the bundled,
hash-verified scientific definitions.

Optional destinations:

- Set `VSCE_PAT` to publish the already-built VSIX to the VS Code Marketplace.
  The VSIX is always attached to the GitHub release.
- Enable GitHub Pages from `gh-pages` and set the repository variable
  `STUDIO_PUBLISH_DOCS=true` to publish docs under `/v<version>/`.
  Earlier versions are retained. The documentation archive is always attached
  to the GitHub release, even when Pages is disabled.

## Cut a release

1. Update `VERSION` and the Python, JavaScript, and Rust package versions.
   Run `python scripts/verify_distribution.py` and update the lockfiles.
2. Merge the reviewed change after CI passes.
3. Push the matching `v<version>` tag. A manual workflow run must also select
   that tag; branch refs and the rolling `vscode-latest` tag are rejected.

The workflow runs the full CI suite for the tagged commit. The package job
builds all four wheels and source archives, rejects missing or stale artifacts,
checks package metadata with Twine, and installs the built Studio wheel in a
fresh environment outside the checkout. It exercises CLI startup, bundled
browser/WASM assets, CIF loading, protonation, selections, export, and Undo.
CI also checks the native PyMOL plugin, browser workflows and docs.

Only after those jobs succeed does the `publish` job upload the eight Python
artifacts to PyPI through OIDC. The GitHub release then receives the same
packages, VSIX, docs archive, checksums, and build provenance.

If an upload fails partway through, rerun the failed jobs while the build
artifacts remain available. PyPI uploads skip files already present. Published
versions are immutable: use a new version and tag for changed code.

For local builds, start with an empty output directory so the artifact check
can catch stale packages:

```bash
pnpm build
make docs
uv build --all-packages --out-dir dist
uv run scripts/check_distribution_assets.py dist
uv run --no-project --with twine python -m twine check --strict dist/*
```

The RFD4 adapter bundles the definition files listed with SHA-256 hashes in
`providers/rfd4/UPSTREAM.toml`. They come from the pinned
[RosettaCommons RFD4 repository](https://github.com/RosettaCommons/RFD4-Proteina),
including its BSD license. The build verifies every file; wheel and source
archive checks verify the bundled copies. Users need no checkout to annotate.

## Promote development to RosettaCommons

Work in `atomworks-studio-dev` first. Merge reviewed changes to `main`, then
fast-forward `release/rosettacommons` to that exact commit. Wait for its **CI**
workflow to pass, including package, Docker Space, browser, and documentation
checks. Never substitute an older green run for the release commit.

Copy only that branch's tracked files into a clean RosettaCommons checkout and
commit them there. Compare the two `HEAD^{tree}` hashes before pushing; they
must match. Keep the RosettaCommons commit history linear and do not rewrite
published release tags. After pushing, wait for its **CI** and **VS Code
extension** workflows before tagging a PyPI release.
