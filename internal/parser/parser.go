// Package parser implements a DOT DSL parser for Attractor pipeline definitions.
// It supports a strict subset of Graphviz DOT syntax as specified in attractor-spec.md.
package parser

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// NodeType represents the handler type derived from shape or explicit type attr
type NodeType string

const (
	NodeTypeStart       NodeType = "start"
	NodeTypeExit        NodeType = "exit"
	NodeTypeCodergen    NodeType = "codergen"
	NodeTypeWaitHuman   NodeType = "wait.human"
	NodeTypeConditional NodeType = "conditional"
	NodeTypeParallel    NodeType = "parallel"
	NodeTypeFanIn       NodeType = "parallel.fan_in"
	NodeTypeTool        NodeType = "tool"
	NodeTypeManagerLoop NodeType = "stack.manager_loop"
)

// shapeToType maps DOT shape attribute to handler type
var shapeToType = map[string]NodeType{
	"Mdiamond":      NodeTypeStart,
	"Msquare":       NodeTypeExit,
	"box":           NodeTypeCodergen,
	"hexagon":       NodeTypeWaitHuman,
	"diamond":       NodeTypeConditional,
	"component":     NodeTypeParallel,
	"tripleoctagon": NodeTypeFanIn,
	"parallelogram": NodeTypeTool,
	"house":         NodeTypeManagerLoop,
}

// Node represents a node in the pipeline graph
type Node struct {
	ID                  string
	Label               string
	Shape               string
	Type                NodeType
	Prompt              string
	MaxRetries          int
	GoalGate            bool
	RetryTarget         string
	FallbackRetryTarget string
	Fidelity            string
	ThreadID            string
	Class               string
	Timeout             string
	LLMModel            string
	LLMProvider         string
	ReasoningEffort     string
	AutoStatus          bool
	AllowPartial        bool
	Attrs               map[string]string
}

// Edge represents a directed edge in the pipeline graph
type Edge struct {
	From      string
	To        string
	Label     string
	Condition string
	Weight    int
	Fidelity  string
	ThreadID  string
	LoopRestart bool
}

// Graph represents a parsed pipeline graph
type Graph struct {
	ID                  string
	Goal                string
	Label               string
	ModelStylesheet     string
	DefaultMaxRetry     int
	RetryTarget         string
	FallbackRetryTarget string
	DefaultFidelity     string
	Nodes               map[string]*Node
	Edges               []*Edge
	Attrs               map[string]string
}

// NewGraph creates a Graph with defaults
func NewGraph() *Graph {
	return &Graph{
		DefaultMaxRetry: 50,
		Nodes:           make(map[string]*Node),
		Attrs:           make(map[string]string),
	}
}

// OutgoingEdges returns all edges from a given node ID
func (g *Graph) OutgoingEdges(nodeID string) []*Edge {
	var edges []*Edge
	for _, e := range g.Edges {
		if e.From == nodeID {
			edges = append(edges, e)
		}
	}
	return edges
}

// FindStartNode returns the start node (shape=Mdiamond or id="start"/"Start")
func (g *Graph) FindStartNode() (*Node, error) {
	for _, n := range g.Nodes {
		if n.Type == NodeTypeStart {
			return n, nil
		}
	}
	if n, ok := g.Nodes["start"]; ok {
		return n, nil
	}
	if n, ok := g.Nodes["Start"]; ok {
		return n, nil
	}
	return nil, fmt.Errorf("no start node found (need shape=Mdiamond or id=start)")
}

// Parser is the DOT DSL parser
type Parser struct {
	input  string
	pos    int
	line   int
	col    int
}

// NewParser creates a new parser
func NewParser(input string) *Parser {
	return &Parser{input: input, line: 1, col: 1}
}

// Parse parses a DOT graph definition and returns a Graph
func Parse(input string) (*Graph, error) {
	// Strip comments
	input = stripComments(input)

	p := NewParser(input)
	return p.parseGraph()
}

// stripComments removes // line comments and /* block */ comments
func stripComments(s string) string {
	var buf strings.Builder
	i := 0
	for i < len(s) {
		if i+1 < len(s) && s[i] == '/' && s[i+1] == '/' {
			// Line comment - skip until newline
			for i < len(s) && s[i] != '\n' {
				i++
			}
		} else if i+1 < len(s) && s[i] == '/' && s[i+1] == '*' {
			// Block comment - skip until */
			i += 2
			for i+1 < len(s) && !(s[i] == '*' && s[i+1] == '/') {
				i++
			}
			i += 2
		} else {
			buf.WriteByte(s[i])
			i++
		}
	}
	return buf.String()
}

