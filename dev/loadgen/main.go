// Command loadgen pushes synthetic CPU profiles into a Pyroscope server so
// the UI has something to render.
//
// It reports three "regions" (us-east, eu-west, ap-south) at a 3:2:1 weight
// as a `region` label, so the Tag Explorer has a dimension to break down,
// and every other minute it adds a slowRegression frame — which gives the
// Comparison and Diff views a real difference to show between two adjacent
// time windows.
//
// Configured by environment: SERVER (default http://localhost:4040), APP
// (the service_name to report as) and TENANT (sent as X-Scope-OrgID; leave
// unset for a single-tenant server).
package main

import (
	"context"
	"os"
	"time"

	"github.com/grafana/pyroscope-go"
)

var sink uint64

func cpuWork(iters int) {
	for i := 0; i < iters; i++ {
		sink = sink*1664525 + 1013904223
	}
}

func parseRequest()   { cpuWork(2_000_000) }
func renderResponse() { cpuWork(3_000_000) }
func queryDatabase()  { cpuWork(4_000_000) }
func slowRegression() { cpuWork(8_000_000) }

func handleRequest(phase int) {
	parseRequest()
	queryDatabase()
	renderResponse()
	if phase == 1 {
		slowRegression()
	}
}

func regionLoop(region string, weight int) {
	pyroscope.TagWrapper(context.Background(), pyroscope.Labels("region", region), func(ctx context.Context) {
		for {
			// Wall-clock minute, not elapsed-since-start: e2e/capture.mjs and
			// dev/README.md assume the slowRegression frame alternates on the
			// clock's own minute boundary. Keying it off `start` instead phase-
			// shifts with however far into a minute the process happened to
			// launch, so a container started mid-minute yields ~50/50 mixed
			// capture windows and a near-empty Diff fixture.
			phase := int(time.Now().Unix()/60) % 2
			for i := 0; i < weight; i++ {
				handleRequest(phase)
			}
			time.Sleep(5 * time.Millisecond)
		}
	})
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	app := os.Getenv("APP")
	tenant := os.Getenv("TENANT")
	_, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: app,
		ServerAddress:   envOr("SERVER", "http://localhost:4040"),
		TenantID:        tenant,
		Logger:          pyroscope.StandardLogger,
	})
	if err != nil {
		panic(err)
	}
	go regionLoop("us-east", 3)
	go regionLoop("eu-west", 2)
	regionLoop("ap-south", 1)
}
