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

snapshot:
	goreleaser release --snapshot --clean --skip=docker

clean:
	rm -rf dist .goreleaser-dist pyrolens
