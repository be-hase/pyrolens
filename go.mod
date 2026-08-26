module github.com/be-hase/pyrolens

go 1.25

// Pins what actually builds: setup-go reads this, so CI, GoReleaser,
// the Dockerfile and mise all use one toolchain. `go` above stays the
// language minimum for anyone building from source.
toolchain go1.27.0
