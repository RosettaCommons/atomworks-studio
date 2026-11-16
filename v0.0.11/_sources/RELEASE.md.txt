# Releasing Studio

Studio follows the tag-and-artifact approach used by
[AtomWorks](https://github.com/RosettaCommons/atomworks/blob/production/.github/workflows/release_and_docs.yaml)
and [tmol](https://github.com/uw-ipd/tmol/blob/master/.github/workflows/publish.yml):
build once, test the installed packages, then publish those artifacts in a separate job.
Documentation builds separately, as in RFD4, and is included in every release.

The editor keeps `atomworks[ml]` pinned to the release in `dependencies.toml`, including Torch. Native PyMOL is an optional host application; inference is outside Studio.

## One-time setup

The publishing repository is `RosettaCommons/atomworks-studio`.
Development history stays in the private `baker-laboratory/atomworks-studio-dev` repository.
`release/rosettacommons` from the development repository is mirrored there commit for commit
(see [Promote development to RosettaCommons](#promote-development-to-rosettacommons)).
Repository visibility is managed separately from releases.

Create a GitHub environment named `pypi`. Register a
[PyPI Trusted Publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)
for `atomworks-studio`, using owner `RosettaCommons`, repository
`atomworks-studio`, workflow `release.yaml`, and environment `pypi`.

No PyPI API token or private dependency token is needed. CI uses the bundled,
hash-verified scientific definitions.

Optional destinations:

- Set `VSCE_PAT` to publish the already-built VSIX to the VS Code Marketplace.
  The VSIX is always attached to the GitHub release.
- Enable GitHub Pages from `gh-pages` and set the repository variable
  `STUDIO_PUBLISH_DOCS=true` to publish docs under `/v<version>/`.
  Earlier versions are retained. The documentation archive is always attached
  to the GitHub release, even when Pages is disabled.

## Release downloads

Each release attaches the wheel and source archive, the VSIX, the documentation
archive, `atomworks-studio-web.tar.gz`, and `SHA256SUMS`.

`atomworks-studio-web.tar.gz` is the built browser application on its own, for hosts
that embed Studio through `window.atomworksStudio` (see
[Embedding Studio in a page](INTEGRATIONS.md#embedding-studio-in-a-page)) and serve
the files themselves rather than installing the wheel. It is extracted from the
wheel that was just verified, so the two are identical by construction.

## Cut a release

1. Update `VERSION` and the Python, JavaScript, and Rust package versions.
   Run `python scripts/verify_distribution.py` and update the lockfiles.
2. Merge the reviewed change after CI passes.
3. Push the matching `v<version>` tag. A manual workflow run must also select
   that tag; branch refs and the rolling `vscode-latest` tag are rejected.

The workflow runs the CI suite for the tagged commit (currently without the browser acceptance job; see the comment in `release.yaml`). The package job
builds the wheel and source archive, rejects missing or stale artifacts,
checks package metadata with Twine, and installs the built Studio wheel in a
fresh environment outside the checkout. It exercises CLI startup, bundled
browser/WASM assets, CIF loading, protonation, selections, export, and Undo.
CI also checks the native PyMOL plugin, browser workflows and docs.

Only after those jobs succeed does the `publish` job upload the Python
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
uv build --out-dir dist
uv run scripts/check_distribution_assets.py dist
uv run --no-project --with twine python -m twine check --strict dist/*
```

The RFD4 adapter bundles the definition files listed with SHA-256 hashes in
`providers/rfd4/UPSTREAM.toml`. They come from the pinned
[RosettaCommons RFD4 repository](https://github.com/RosettaCommons/RFD4-Proteina),
including its BSD license. The build verifies every file; wheel and source
archive checks verify the bundled copies. Users need no checkout to annotate.

## Promote development to RosettaCommons

Work in `atomworks-studio-dev` first. `release/rosettacommons` is the clean branch
that `RosettaCommons/atomworks-studio` mirrors: the same commits, never rewritten.
It equals `main` plus the committed browser bundle and guide, so `pip install`
from the public repository needs no Node, Rust or Sphinx.

1. Merge reviewed changes to `main` (use merge commits, not squashes, so the release branch can merge `main` cleanly).
2. `make build`, then `scripts/make_release_branch.sh`. It merges `origin/main` into
   `release/rosettacommons` and commits the fresh bundle and guide.
3. Push the branch to `origin`, wait for its **CI** workflow to pass, including
   package, Docker Space, browser, and documentation checks. Never substitute an
   older green run for the release commit.
4. Push that same branch to the RosettaCommons remote as `main`
   (`git push rosettacommons release/rosettacommons:main`), and wait for its **CI** and
   **VS Code extension** workflows before tagging a PyPI release there.

The release branch deletes the two build-output lines from `.gitignore`; keep edits to
that file away from them on `main` to avoid merge conflicts. Do not rewrite published release tags.
