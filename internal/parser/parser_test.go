package parser_test

import (
	"strings"
	"testing"

	"github.com/attractor/attractor/internal/parser"
)

// ---------- helpers ----------

func mustParse(t *testing.T, src string) *parser.Graph {
	t.Helper()
	g, err := parser.Parse(src)
	if err != nil {
		t.Fatalf("Parse() unexpected error: %v", err)
	}
	return g
}

func nodeOf(t *testing.T, g *parser.Graph, id string) *parser.Node {
	t.Helper()
	n, ok := g.Nodes[id]
	if !ok {
		t.Fatalf("node %q not found in graph", id)
	}
	return n
}

// ---------- basic graph structure ----------

func TestParse_MinimalGraph(t *testing.T) {
	src := `digraph mypipe {
		start [shape=Mdiamond, label="Start"]
		exit  [shape=Msquare,  label="End"]
		start -> exit
	}`
	g := mustParse(t, src)

	if g.ID != "mypipe" {
		t.Errorf("graph ID = %q, want %q", g.ID, "mypipe")
	}
	if len(g.Nodes) != 2 {
		t.Errorf("node count = %d, want 2", len(g.Nodes))
	}
	if len(g.Edges) != 1 {
		t.Errorf("edge count = %d, want 1", len(g.Edges))
	}
}

func TestParse_GraphAttrs(t *testing.T) {
	src := `digraph p {
		graph [
			goal = "do something great"
			default_max_retry = 3
			retry_target = n1
		]
		start [shape=Mdiamond]
	}`
	g := mustParse(t, src)

	if g.Goal != "do something great" {
		t.Errorf("Goal = %q, want %q", g.Goal, "do something great")
	}
	if g.DefaultMaxRetry != 3 {
		t.Errorf("DefaultMaxRetry = %d, want 3", g.DefaultMaxRetry)
	}
	if g.RetryTarget != "n1" {
		t.Errorf("RetryTarget = %q, want %q", g.RetryTarget, "n1")
	}
}

// ---------- node type mapping ----------

func TestParse_NodeTypes(t *testing.T) {
	cases := []struct {
		shape    string
		wantType parser.NodeType
	}{
		{"Mdiamond", parser.NodeTypeStart},
		{"Msquare", parser.NodeTypeExit},
		{"box", parser.NodeTypeCodergen},
		{"hexagon", parser.NodeTypeWaitHuman},
		{"diamond", parser.NodeTypeConditional},
		{"component", parser.NodeTypeParallel},
		{"tripleoctagon", parser.NodeTypeFanIn},
		{"parallelogram", parser.NodeTypeTool},
		{"house", parser.NodeTypeManagerLoop},
	}

	for _, tc := range cases {
		src := `digraph test {
			n [shape=` + tc.shape + `]
		}`
		g := mustParse(t, src)
		n := nodeOf(t, g, "n")
		if n.Type != tc.wantType {
			t.Errorf("shape=%s → type=%q, want %q", tc.shape, n.Type, tc.wantType)
		}
	}
}

func TestParse_UnknownShapeDefaultsToCodergen(t *testing.T) {
	src := `digraph test { n [shape=ellipse] }`
	g := mustParse(t, src)
	n := nodeOf(t, g, "n")
	if n.Type != parser.NodeTypeCodergen {
		t.Errorf("unknown shape type = %q, want codergen", n.Type)
	}
}

// ---------- node attributes ----------

func TestParse_NodeAttributes(t *testing.T) {
	src := `digraph test {
		n [
			shape       = box
			label       = "Do work"
			prompt      = "Do the following: $goal"
			max_retries = 2
			goal_gate   = true
			allow_partial = true
			llm_model   = "openai/gpt-4o-mini"
		]
	}`
	g := mustParse(t, src)
	n := nodeOf(t, g, "n")

	if n.Label != "Do work" {
		t.Errorf("Label = %q, want %q", n.Label, "Do work")
	}
	if n.Prompt != "Do the following: $goal" {
		t.Errorf("Prompt = %q, want %q", n.Prompt, "Do the following: $goal")
	}
	if n.MaxRetries != 2 {
		t.Errorf("MaxRetries = %d, want 2", n.MaxRetries)
	}
	if !n.GoalGate {
		t.Errorf("GoalGate = false, want true")
	}
	if !n.AllowPartial {
		t.Errorf("AllowPartial = false, want true")
	}
	if n.LLMModel != "openai/gpt-4o-mini" {
		t.Errorf("LLMModel = %q, want %q", n.LLMModel, "openai/gpt-4o-mini")
	}
}