func (p *Parser) peek() byte {
	if p.pos >= len(p.input) {
		return 0
	}
	return p.input[p.pos]
}

func (p *Parser) advance() byte {
	if p.pos >= len(p.input) {
		return 0
	}
	ch := p.input[p.pos]
	p.pos++
	if ch == '\n' {
		p.line++
		p.col = 1
	} else {
		p.col++
	}
	return ch
}

func (p *Parser) skipWhitespace() {
	for p.pos < len(p.input) && unicode.IsSpace(rune(p.input[p.pos])) {
		p.advance()
	}
}

func (p *Parser) parseIdentifier() string {
	p.skipWhitespace()
	start := p.pos
	for p.pos < len(p.input) {
		ch := rune(p.input[p.pos])
		if unicode.IsLetter(ch) || unicode.IsDigit(ch) || ch == '_' || ch == '-' || ch == '.' {
			p.pos++
		} else {
			break
		}
	}
	return p.input[start:p.pos]
}

func (p *Parser) parseString() (string, error) {
	p.skipWhitespace()
	if p.peek() != '"' {
		return "", fmt.Errorf("expected '\"' at line %d col %d", p.line, p.col)
	}
	p.advance() // consume "
	var buf strings.Builder
	for p.pos < len(p.input) {
		ch := p.advance()
		if ch == '"' {
			return buf.String(), nil
		}
		if ch == '\\' {
			next := p.advance()
			switch next {
			case 'n':
				buf.WriteByte('\n')
			case 't':
				buf.WriteByte('\t')
			case '"':
				buf.WriteByte('"')
			case '\\':
				buf.WriteByte('\\')
			default:
				buf.WriteByte('\\')
				buf.WriteByte(next)
			}
		} else {
			buf.WriteByte(ch)
		}
	}
	return "", fmt.Errorf("unterminated string at line %d", p.line)
}

func (p *Parser) parseValue() (string, error) {
	p.skipWhitespace()
	if p.peek() == '"' {
		return p.parseString()
	}
	// Bare value (number, boolean, duration, identifier)
	start := p.pos
	for p.pos < len(p.input) {
		ch := p.input[p.pos]
		if ch == ',' || ch == ']' || ch == ';' || ch == '\n' || ch == ' ' || ch == '\t' {
			break
		}
		p.pos++
	}
	return strings.TrimSpace(p.input[start:p.pos]), nil
}

func (p *Parser) parseAttrBlock() (map[string]string, error) {
	attrs := make(map[string]string)
	p.skipWhitespace()
	if p.peek() != '[' {
		return attrs, nil
	}
	p.advance() // consume [

	for {
		p.skipWhitespace()
		if p.peek() == ']' {
			p.advance()
			break
		}
		if p.peek() == 0 {
			return nil, fmt.Errorf("unterminated attribute block")
		}

		// Parse key
		key := p.parseIdentifier()
		if key == "" {
			// Maybe a comma or whitespace
			if p.peek() == ',' {
				p.advance()
				continue
			}
			if p.peek() == ']' {
				p.advance()
				break
			}
			return nil, fmt.Errorf("expected attribute key at line %d col %d, got '%c'", p.line, p.col, p.peek())
		}

		p.skipWhitespace()
		if p.peek() != '=' {
			return nil, fmt.Errorf("expected '=' after key '%s' at line %d col %d", key, p.line, p.col)
		}
		p.advance() // consume =

		val, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		attrs[key] = val

		p.skipWhitespace()
		if p.peek() == ',' {
			p.advance()
		}
	}
	return attrs, nil
}

