# dsh-browser-native — quality and npm release targets.
#
# Every recipe goes through pnpm (the version pinned in package.json >
# packageManager); npm is never invoked from here. Package name and version are
# read from package.json at parse time so they can never drift from the manifest.

SHELL := /bin/bash
.DEFAULT_GOAL := help

PNPM ?= pnpm
NAME := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")

.PHONY: help install typecheck test build verify pack publish publish-next publish-dry-run

help: ## Show this help (default target)
	@echo "$(NAME)@$(VERSION) — usage: make <target>"
	@echo
	@awk 'BEGIN {FS = ":.*## "}; /^[a-z][a-z-]*:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies from pnpm-lock.yaml (frozen)
	$(PNPM) install --frozen-lockfile

typecheck: ## Type-check src + tests without emitting files
	$(PNPM) run typecheck

test: ## Run the vitest suite once (no watch mode)
	$(PNPM) test

build: ## Compile src/ into dist/
	$(PNPM) run build

verify: typecheck test build ## Release gate: typecheck -> test -> build
	@echo "==> verify passed: $(NAME)@$(VERSION)"

pack: build ## Build and drop the npm tarball into dist/
	$(PNPM) pack --pack-destination dist
	ls -1 dist/*.tgz

publish: verify ## Publish this version (needs pnpm login; public access via publishConfig)
	@echo "==> publishing $(NAME)@$(VERSION) to the default registry"
	$(PNPM) publish

publish-next: verify ## Publish under the "next" dist-tag for pre-release testing
	@echo "==> publishing $(NAME)@$(VERSION) with dist-tag next"
	$(PNPM) publish --tag next

publish-dry-run: ## Dry-run publish: packs and reports, writes nothing, needs no credentials
	@echo "==> pnpm publish --dry-run (no registry write, no credentials needed)"
	$(PNPM) publish --dry-run
