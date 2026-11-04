# dsh-browser-native — quality and npm staged-release targets.
#
# Quality recipes go through pnpm (the version pinned in package.json >
# packageManager). Release recipes use npm's staged publishing (`npm stage`,
# npm 12+): staging a version needs no 2FA and can run unattended, while
# approving it later is where proof-of-presence (2FA) happens.
# Package name and version are read from package.json at parse time so they can
# never drift from the manifest.

SHELL := /bin/sh
.DEFAULT_GOAL := help

PNPM ?= pnpm
NPM ?= npm
NAME := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")

# Guard for the stage targets that address one staged version: complain about a
# missing STAGE_ID, print usage and exit 2. Call as $(call STAGE_ID_GUARD,<target>).
STAGE_ID_GUARD = if [ -z "$(STAGE_ID)" ]; then \
	echo "error: STAGE_ID is required for 'make $(1)'"; \
	echo "usage: make $(1) STAGE_ID=<stage-id>"; \
	echo "hint:  'make stage-list' prints the staged ids"; \
	exit 2; \
fi

.PHONY: help install typecheck test build verify pack \
	stage-publish stage-publish-next stage-publish-dry-run \
	stage-list stage-approve stage-reject stage-view

help: ## Show this help (default target)
	@echo "$(NAME)@$(VERSION) — usage: make <target>"
	@echo
	@awk 'BEGIN {FS = ":.*## "}; /^[a-z][a-z-]*:.*## / {printf "  %-24s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies from pnpm-lock.yaml (frozen)
	$(PNPM) install 

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

# --- staged publishing (npm 12+) --------------------------------------------
# stage -> list -> approve. Nothing becomes installable until a human approves.

stage-publish: verify ## Stage this version for publishing (no 2FA; approve later)
	@echo "==> staging $(NAME)@$(VERSION) on the default tag (npm stage, no 2FA)"
	$(PNPM) stage publish

stage-publish-next: verify ## Stage this version under the "next" dist-tag
	@echo "==> staging $(NAME)@$(VERSION) with dist-tag next"
	$(PNPM) stage publish --tag next

stage-publish-dry-run: ## Dry-run stage: packs and reports, writes nothing, needs no credentials
	@echo "==> npm stage publish --dry-run (no registry write, no credentials needed)"
	$(PNPM) stage publish --dry-run

stage-list: ## List staged versions of this package and their stage ids
	@echo "==> staged versions of $(NAME)"
	$(PNPM) stage list $(NAME)

stage-view: ## Inspect one staged version (needs STAGE_ID=<id>)
	@$(call STAGE_ID_GUARD,stage-view)
	@echo "==> staged version $(STAGE_ID) of $(NAME)"
	$(PNPM) stage view $(STAGE_ID)

stage-approve: verify ## Approve a staged version, publishing it (needs STAGE_ID=<id>, 2FA)
	@$(call STAGE_ID_GUARD,stage-approve)
	@echo "==> approving staged version $(STAGE_ID) of $(NAME) (2FA required)"
	$(PNPM) stage approve $(STAGE_ID)

stage-reject: verify ## Reject a staged version and drop it (needs STAGE_ID=<id>, 2FA)
	@$(call STAGE_ID_GUARD,stage-reject)
	@echo "==> rejecting staged version $(STAGE_ID) of $(NAME) (2FA required)"
	$(PNPM) stage reject $(STAGE_ID)
