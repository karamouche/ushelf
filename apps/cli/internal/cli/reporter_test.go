package cli

import (
	"bytes"
	"testing"
)

func TestActionReporterSeparatesProgressAndResults(t *testing.T) {
	var progress, results bytes.Buffer
	reporter := newActionReporter(&progress, &results)
	reporter.Step("Preparing %s...", "uShelf")
	reporter.Done("uShelf is ready")
	if progress.String() != "==> Preparing uShelf...\n" {
		t.Fatalf("unexpected progress output: %q", progress.String())
	}
	if results.String() != "Done: uShelf is ready\n" {
		t.Fatalf("unexpected result output: %q", results.String())
	}
}
