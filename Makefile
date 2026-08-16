IMAGE   ?= ghcr.io/be-hase/pyrolens
TAG     ?= latest
VERSION ?= dev

.PHONY: build run docker release-check snapshot clean

# Build the UI and the self-contained server binary.
build:
	yarn install --immutable
	yarn build
	go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o pyrolens .

# One-command local run: builds everything, then serves on :4041.
# Point it elsewhere with PYROSCOPE_URL=http://host:4040 make run
run: build
	./pyrolens

docker:
	docker build -t $(IMAGE):$(TAG) .

# Releases are cut by tagging (see .github/workflows/release.yml); these
# two exercise the same GoReleaser config locally without publishing.
release-check:
	goreleaser check

# `build`, not just its `yarn build` line: GoReleaser no longer builds the UI
# itself (that moved to release.yml's build-ui job, off the token-bearing
# release job — see .goreleaser.yaml), so this has to exist before goreleaser
# runs, or it fails deep in the Go build with "pattern all:dist: no matching
# files found" — or worse, silently archives a stale dist/ left over from an
# earlier build.
snapshot: build
	goreleaser release --snapshot --clean --skip=docker

clean:
	rm -rf dist .goreleaser-dist pyrolens
