// Package handlers implements the node handlers for the Attractor pipeline engine.
package handlers

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	pctx "github.com/attractor/attractor/internal/context"
	"github.com/attractor/attractor/internal/llm"
	"github.com/attractor/attractor/internal/parser"
)

// Handler is the interface all node handlers must implement
type Handler interface {
	Execute(ctx context.Context, node *parser.Node, pipeCtx *pctx.Context, graph *parser.Graph, logsRoot string) (*pctx.Outcome, error)
}

// Registry maps type strings to handler instances
type Registry struct {
	handlers       map[parser.NodeType]Handler
	defaultHandler Handler
}

// NewRegistry creates a Registry with all built-in handlers registered
func NewRegistry(llmClient *llm.Client, defaultModel string) *Registry {
	r := &Registry{
		handlers: make(map[parser.NodeType]Handler),
	}

	codergen := &CodergenHandler{Client: llmClient, DefaultModel: defaultModel}
	r.defaultHandler = codergen

	r.Register(parser.NodeTypeStart, &StartHandler{})
	r.Register(parser.NodeTypeExit, &ExitHandler{})
	r.Register(parser.NodeTypeCodergen, codergen)
	r.Register(parser.NodeTypeConditional, &ConditionalHandler{})
	r.Register(parser.NodeTypeWaitHuman, &WaitHumanHandler{})
	r.Register(parser.NodeTypeParallel, &ParallelHandler{})
	r.Register(parser.NodeTypeFanIn, &FanInHandler{})
	r.Register(parser.NodeTypeTool, &ToolHandler{})
	r.Register(parser.NodeTypeManagerLoop, &ManagerLoopHandler{})

	return r
}

// Register registers a handler for a type
func (r *Registry) Register(t parser.NodeType, h Handler) {
	r.handlers[t] = h
}

// Resolve returns the appropriate handler for a node
func (r *Registry) Resolve(node *parser.Node) Handler {
	if h, ok := r.handlers[node.Type]; ok {
		return h
	}
	return r.defaultHandler
}

// ---------------------------------------------------------------------------
// StartHandler
// ---------------------------------------------------------------------------

// StartHandler is a no-op for the pipeline entry point
type StartHandler struct{}

func (h *StartHandler) Execute(_ context.Context, node *parser.Node, _ *pctx.Context, _ *parser.Graph, _ string) (*pctx.Outcome, error) {
	return &pctx.Outcome{Status: pctx.StatusSuccess, Notes: "Pipeline started"}, nil
}

// ---------------------------------------------------------------------------
// ExitHandler
// ---------------------------------------------------------------------------

// ExitHandler is a no-op for the pipeline exit point
type ExitHandler struct{}

func (h *ExitHandler) Execute(_ context.Context, node *parser.Node, _ *pctx.Context, _ *parser.Graph, _ string) (*pctx.Outcome, error) {
	return &pctx.Outcome{Status: pctx.StatusSuccess, Notes: "Pipeline exited"}, nil
}

// ---------------------------------------------------------------------------
// CodergenHandler
// ---------------------------------------------------------------------------

// CodergenHandler invokes the LLM for AI task nodes
type CodergenHandler struct {
	Client       *llm.Client
	DefaultModel string
}

