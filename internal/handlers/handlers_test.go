package handlers_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	pctx "github.com/attractor/attractor/internal/context"
	"github.com/attractor/attractor/internal/handlers"
	"github.com/attractor/attractor/internal/parser"
)

// ---------- helpers ----------

func newGraph() *parser.Graph {
	g := parser.NewGraph()
	g.ID = "test"
	g.Goal = "test goal"
	return g
}

func newNode(id string, t parser.NodeType) *parser.Node {
	return &parser.Node{
		ID:    id,
		Label: id,
		Type:  t,
		Shape: "box",
		Attrs: map[string]string{},
	}
}

func newCtx() *pctx.Context {
	c := pctx.NewContext()
	c.Set("graph.goal", "test goal")
	return c
}

// ---------- Registry ----------

func TestRegistry_ResolveBuiltins(t *testing.T) {
	reg := handlers.NewRegistry(nil, "")

	types := []parser.NodeType{
		parser.NodeTypeStart,
		parser.NodeTypeExit,
		parser.NodeTypeCodergen,
		parser.NodeTypeConditional,
		parser.NodeTypeWaitHuman,
		parser.NodeTypeParallel,
		parser.NodeTypeFanIn,
		parser.NodeTypeTool,
		parser.NodeTypeManagerLoop,
	}

	for _, nt := range types {
		node := newNode("n", nt)
		h := reg.Resolve(node)
		if h == nil {
			t.Errorf("Resolve(%q) returned nil", nt)
		}
	}
}

func TestRegistry_ResolveUnknownUsesDefault(t *testing.T) {
	reg := handlers.NewRegistry(nil, "")
	node := newNode("n", parser.NodeType("totally_unknown"))
	h := reg.Resolve(node)
	if h == nil {
		t.Error("Resolve(unknown type) returned nil, expected default handler")
	}
}

func TestRegistry_Register_Override(t *testing.T) {
	reg := handlers.NewRegistry(nil, "")

	// Register a custom handler for the start type
	custom := &handlers.StartHandler{} // reuse StartHandler as a stand-in
	reg.Register(parser.NodeTypeStart, custom)

	node := newNode("n", parser.NodeTypeStart)
	got := reg.Resolve(node)
	if got != custom {
		t.Error("Resolve() after Register() did not return the custom handler")
	}
}

// ---------- StartHandler ----------