func TestParse_NodeDefaultLabel(t *testing.T) {
	// Label should default to the node ID when not specified
	src := `digraph test { mynode [shape=box] }`
	g := mustParse(t, src)
	n := nodeOf(t, g, "mynode")
	if n.Label != "mynode" {
		t.Errorf("default Label = %q, want %q", n.Label, "mynode")
	}
}

func TestParse_BareNode(t *testing.T) {
	// A bare node ID with no attributes should still be registered
	src := `digraph test {
		node [shape=box]
		alpha
		alpha -> beta
		beta
	}`
	g := mustParse(t, src)
	if _, ok := g.Nodes["alpha"]; !ok {
		t.Error("bare node 'alpha' not registered")
	}
}

// ---------- edge attributes ----------

func TestParse_EdgeAttributes(t *testing.T) {
	src := `digraph test {
		a [shape=Mdiamond]
		b [shape=box]
		a -> b [label="go", condition="outcome=success", weight=5]
	}`
	g := mustParse(t, src)
	if len(g.Edges) != 1 {
		t.Fatalf("edge count = %d, want 1", len(g.Edges))
	}
	e := g.Edges[0]
	if e.From != "a" || e.To != "b" {
		t.Errorf("edge from/to = %s/%s, want a/b", e.From, e.To)
	}
	if e.Label != "go" {
		t.Errorf("edge Label = %q, want %q", e.Label, "go")
	}
	if e.Condition != "outcome=success" {
		t.Errorf("edge Condition = %q, want %q", e.Condition, "outcome=success")
	}
	if e.Weight != 5 {
		t.Errorf("edge Weight = %d, want 5", e.Weight)
	}
}

func TestParse_ChainedEdges(t *testing.T) {
	src := `digraph test {
		a -> b -> c -> d
	}`
	g := mustParse(t, src)
	if len(g.Edges) != 3 {
		t.Errorf("chained edge count = %d, want 3", len(g.Edges))
	}
	froms := []string{"a", "b", "c"}
	tos := []string{"b", "c", "d"}
	for i, e := range g.Edges {
		if e.From != froms[i] || e.To != tos[i] {
			t.Errorf("edge[%d] = %s->%s, want %s->%s", i, e.From, e.To, froms[i], tos[i])
		}
	}
}

func TestParse_EdgeLoopRestart(t *testing.T) {
	src := `digraph test {
		a -> b [loop_restart=true]
	}`
	g := mustParse(t, src)
	if len(g.Edges) != 1 {
		t.Fatalf("edge count = %d, want 1", len(g.Edges))
	}
	if !g.Edges[0].LoopRestart {
		t.Error("LoopRestart = false, want true")
	}
}

func TestParse_EdgeDefaults(t *testing.T) {
	src := `digraph test {
		edge [weight=3]
		a -> b
		a -> c [weight=7]
	}`
	g := mustParse(t, src)
	if len(g.Edges) != 2 {
		t.Fatalf("edge count = %d, want 2", len(g.Edges))
	}
	if g.Edges[0].Weight != 3 {
		t.Errorf("default edge weight = %d, want 3", g.Edges[0].Weight)
	}
	if g.Edges[1].Weight != 7 {
		t.Errorf("override edge weight = %d, want 7", g.Edges[1].Weight)
	}
}

// ---------- comments ----------

func TestParse_LineComments(t *testing.T) {
	src := `// This is a full-line comment
digraph test {
	// another comment
	a [shape=Mdiamond] // inline comment
	b [shape=Msquare]
	a -> b // edge comment
}`
	g := mustParse(t, src)
	if len(g.Nodes) != 2 {
		t.Errorf("node count = %d, want 2", len(g.Nodes))
	}
}

func TestParse_BlockComments(t *testing.T) {
	src := `digraph test {
	/* block comment spanning
	   multiple lines */
	a [shape=Mdiamond]
	b /* mid-line comment */ [shape=Msquare]
	a -> b
}`
	g := mustParse(t, src)
	if len(g.Nodes) != 2 {
		t.Errorf("node count = %d, want 2", len(g.Nodes))
	}
}

// ---------- string escapes ----------

func TestParse_StringEscapes(t *testing.T) {
	src := `digraph test {
		n [label="Line1\nLine2\tTabbed\"Quoted\""]
	}`
	g := mustParse(t, src)
	n := nodeOf(t, g, "n")
	want := "Line1\nLine2\tTabbed\"Quoted\""
	if n.Label != want {
		t.Errorf("Label = %q, want %q", n.Label, want)
	}
}

