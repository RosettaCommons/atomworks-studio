SHELL := /usr/bin/env bash
.DEFAULT_GOAL := test

.PHONY: bootstrap format lint typecheck test build run accept-local

bootstrap:
	bash scripts/build_patinae_viewer.sh
	corepack enable
	pnpm install --frozen-lockfile
	uv sync --all-packages --all-extras --all-groups
	rustup target add wasm32-unknown-unknown

format:
	uv run ruff format packages providers scripts tests
	cargo fmt --all
	pnpm --dir packages/web exec tsc --noEmit

lint:
	uv run ruff check packages providers scripts tests
	cargo clippy --workspace --all-targets -- -D warnings
	bash -n run.sh scripts/*.sh

typecheck:
	bash scripts/generate_api_types.sh
	pnpm typecheck

test:
	cargo test --workspace --locked
	uv run python scripts/run_pytest.py -q
	pnpm test

build: docs
	pnpm build
	uv build --all-packages
	cargo build --workspace --release --locked

run:
	bash run.sh

accept-local:
	bash scripts/accept_local.sh

.PHONY: docs
docs:
	rm -rf docs/_build/html
	uv run --no-project --with-requirements docs/requirements.txt sphinx-build -E -W --keep-going -b html -d docs/_build/doctrees docs docs/_build/html