func TestStartHandler_Execute(t *testing.T) {
	h := &handlers.StartHandler{}
	node := newNode("start", parser.NodeTypeStart)
	outcome, err := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if err != nil {
		t.Fatalf("StartHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusSuccess)
	}
}

// ---------- ExitHandler ----------

func TestExitHandler_Execute(t *testing.T) {
	h := &handlers.ExitHandler{}
	node := newNode("exit", parser.NodeTypeExit)
	outcome, err := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if err != nil {
		t.Fatalf("ExitHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusSuccess)
	}
}

// ---------- CodergenHandler (simulation mode, no LLM client) ----------

func TestCodergenHandler_Simulated(t *testing.T) {
	h := &handlers.CodergenHandler{Client: nil, DefaultModel: ""}
	node := &parser.Node{
		ID:     "research",
		Label:  "Research",
		Type:   parser.NodeTypeCodergen,
		Prompt: "Research: $goal",
		Attrs:  map[string]string{},
	}
	logsRoot := t.TempDir()
	ctx := newCtx()

	outcome, err := h.Execute(context.Background(), node, ctx, newGraph(), logsRoot)
	if err != nil {
		t.Fatalf("CodergenHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusSuccess)
	}

	// Stage directory should have been created with prompt.md
	promptPath := filepath.Join(logsRoot, "research", "prompt.md")
	if _, err := os.Stat(promptPath); os.IsNotExist(err) {
		t.Errorf("prompt.md not created at %s", promptPath)
	}

	// ContextUpdates should have last_stage
	if outcome.ContextUpdates["last_stage"] != "research" {
		t.Errorf("ContextUpdates[last_stage] = %q, want %q", outcome.ContextUpdates["last_stage"], "research")
	}
}

func TestCodergenHandler_PromptExpandsGoal(t *testing.T) {
	h := &handlers.CodergenHandler{Client: nil, DefaultModel: ""}
	node := &parser.Node{
		ID:     "n1",
		Label:  "Work",
		Type:   parser.NodeTypeCodergen,
		Prompt: "Work on: $goal",
		Attrs:  map[string]string{},
	}
	logsRoot := t.TempDir()
	ctx := newCtx()
	ctx.Set("graph.goal", "my special goal")

	_, err := h.Execute(context.Background(), node, ctx, newGraph(), logsRoot)
	if err != nil {
		t.Fatalf("Execute() error: %v", err)
	}

	// Verify the written prompt contains the expanded goal
	data, err := os.ReadFile(filepath.Join(logsRoot, "n1", "prompt.md"))
	if err != nil {
		t.Fatalf("reading prompt.md: %v", err)
	}
	if string(data) != "Work on: my special goal" {
		t.Errorf("prompt content = %q, want %q", string(data), "Work on: my special goal")
	}
}

func TestCodergenHandler_FallsBackToLabel(t *testing.T) {
	// When no explicit prompt, label should be used
	h := &handlers.CodergenHandler{Client: nil, DefaultModel: ""}
	node := &parser.Node{
		ID:     "analyze",
		Label:  "Analyze the data",
		Type:   parser.NodeTypeCodergen,
		Prompt: "", // no explicit prompt
		Attrs:  map[string]string{},
	}
	logsRoot := t.TempDir()

	_, err := h.Execute(context.Background(), node, newCtx(), newGraph(), logsRoot)
	if err != nil {
		t.Fatalf("Execute() error: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(logsRoot, "analyze", "prompt.md"))
	if string(data) != "Analyze the data" {
		t.Errorf("prompt = %q, want label %q", string(data), "Analyze the data")
	}
}

// ---------- ConditionalHandler ----------

func TestConditionalHandler_Execute(t *testing.T) {
	h := &handlers.ConditionalHandler{}
	node := newNode("check", parser.NodeTypeConditional)
	outcome, err := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if err != nil {
		t.Fatalf("ConditionalHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusSuccess)
	}
}

// ---------- WaitHumanHandler ----------

func TestWaitHumanHandler_AutoSelectsFirst(t *testing.T) {
	h := &handlers.WaitHumanHandler{}
	node := newNode("gate", parser.NodeTypeWaitHuman)
	g := newGraph()
	g.Nodes["gate"] = node
	g.Nodes["yes"] = newNode("yes", parser.NodeTypeCodergen)
	g.Nodes["no"] = newNode("no", parser.NodeTypeCodergen)
	g.Edges = []*parser.Edge{
		{From: "gate", To: "yes", Label: "approve"},
		{From: "gate", To: "no", Label: "reject"},
	}

	outcome, err := h.Execute(context.Background(), node, newCtx(), g, t.TempDir())
	if err != nil {
		t.Fatalf("WaitHumanHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusSuccess)
	}
	if len(outcome.SuggestedNextIDs) == 0 {
		t.Error("expected SuggestedNextIDs to be set")
	}
}

func TestWaitHumanHandler_PresetAnswer(t *testing.T) {
	h := &handlers.WaitHumanHandler{}
	node := newNode("gate", parser.NodeTypeWaitHuman)
	g := newGraph()
	g.Nodes["gate"] = node
	g.Nodes["yes"] = newNode("yes", parser.NodeTypeCodergen)
	g.Nodes["no"] = newNode("no", parser.NodeTypeCodergen)
	g.Edges = []*parser.Edge{
		{From: "gate", To: "yes", Label: "approve"},
		{From: "gate", To: "no", Label: "reject"},
	}

	ctx := newCtx()
	ctx.Set("human.gate.answer.gate", "reject")

	outcome, err := h.Execute(context.Background(), node, ctx, g, t.TempDir())
	if err != nil {
		t.Fatalf("WaitHumanHandler.Execute() error: %v", err)
	}
	if len(outcome.SuggestedNextIDs) == 0 || outcome.SuggestedNextIDs[0] != "no" {
		t.Errorf("SuggestedNextIDs = %v, want [no]", outcome.SuggestedNextIDs)
	}
}

func TestWaitHumanHandler_NoEdges(t *testing.T) {
	h := &handlers.WaitHumanHandler{}
	node := newNode("gate", parser.NodeTypeWaitHuman)
	g := newGraph()
	g.Nodes["gate"] = node
	// No edges from gate

	outcome, err := h.Execute(context.Background(), node, newCtx(), g, t.TempDir())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Status != pctx.StatusFail {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusFail)
	}
}

// ---------- ToolHandler ----------

func TestToolHandler_Success(t *testing.T) {
	h := &handlers.ToolHandler{}
	node := &parser.Node{
		ID:    "tool",
		Label: "Run Tool",
		Type:  parser.NodeTypeTool,
		Attrs: map[string]string{"tool_command": "echo hello"},
	}
	outcome, err := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if err != nil {
		t.Fatalf("ToolHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q; reason: %s", outcome.Status, pctx.StatusSuccess, outcome.FailureReason)
	}
	if outcome.ContextUpdates["tool.output"] == "" {
		t.Error("expected tool.output in ContextUpdates")
	}
}

func TestToolHandler_CommandFails(t *testing.T) {
	h := &handlers.ToolHandler{}
	node := &parser.Node{
		ID:    "tool",
		Label: "Run Tool",
		Type:  parser.NodeTypeTool,
		Attrs: map[string]string{"tool_command": "exit 42"},
	}
	outcome, err := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Status != pctx.StatusFail {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusFail)
	}
	if outcome.FailureReason == "" {
		t.Error("expected FailureReason to be set")
	}
}

func TestToolHandler_NoCommand(t *testing.T) {
	h := &handlers.ToolHandler{}
	node := &parser.Node{
		ID:    "tool",
		Label: "Tool",
		Type:  parser.NodeTypeTool,
		Attrs: map[string]string{},
	}
	outcome, _ := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if outcome.Status != pctx.StatusFail {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusFail)
	}
}

// ---------- stub handlers ----------

func TestParallelHandler_Execute(t *testing.T) {
	h := &handlers.ParallelHandler{}
	node := newNode("par", parser.NodeTypeParallel)
	outcome, err := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if err != nil {
		t.Fatalf("ParallelHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusSuccess)
	}
}

func TestFanInHandler_Execute(t *testing.T) {
	h := &handlers.FanInHandler{}
	node := newNode("fanin", parser.NodeTypeFanIn)
	outcome, err := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if err != nil {
		t.Fatalf("FanInHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusSuccess)
	}
}

func TestManagerLoopHandler_Execute(t *testing.T) {
	h := &handlers.ManagerLoopHandler{}
	node := newNode("mgr", parser.NodeTypeManagerLoop)
	outcome, err := h.Execute(context.Background(), node, newCtx(), newGraph(), t.TempDir())
	if err != nil {
		t.Fatalf("ManagerLoopHandler.Execute() error: %v", err)
	}
	if outcome.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", outcome.Status, pctx.StatusSuccess)
	}
}
