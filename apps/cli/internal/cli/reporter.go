package cli

import (
	"fmt"
	"io"
)

type actionReporter struct {
	progress io.Writer
	results  io.Writer
}

func newActionReporter(progress, results io.Writer) *actionReporter {
	return &actionReporter{progress: progress, results: results}
}

func (r *actionReporter) Step(format string, args ...any) {
	if r == nil || r.progress == nil {
		return
	}
	fmt.Fprintf(r.progress, "==> "+format+"\n", args...)
}

func (r *actionReporter) Done(format string, args ...any) {
	if r == nil || r.results == nil {
		return
	}
	fmt.Fprintf(r.results, "Done: "+format+"\n", args...)
}