func (p *Parser) parseGraph() (*Graph, error) {
	g := NewGraph()

	p.skipWhitespace()
	// Expect "digraph"
	kw := p.parseIdentifier()
	if kw != "digraph" {
		return nil, fmt.Errorf("expected 'digraph', got '%s'", kw)
	}

	p.skipWhitespace()
	// Graph ID (optional but usually present)
	if p.peek() != '{' {
		g.ID = p.parseIdentifier()
	}

	p.skipWhitespace()
	if p.peek() != '{' {
		return nil, fmt.Errorf("expected '{' to open graph body")
	}
	p.advance() // consume {

	// Node/edge defaults from default blocks
	nodeDefaults := make(map[string]string)
	edgeDefaults := make(map[string]string)

	// Parse statements until }
	for {
		p.skipWhitespace()
		if p.peek() == '}' {
			p.advance()
			break
		}
		if p.peek() == 0 {
			return nil, fmt.Errorf("unexpected end of input")
		}

		// Peek at identifier
		savedPos := p.pos
		savedLine := p.line
		savedCol := p.col
		ident := p.parseIdentifier()

		p.skipWhitespace()

		switch ident {
		case "graph":
			// graph [ ... ] or graph attrs
			if p.peek() == '[' {
				attrs, err := p.parseAttrBlock()
				if err != nil {
					return nil, err
				}
				applyGraphAttrs(g, attrs)
			} else if p.peek() == '=' {
				// graph.attr = val
				p.advance()
				val, err := p.parseValue()
				if err != nil {
					return nil, err
				}
				g.Attrs["graph"] = val
			}
		case "node":
			if p.peek() == '[' {
				attrs, err := p.parseAttrBlock()
				if err != nil {
					return nil, err
				}
				for k, v := range attrs {
					nodeDefaults[k] = v
				}
			}
		case "edge":
			if p.peek() == '[' {
				attrs, err := p.parseAttrBlock()
				if err != nil {
					return nil, err
				}
				for k, v := range attrs {
					edgeDefaults[k] = v
				}
			}
		case "subgraph":
			// Skip subgraph body for now (just consume it)
			subID := p.parseIdentifier()
			_ = subID
			p.skipWhitespace()
			if p.peek() == '{' {
				depth := 1
				p.advance()
				for depth > 0 && p.pos < len(p.input) {
					ch := p.advance()
					if ch == '{' {
						depth++
					} else if ch == '}' {
						depth--
					}
				}
			}
		case "rankdir", "ranksep", "nodesep", "splines", "bgcolor", "fontname", "fontsize":
			// Graph-level display attributes - consume value
			if p.peek() == '=' {
				p.advance()
				_, err := p.parseValue()
				if err != nil {
					return nil, err
				}
			}
		default:
			if ident == "" {
				// Skip unknown character
				p.advance()
				continue
			}

			// Could be: node stmt, edge stmt, or key=value
			if p.peek() == '=' {
				// Top-level key=value (like goal="...")
				p.advance()
				val, err := p.parseValue()
				if err != nil {
					return nil, err
				}
				g.Attrs[ident] = val
				applyGraphAttr(g, ident, val)
			} else if p.peek() == '[' {
				// Node statement with attributes
				attrs, err := p.parseAttrBlock()
				if err != nil {
					return nil, err
				}
				// Merge defaults then node-specific
				merged := copyMap(nodeDefaults)
				for k, v := range attrs {
					merged[k] = v
				}
				node := buildNode(ident, merged)
				g.Nodes[ident] = node
			} else if p.peek() == '-' && p.pos+1 < len(p.input) && p.input[p.pos+1] == '>' {
				// Edge statement: A -> B -> C [attrs]
				p.pos = savedPos
				p.line = savedLine
				p.col = savedCol

				edges, err := p.parseEdgeStmt(edgeDefaults)
				if err != nil {
					return nil, err
				}
				g.Edges = append(g.Edges, edges...)
			} else {
				// Bare node (no attributes) - register with defaults
				merged := copyMap(nodeDefaults)
				node := buildNode(ident, merged)
				g.Nodes[ident] = node
			}
		}

		// Skip optional semicolon
		p.skipWhitespace()
		if p.peek() == ';' {
			p.advance()
		}
	}

	return g, nil
}

func (p *Parser) parseEdgeStmt(edgeDefaults map[string]string) ([]*Edge, error) {
	// Parse: A -> B -> C [attrs]
	var nodeIDs []string

	id := p.parseIdentifier()
	nodeIDs = append(nodeIDs, id)

	for {
		p.skipWhitespace()
		if p.peek() != '-' {
			break
		}
		if p.pos+1 >= len(p.input) || p.input[p.pos+1] != '>' {
			break
		}
		p.pos += 2 // consume ->
		p.skipWhitespace()

		// The target may be a quoted string (label) or identifier
		var target string
		if p.peek() == '"' {
			var err error
			target, err = p.parseString()
			if err != nil {
				return nil, err
			}
		} else {
			target = p.parseIdentifier()
		}
		nodeIDs = append(nodeIDs, target)
	}

	// Parse optional attribute block
	attrs := make(map[string]string)
	for k, v := range edgeDefaults {
		attrs[k] = v
	}
	p.skipWhitespace()
	if p.peek() == '[' {
		extra, err := p.parseAttrBlock()
		if err != nil {
			return nil, err
		}
		for k, v := range extra {
			attrs[k] = v
		}
	}

	// Create edges for each consecutive pair
	var edges []*Edge
	for i := 0; i < len(nodeIDs)-1; i++ {
		edge := buildEdge(nodeIDs[i], nodeIDs[i+1], attrs)
		edges = append(edges, edge)
	}
	return edges, nil
}