func (h *CodergenHandler) Execute(ctx context.Context, node *parser.Node, pipeCtx *pctx.Context, graph *parser.Graph, logsRoot string) (*pctx.Outcome, error) {
	// Build prompt
	prompt := node.Prompt
	if prompt == "" {
		prompt = node.Label
	}
	// Expand $goal
	goal := pipeCtx.GetString("graph.goal", graph.Goal)
	prompt = strings.ReplaceAll(prompt, "$goal", goal)

	// Create stage directory
	stageDir := filepath.Join(logsRoot, node.ID)
	if err := os.MkdirAll(stageDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create stage dir: %w", err)
	}

	// Write prompt to logs
	if err := os.WriteFile(filepath.Join(stageDir, "prompt.md"), []byte(prompt), 0644); err != nil {
		return nil, fmt.Errorf("failed to write prompt: %w", err)
	}

	// If no LLM client, simulate
	if h.Client == nil {
		responseText := fmt.Sprintf("[Simulated] Response for stage: %s\nPrompt: %s", node.ID, prompt)
		_ = os.WriteFile(filepath.Join(stageDir, "response.md"), []byte(responseText), 0644)
		return &pctx.Outcome{
			Status: pctx.StatusSuccess,
			Notes:  "Stage completed (simulated): " + node.ID,
			ContextUpdates: map[string]string{
				"last_stage":    node.ID,
				"last_response": truncate(responseText, 200),
			},
		}, nil
	}

	// Determine model
	model := node.LLMModel
	if model == "" {
		model = pipeCtx.GetString("pipeline.model", h.DefaultModel)
	}
	if model == "" {
		model = "openai/gpt-4o"
	}

	// Build messages
	messages := []llm.Message{
		{Role: "system", Content: "You are a helpful AI assistant in a software pipeline. Complete the following task carefully and thoroughly."},
		{Role: "user", Content: prompt},
	}

	// Add context from previous stages
	if lastResp := pipeCtx.GetString("last_response", ""); lastResp != "" {
		messages = append([]llm.Message{
			{Role: "system", Content: "You are a helpful AI assistant in a software pipeline."},
			{Role: "assistant", Content: "Previous stage result: " + lastResp},
			{Role: "user", Content: prompt},
		}, messages[2:]...)
	}

	req := llm.ChatRequest{
		Model:    model,
		Messages: messages,
	}

	startTime := time.Now()
	resp, err := h.Client.Complete(ctx, req)
	elapsed := time.Since(startTime)

	if err != nil {
		_ = os.WriteFile(filepath.Join(stageDir, "error.txt"), []byte(err.Error()), 0644)
		return &pctx.Outcome{
			Status:        pctx.StatusFail,
			FailureReason: fmt.Sprintf("LLM call failed: %v", err),
		}, nil
	}

	responseText := resp.GetText()
	_ = os.WriteFile(filepath.Join(stageDir, "response.md"), []byte(responseText), 0644)

	// Write metadata
	meta := fmt.Sprintf("Model: %s\nInput tokens: %d\nOutput tokens: %d\nTotal tokens: %d\nDuration: %s\n",
		resp.Model, resp.Usage.PromptTokens, resp.Usage.CompletionTokens, resp.Usage.TotalTokens, elapsed.Round(time.Millisecond))
	_ = os.WriteFile(filepath.Join(stageDir, "meta.txt"), []byte(meta), 0644)

	return &pctx.Outcome{
		Status: pctx.StatusSuccess,
		Notes:  fmt.Sprintf("Stage completed: %s (model=%s, tokens=%d, duration=%s)", node.ID, resp.Model, resp.Usage.TotalTokens, elapsed.Round(time.Millisecond)),
		ContextUpdates: map[string]string{
			"last_stage":               node.ID,
			"last_response":            truncate(responseText, 200),
			"last_model":               resp.Model,
			"last_tokens_prompt":       fmt.Sprintf("%d", resp.Usage.PromptTokens),
			"last_tokens_completion":   fmt.Sprintf("%d", resp.Usage.CompletionTokens),
			"last_tokens_total":        fmt.Sprintf("%d", resp.Usage.TotalTokens),
		},
	}, nil
}

// ---------------------------------------------------------------------------
// ConditionalHandler
// ---------------------------------------------------------------------------

// ConditionalHandler is a no-op; routing is done by the engine's edge selection
type ConditionalHandler struct{}

func (h *ConditionalHandler) Execute(_ context.Context, node *parser.Node, _ *pctx.Context, _ *parser.Graph, _ string) (*pctx.Outcome, error) {
	return &pctx.Outcome{
		Status: pctx.StatusSuccess,
		Notes:  "Conditional node evaluated: " + node.ID,
	}, nil
}

// ---------------------------------------------------------------------------
// WaitHumanHandler
// ---------------------------------------------------------------------------

// WaitHumanHandler blocks until a human selects an option (non-interactive: auto-selects first)
type WaitHumanHandler struct {
	// In interactive mode, this would read from stdin or a web UI
}

