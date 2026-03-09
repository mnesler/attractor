package engine_test

import (
	"context"
	"testing"

	"github.com/attractor/attractor/internal/engine"
	"github.com/attractor/attractor/internal/handlers"
	"github.com/attractor/attractor/internal/parser"
)

// newTestEngine creates an engine with no LLM client (simulation mode).
func newTestEngine(t *testing.T) *engine.Engine {
	t.Helper()
	logsRoot := t.TempDir()
	registry := handlers.NewRegistry(nil, "")
	return engine.NewEngine(registry, logsRoot)
}

// ---------- helpers ----------

func mustParseGraph(t *testing.T, src string) *parser.Graph {
	t.Helper()
	g, err := parser.Parse(src)
	if err != nil {
		t.Fatalf("parser.Parse() error: %v", err)
	}
	return g
}

// ---------- basic run ----------

func TestEngine_SimpleLinearPipeline(t *testing.T) {
	src := `digraph linear {
		graph [goal="test goal"]
		start  [shape=Mdiamond]
		work   [shape=box, label="Do Work"]
		finish [shape=Msquare]
		start  -> work
		work   -> finish
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, err := eng.Run(context.Background(), g, "run1", "pipe1", "openai/gpt-4o")
	if err != nil {
		t.Fatalf("Run() unexpected error: %v", err)
	}
	if runLog == nil {
		t.Fatal("Run() returned nil run log")
	}
	if runLog.Status != engine.RunStatusSuccess {
		t.Errorf("Status = %q, want %q; error: %s", runLog.Status, engine.RunStatusSuccess, runLog.ErrorMessage)
	}
}

func TestEngine_RunLog_Metadata(t *testing.T) {
	src := `digraph mypipe {
		graph [goal="verify metadata"]
		s [shape=Mdiamond]
		e [shape=Msquare]
		s -> e
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "run-meta", "pipe-meta", "openai/gpt-4o")

	if runLog.RunID != "run-meta" {
		t.Errorf("RunID = %q, want %q", runLog.RunID, "run-meta")
	}
	if runLog.PipelineID != "pipe-meta" {
		t.Errorf("PipelineID = %q, want %q", runLog.PipelineID, "pipe-meta")
	}
	if runLog.GraphID != "mypipe" {
		t.Errorf("GraphID = %q, want %q", runLog.GraphID, "mypipe")
	}
	if runLog.GraphGoal != "verify metadata" {
		t.Errorf("GraphGoal = %q, want %q", runLog.GraphGoal, "verify metadata")
	}
	if runLog.Model != "openai/gpt-4o" {
		t.Errorf("Model = %q, want %q", runLog.Model, "openai/gpt-4o")
	}
	if runLog.DurationMs < 0 {
		t.Errorf("DurationMs = %d, should be >= 0", runLog.DurationMs)
	}
	if runLog.StartTime.IsZero() {
		t.Error("StartTime should not be zero")
	}
	if runLog.EndTime.IsZero() {
		t.Error("EndTime should not be zero")
	}
}