func buildNode(id string, attrs map[string]string) *Node {
	n := &Node{
		ID:              id,
		Label:           getAttr(attrs, "label", id),
		Shape:           getAttr(attrs, "shape", "box"),
		Prompt:          getAttr(attrs, "prompt", ""),
		RetryTarget:     getAttr(attrs, "retry_target", ""),
		FallbackRetryTarget: getAttr(attrs, "fallback_retry_target", ""),
		Fidelity:        getAttr(attrs, "fidelity", ""),
		ThreadID:        getAttr(attrs, "thread_id", ""),
		Class:           getAttr(attrs, "class", ""),
		Timeout:         getAttr(attrs, "timeout", ""),
		LLMModel:        getAttr(attrs, "llm_model", ""),
		LLMProvider:     getAttr(attrs, "llm_provider", ""),
		ReasoningEffort: getAttr(attrs, "reasoning_effort", "high"),
		Attrs:           attrs,
	}

	n.MaxRetries = attrInt(attrs, "max_retries", 0)
	n.GoalGate = attrBool(attrs, "goal_gate", false)
	n.AutoStatus = attrBool(attrs, "auto_status", false)
	n.AllowPartial = attrBool(attrs, "allow_partial", false)

	// Resolve type from explicit type attr or shape
	if t := getAttr(attrs, "type", ""); t != "" {
		n.Type = NodeType(t)
	} else if nt, ok := shapeToType[n.Shape]; ok {
		n.Type = nt
	} else {
		n.Type = NodeTypeCodergen
	}

	return n
}

func buildEdge(from, to string, attrs map[string]string) *Edge {
	e := &Edge{
		From:        from,
		To:          to,
		Label:       getAttr(attrs, "label", ""),
		Condition:   getAttr(attrs, "condition", ""),
		Fidelity:    getAttr(attrs, "fidelity", ""),
		ThreadID:    getAttr(attrs, "thread_id", ""),
		Weight:      attrInt(attrs, "weight", 0),
		LoopRestart: attrBool(attrs, "loop_restart", false),
	}
	return e
}

func applyGraphAttrs(g *Graph, attrs map[string]string) {
	for k, v := range attrs {
		applyGraphAttr(g, k, v)
	}
}

func applyGraphAttr(g *Graph, k, v string) {
	switch k {
	case "goal":
		g.Goal = v
	case "label":
		g.Label = v
	case "model_stylesheet":
		g.ModelStylesheet = v
	case "default_max_retry":
		if i, err := strconv.Atoi(v); err == nil {
			g.DefaultMaxRetry = i
		}
	case "retry_target":
		g.RetryTarget = v
	case "fallback_retry_target":
		g.FallbackRetryTarget = v
	case "default_fidelity":
		g.DefaultFidelity = v
	}
}

func getAttr(attrs map[string]string, key, def string) string {
	if v, ok := attrs[key]; ok {
		return v
	}
	return def
}

func attrInt(attrs map[string]string, key string, def int) int {
	if v, ok := attrs[key]; ok {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return def
}

func attrBool(attrs map[string]string, key string, def bool) bool {
	if v, ok := attrs[key]; ok {
		switch strings.ToLower(v) {
		case "true", "1", "yes":
			return true
		case "false", "0", "no":
			return false
		}
	}
	return def
}

func copyMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// NormalizeLabel normalizes edge labels for matching (lowercase, trim, strip accelerators)
func NormalizeLabel(label string) string {
	label = strings.ToLower(strings.TrimSpace(label))
	// Strip accelerator prefixes: [Y] , Y) , Y -
	re := regexp.MustCompile(`^\[[a-z]\]\s*|^[a-z]\)\s*|^[a-z]\s*-\s*`)
	label = re.ReplaceAllString(label, "")
	return strings.TrimSpace(label)
}