func (h *WaitHumanHandler) Execute(_ context.Context, node *parser.Node, pipeCtx *pctx.Context, graph *parser.Graph, logsRoot string) (*pctx.Outcome, error) {
	edges := graph.OutgoingEdges(node.ID)
	if len(edges) == 0 {
		return &pctx.Outcome{
			Status:        pctx.StatusFail,
			FailureReason: "No outgoing edges for human gate",
		}, nil
	}

	// Check if a human answer was pre-set in context (for UI-driven runs)
	if answer := pipeCtx.GetString("human.gate.answer."+node.ID, ""); answer != "" {
		for _, edge := range edges {
			if parser.NormalizeLabel(edge.Label) == parser.NormalizeLabel(answer) {
				return &pctx.Outcome{
					Status:           pctx.StatusSuccess,
					SuggestedNextIDs: []string{edge.To},
					ContextUpdates: map[string]string{
						"human.gate.selected": edge.Label,
						"human.gate.label":    edge.Label,
					},
				}, nil
			}
		}
	}

	// Auto-select first option (non-interactive fallback)
	first := edges[0]
	return &pctx.Outcome{
		Status:           pctx.StatusSuccess,
		SuggestedNextIDs: []string{first.To},
		ContextUpdates: map[string]string{
			"human.gate.selected": first.Label,
			"human.gate.label":    first.Label,
		},
		Notes: fmt.Sprintf("Human gate auto-selected: %s", first.Label),
	}, nil
}

// ---------------------------------------------------------------------------
// ParallelHandler
// ---------------------------------------------------------------------------

// ParallelHandler fans out execution to multiple branches concurrently
type ParallelHandler struct{}

func (h *ParallelHandler) Execute(ctx context.Context, node *parser.Node, pipeCtx *pctx.Context, graph *parser.Graph, logsRoot string) (*pctx.Outcome, error) {
	// Basic implementation - just proceed (engine handles actual parallel routing)
	return &pctx.Outcome{
		Status: pctx.StatusSuccess,
		Notes:  "Parallel fan-out: " + node.ID,
	}, nil
}

// ---------------------------------------------------------------------------
// FanInHandler
// ---------------------------------------------------------------------------

// FanInHandler consolidates results from a parallel node
type FanInHandler struct{}

func (h *FanInHandler) Execute(_ context.Context, node *parser.Node, pipeCtx *pctx.Context, graph *parser.Graph, logsRoot string) (*pctx.Outcome, error) {
	return &pctx.Outcome{
		Status: pctx.StatusSuccess,
		Notes:  "Fan-in completed: " + node.ID,
	}, nil
}

// ---------------------------------------------------------------------------
// ToolHandler
// ---------------------------------------------------------------------------

// ToolHandler executes an external tool/shell command
type ToolHandler struct{}

func (h *ToolHandler) Execute(ctx context.Context, node *parser.Node, pipeCtx *pctx.Context, graph *parser.Graph, logsRoot string) (*pctx.Outcome, error) {
	command := node.Attrs["tool_command"]
	if command == "" {
		return &pctx.Outcome{
			Status:        pctx.StatusFail,
			FailureReason: "No tool_command specified",
		}, nil
	}

	// Create stage dir
	stageDir := filepath.Join(logsRoot, node.ID)
	_ = os.MkdirAll(stageDir, 0755)

	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	output, err := cmd.CombinedOutput()
	if err != nil {
		_ = os.WriteFile(filepath.Join(stageDir, "output.txt"), output, 0644)
		return &pctx.Outcome{
			Status:        pctx.StatusFail,
			FailureReason: fmt.Sprintf("Command failed: %v\n%s", err, string(output)),
		}, nil
	}

	_ = os.WriteFile(filepath.Join(stageDir, "output.txt"), output, 0644)
	return &pctx.Outcome{
		Status: pctx.StatusSuccess,
		Notes:  "Tool completed: " + command,
		ContextUpdates: map[string]string{
			"tool.output": truncate(string(output), 500),
		},
	}, nil
}

// ---------------------------------------------------------------------------
// ManagerLoopHandler
// ---------------------------------------------------------------------------

// ManagerLoopHandler orchestrates sprint-based iteration
type ManagerLoopHandler struct{}

func (h *ManagerLoopHandler) Execute(_ context.Context, node *parser.Node, pipeCtx *pctx.Context, graph *parser.Graph, logsRoot string) (*pctx.Outcome, error) {
	return &pctx.Outcome{
		Status: pctx.StatusSuccess,
		Notes:  "Manager loop executed: " + node.ID,
	}, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