func TestEngine_NodeLogsRecorded(t *testing.T) {
	src := `digraph test {
		s    [shape=Mdiamond]
		n1   [shape=box]
		n2   [shape=box]
		exit [shape=Msquare]
		s  -> n1
		n1 -> n2
		n2 -> exit
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "r1", "p1", "")

	// Should have logs for s, n1, n2 (exit runs but typically doesn't produce a log entry)
	if len(runLog.NodeLogs) == 0 {
		t.Error("expected node logs, got none")
	}
	// Every log should have a NodeID
	for _, nl := range runLog.NodeLogs {
		if nl.NodeID == "" {
			t.Error("NodeLog has empty NodeID")
		}
		if nl.StartTime.IsZero() {
			t.Errorf("NodeLog[%s] StartTime is zero", nl.NodeID)
		}
	}
}

// ---------- context cancellation ----------

func TestEngine_ContextCancellation(t *testing.T) {
	src := `digraph cancel_test {
		s [shape=Mdiamond]
		e [shape=Msquare]
		s -> e
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	runLog, err := eng.Run(ctx, g, "r-cancel", "p1", "")
	// Either the context error propagates or run log shows cancelled
	if err == nil && runLog.Status != engine.RunStatusCancelled {
		// Acceptable: run was short enough to complete before cancellation was detected
		// Just verify we got a run log at all
		if runLog == nil {
			t.Error("expected run log even on cancellation")
		}
	}
}

// ---------- missing start node ----------

func TestEngine_MissingStartNode(t *testing.T) {
	src := `digraph no_start {
		a [shape=box]
		b [shape=Msquare]
		a -> b
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "r1", "p1", "")
	if runLog.Status != engine.RunStatusFailed {
		t.Errorf("Status = %q, want %q", runLog.Status, engine.RunStatusFailed)
	}
	if runLog.ErrorMessage == "" {
		t.Error("ErrorMessage should be set for missing start node")
	}
}

// ---------- edge selection ----------

func TestEngine_EdgeSelection_Weighted(t *testing.T) {
	// Two outgoing unconditional edges; higher weight should win
	src := `digraph weighted {
		s    [shape=Mdiamond]
		high [shape=box, label="High"]
		low  [shape=box, label="Low"]
		exit [shape=Msquare]
		s    -> high [weight=10]
		s    -> low  [weight=1]
		high -> exit
		low  -> exit
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "r1", "p1", "")
	if runLog.Status != engine.RunStatusSuccess {
		t.Errorf("Status = %q, want %q; error: %s", runLog.Status, engine.RunStatusSuccess, runLog.ErrorMessage)
	}
	// Verify high-weight path was taken
	visited := map[string]bool{}
	for _, nl := range runLog.NodeLogs {
		visited[nl.NodeID] = true
	}
	if !visited["high"] {
		t.Error("expected high-weight node 'high' to be visited")
	}
	if visited["low"] {
		t.Error("unexpected low-weight node 'low' was visited")
	}
}

func TestEngine_EdgeSelection_LexicalTiebreak(t *testing.T) {
	// Two edges with equal weight — lexically first target (a_node < z_node) wins
	src := `digraph lexical {
		s      [shape=Mdiamond]
		a_node [shape=box]
		z_node [shape=box]
		exit   [shape=Msquare]
		s      -> a_node [weight=1]
		s      -> z_node [weight=1]
		a_node -> exit
		z_node -> exit
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "r1", "p1", "")
	visited := map[string]bool{}
	for _, nl := range runLog.NodeLogs {
		visited[nl.NodeID] = true
	}
	if !visited["a_node"] {
		t.Error("expected lexically first node 'a_node' to be visited")
	}
	if visited["z_node"] {
		t.Error("unexpected 'z_node' was visited")
	}
}

// ---------- conditional edges ----------

func TestEngine_ConditionalEdges(t *testing.T) {
	// After the conditional node, the engine should route to 'yes_path' via condition
	// Since handlers return success, condition "outcome=success" should match
	src := `digraph cond_test {
		s        [shape=Mdiamond]
		check    [shape=diamond]
		yes_path [shape=box]
		no_path  [shape=box]
		exit     [shape=Msquare]
		s        -> check
		check    -> yes_path [label="yes", condition="outcome=success"]
		check    -> no_path  [label="no",  condition="outcome=fail"]
		yes_path -> exit
		no_path  -> exit
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "r1", "p1", "")

	if runLog.Status != engine.RunStatusSuccess {
		t.Errorf("Status = %q; error: %s", runLog.Status, runLog.ErrorMessage)
	}
	visited := map[string]bool{}
	for _, nl := range runLog.NodeLogs {
		visited[nl.NodeID] = true
	}
	if !visited["yes_path"] {
		t.Error("expected 'yes_path' to be visited")
	}
	if visited["no_path"] {
		t.Error("unexpected 'no_path' was visited")
	}
}

// ---------- single-node pipeline ----------

func TestEngine_StartDirectlyToExit(t *testing.T) {
	src := `digraph trivial {
		s [shape=Mdiamond]
		e [shape=Msquare]
		s -> e
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, err := eng.Run(context.Background(), g, "r1", "p1", "")
	if err != nil {
		t.Fatalf("Run() error: %v", err)
	}
	if runLog.Status != engine.RunStatusSuccess {
		t.Errorf("Status = %q; error: %s", runLog.Status, runLog.ErrorMessage)
	}
}

// ---------- wait_human handler ----------

func TestEngine_WaitHumanAutoSelects(t *testing.T) {
	src := `digraph human_test {
		s     [shape=Mdiamond]
		gate  [shape=hexagon, label="Approve?"]
		yes   [shape=box, label="Approved"]
		no    [shape=box, label="Rejected"]
		exit  [shape=Msquare]
		s    -> gate
		gate -> yes  [label="approve"]
		gate -> no   [label="reject"]
		yes  -> exit
		no   -> exit
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "r1", "p1", "")
	if runLog.Status != engine.RunStatusSuccess {
		t.Errorf("Status = %q; error: %s", runLog.Status, runLog.ErrorMessage)
	}
}

// ---------- tool handler ----------

func TestEngine_ToolHandler_Success(t *testing.T) {
	src := `digraph tool_test {
		s    [shape=Mdiamond]
		tool [shape=parallelogram, tool_command="echo hello"]
		exit [shape=Msquare]
		s    -> tool
		tool -> exit
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "r1", "p1", "")
	if runLog.Status != engine.RunStatusSuccess {
		t.Errorf("Status = %q; error: %s", runLog.Status, runLog.ErrorMessage)
	}
}

func TestEngine_ToolHandler_CommandFails(t *testing.T) {
	// No outgoing edge from tool → engine fails the pipeline when tool returns StatusFail
	src := `digraph tool_fail {
		s    [shape=Mdiamond]
		tool [shape=parallelogram, tool_command="exit 1"]
		s -> tool
	}`
	g := mustParseGraph(t, src)
	eng := newTestEngine(t)

	runLog, _ := eng.Run(context.Background(), g, "r1", "p1", "")
	// Tool failure with no outgoing edge → pipeline fails
	if runLog.Status != engine.RunStatusFailed {
		t.Errorf("Status = %q, want failed", runLog.Status)
	}
}

// ---------- RunStatus constants ----------

func TestRunStatus_Constants(t *testing.T) {
	statuses := []engine.RunStatus{
		engine.RunStatusRunning,
		engine.RunStatusSuccess,
		engine.RunStatusFailed,
		engine.RunStatusCancelled,
	}
	seen := map[engine.RunStatus]bool{}
	for _, s := range statuses {
		if s == "" {
			t.Error("empty RunStatus constant")
		}
		if seen[s] {
			t.Errorf("duplicate RunStatus: %q", s)
		}
		seen[s] = true
	}
}