// ---------- FindStartNode ----------

func TestFindStartNode_ByShape(t *testing.T) {
	src := `digraph test {
		s [shape=Mdiamond, label="Start"]
		e [shape=Msquare,  label="End"]
		s -> e
	}`
	g := mustParse(t, src)
	n, err := g.FindStartNode()
	if err != nil {
		t.Fatalf("FindStartNode() error: %v", err)
	}
	if n.ID != "s" {
		t.Errorf("start node ID = %q, want %q", n.ID, "s")
	}
}

func TestFindStartNode_ByID(t *testing.T) {
	src := `digraph test {
		start [shape=box]
	}`
	g := mustParse(t, src)
	n, err := g.FindStartNode()
	if err != nil {
		t.Fatalf("FindStartNode() error: %v", err)
	}
	if n.ID != "start" {
		t.Errorf("start node ID = %q, want %q", n.ID, "start")
	}
}

func TestFindStartNode_Missing(t *testing.T) {
	src := `digraph test { n [shape=box] }`
	g := mustParse(t, src)
	_, err := g.FindStartNode()
	if err == nil {
		t.Error("expected error for missing start node, got nil")
	}
}

// ---------- OutgoingEdges ----------

func TestOutgoingEdges(t *testing.T) {
	src := `digraph test {
		a -> b
		a -> c
		b -> c
	}`
	g := mustParse(t, src)

	aEdges := g.OutgoingEdges("a")
	if len(aEdges) != 2 {
		t.Errorf("outgoing edges from a = %d, want 2", len(aEdges))
	}
	bEdges := g.OutgoingEdges("b")
	if len(bEdges) != 1 {
		t.Errorf("outgoing edges from b = %d, want 1", len(bEdges))
	}
	cEdges := g.OutgoingEdges("c")
	if len(cEdges) != 0 {
		t.Errorf("outgoing edges from c = %d, want 0", len(cEdges))
	}
}

// ---------- NormalizeLabel ----------

func TestNormalizeLabel(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"success", "success"},
		{"  SUCCESS  ", "success"},
		{"[y] yes", "yes"},
		{"y) yes", "yes"},
		{"y - yes", "yes"},
		{"[a] Approve", "approve"},
		{"Needs Fixes", "needs fixes"},
		{"", ""},
	}
	for _, tc := range cases {
		got := parser.NormalizeLabel(tc.input)
		if got != tc.want {
			t.Errorf("NormalizeLabel(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// ---------- error cases ----------

func TestParse_Errors(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want string // substring expected in error message
	}{
		{"not a digraph", `graph test {}`, "digraph"},
		{"missing open brace", `digraph test`, "expected '{'"},
		{"unterminated string", `digraph t { n [label="oops] }`, "unterminated string"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parser.Parse(tc.src)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to contain %q", err.Error(), tc.want)
			}
		})
	}
}

// ---------- real-world example ----------

func TestParse_ExamplePipeline(t *testing.T) {
	src := `digraph simple_research {
		graph [
			goal = "Research quantum computing"
			default_max_retry = 1
		]
		start    [shape=Mdiamond, label="Start"]
		research [shape=box, label="Research", prompt="Research: $goal"]
		summarize [shape=box, label="Summarize", prompt="Summarize the findings"]
		exit     [shape=Msquare, label="End"]

		start     -> research
		research  -> summarize
		summarize -> exit
	}`
	g := mustParse(t, src)

	if g.Goal != "Research quantum computing" {
		t.Errorf("Goal = %q", g.Goal)
	}
	if g.DefaultMaxRetry != 1 {
		t.Errorf("DefaultMaxRetry = %d", g.DefaultMaxRetry)
	}
	if len(g.Nodes) != 4 {
		t.Errorf("node count = %d, want 4", len(g.Nodes))
	}
	if len(g.Edges) != 3 {
		t.Errorf("edge count = %d, want 3", len(g.Edges))
	}
	start, err := g.FindStartNode()
	if err != nil {
		t.Fatalf("FindStartNode: %v", err)
	}
	if start.ID != "start" {
		t.Errorf("start node ID = %q, want %q", start.ID, "start")
	}
	research := nodeOf(t, g, "research")
	if research.Prompt != "Research: $goal" {
		t.Errorf("research prompt = %q", research.Prompt)
	}
}
