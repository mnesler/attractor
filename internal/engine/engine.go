// Package engine implements the Attractor pipeline execution engine.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	pctx "github.com/attractor/attractor/internal/context"
	"github.com/attractor/attractor/internal/handlers"
	"github.com/attractor/attractor/internal/parser"
)

// RunStatus represents the overall status of a pipeline run
type RunStatus string

const (
	RunStatusRunning   RunStatus = "running"
	RunStatusSuccess   RunStatus = "success"
	RunStatusFailed    RunStatus = "failed"
	RunStatusCancelled RunStatus = "cancelled"
)

// NodeLog captures execution details for a single node run
type NodeLog struct {
	NodeID       string          `json:"node_id"`
	NodeLabel    string          `json:"node_label"`
	NodeType     string          `json:"node_type"`
	Status       pctx.StageStatus `json:"status"`
	StartTime    time.Time       `json:"start_time"`
	EndTime      time.Time       `json:"end_time"`
	DurationMs   int64           `json:"duration_ms"`
	AttemptNum   int             `json:"attempt_num"`
	Notes        string          `json:"notes,omitempty"`
	FailureReason string         `json:"failure_reason,omitempty"`
	Model        string          `json:"model,omitempty"`
	PromptTokens int             `json:"prompt_tokens,omitempty"`
	CompletionTokens int         `json:"completion_tokens,omitempty"`
	TotalTokens  int             `json:"total_tokens,omitempty"`
	InputText    string          `json:"input_text,omitempty"`
	OutputText   string          `json:"output_text,omitempty"`
}

// RunLog is the complete log of a pipeline run
type RunLog struct {
	RunID       string       `json:"run_id"`
	PipelineID  string       `json:"pipeline_id"`
	GraphID     string       `json:"graph_id"`
	GraphGoal   string       `json:"graph_goal"`
	Model       string       `json:"model"`
	Status      RunStatus    `json:"status"`
	StartTime   time.Time    `json:"start_time"`
	EndTime     time.Time    `json:"end_time,omitempty"`
	DurationMs  int64        `json:"duration_ms,omitempty"`
	NodeLogs    []*NodeLog   `json:"node_logs"`
	TotalPromptTokens     int `json:"total_prompt_tokens"`
	TotalCompletionTokens int `json:"total_completion_tokens"`
	TotalTokens           int `json:"total_tokens"`
	ErrorMessage string      `json:"error_message,omitempty"`
	LogsRoot    string       `json:"logs_root"`
}

// Engine executes pipelines
type Engine struct {
	registry *handlers.Registry
	logsRoot string
}

// NewEngine creates a new execution engine
func NewEngine(registry *handlers.Registry, logsRoot string) *Engine {
	return &Engine{
		registry: registry,
		logsRoot: logsRoot,
	}
}

// BackoffConfig controls retry delay calculation
type BackoffConfig struct {
	InitialDelayMs int
	BackoffFactor  float64
	MaxDelayMs     int
	Jitter         bool
}

// defaultBackoff is the standard backoff config
var defaultBackoff = BackoffConfig{
	InitialDelayMs: 200,
	BackoffFactor:  2.0,
	MaxDelayMs:     60000,
	Jitter:         true,
}

// delayForAttempt calculates the retry delay for a given attempt
func delayForAttempt(attempt int, cfg BackoffConfig) time.Duration {
	delay := float64(cfg.InitialDelayMs) * math.Pow(cfg.BackoffFactor, float64(attempt-1))
	if delay > float64(cfg.MaxDelayMs) {
		delay = float64(cfg.MaxDelayMs)
	}
	if cfg.Jitter {
		delay = delay * (0.5 + rand.Float64())
	}
	return time.Duration(delay) * time.Millisecond
}

// Run executes a pipeline graph and returns the run log
func (e *Engine) Run(ctx context.Context, graph *parser.Graph, runID, pipelineID, model string) (*RunLog, error) {
	runLog := &RunLog{
		RunID:      runID,
		PipelineID: pipelineID,
		GraphID:    graph.ID,
		GraphGoal:  graph.Goal,
		Model:      model,
		Status:     RunStatusRunning,
		StartTime:  time.Now(),
	}

	// Create run logs directory
	logsRoot := filepath.Join(e.logsRoot, runID)
	if err := os.MkdirAll(logsRoot, 0755); err != nil {
		return nil, fmt.Errorf("failed to create logs dir: %w", err)
	}
	runLog.LogsRoot = logsRoot

	// Initialize context
	pipeCtx := pctx.NewContext()
	pipeCtx.Set("graph.goal", graph.Goal)
	pipeCtx.Set("graph.id", graph.ID)
	pipeCtx.Set("run.id", runID)
	pipeCtx.Set("pipeline.id", pipelineID)
	pipeCtx.Set("pipeline.model", model)

	// Find start node
	startNode, err := graph.FindStartNode()
	if err != nil {
		runLog.Status = RunStatusFailed
		runLog.ErrorMessage = err.Error()
		return runLog, err
	}

	// Execution state
	completedNodes := []string{}
	nodeOutcomes := map[string]*pctx.Outcome{}
	nodeRetries := map[string]int{}
	currentNode := startNode

	// Main execution loop
	for {
		// Check context cancellation
		select {
		case <-ctx.Done():
			runLog.Status = RunStatusCancelled
			runLog.EndTime = time.Now()
			runLog.DurationMs = runLog.EndTime.Sub(runLog.StartTime).Milliseconds()
			_ = e.saveRunLog(runLog, logsRoot)
			return runLog, ctx.Err()
		default:
		}

		// Check for terminal node (exit)
		if currentNode.Type == parser.NodeTypeExit {
			// Check goal gates
			if failedGate := e.checkGoalGates(graph, nodeOutcomes); failedGate != nil {
				retryTarget := e.resolveRetryTarget(failedGate, graph)
				if retryTarget != "" {
					if n, ok := graph.Nodes[retryTarget]; ok {
						currentNode = n
						continue
					}
				}
				runLog.Status = RunStatusFailed
				runLog.ErrorMessage = fmt.Sprintf("Goal gate unsatisfied for node %s and no retry target", failedGate.ID)
				break
			}
			// All goal gates passed - execute exit and break
			handler := e.registry.Resolve(currentNode)
			_, _ = handler.Execute(ctx, currentNode, pipeCtx, graph, logsRoot)
			runLog.Status = RunStatusSuccess
			break
		}

		// Determine max attempts for this node
		maxRetries := currentNode.MaxRetries
		if maxRetries == 0 {
			maxRetries = 0 // no retries by default (1 attempt)
		}
		maxAttempts := maxRetries + 1
		if graph.DefaultMaxRetry > 0 && maxRetries == 0 {
			// Only apply global default if node doesn't have explicit 0
			// (we use 0 as "no retries", not "use default")
			// For nodes that truly want retries, they set max_retries explicitly
		}

		pipeCtx.Set("current_node", currentNode.ID)

		// Execute with retry
		var finalOutcome *pctx.Outcome
		for attempt := 1; attempt <= maxAttempts; attempt++ {
			nodeLog := &NodeLog{
				NodeID:    currentNode.ID,
				NodeLabel: currentNode.Label,
				NodeType:  string(currentNode.Type),
				StartTime: time.Now(),
				AttemptNum: attempt,
			}

			handler := e.registry.Resolve(currentNode)
			outcome, execErr := handler.Execute(ctx, currentNode, pipeCtx, graph, logsRoot)
			nodeLog.EndTime = time.Now()
			nodeLog.DurationMs = nodeLog.EndTime.Sub(nodeLog.StartTime).Milliseconds()

			if execErr != nil {
				outcome = &pctx.Outcome{
					Status:        pctx.StatusFail,
					FailureReason: execErr.Error(),
				}
			}

			nodeLog.Status = outcome.Status
			nodeLog.Notes = outcome.Notes
			nodeLog.FailureReason = outcome.FailureReason

			// Extract token counts and input/output text from context updates
			if outcome.ContextUpdates != nil {
				if m := outcome.ContextUpdates["last_model"]; m != "" {
					nodeLog.Model = m
				}
				nodeLog.PromptTokens = atoi(outcome.ContextUpdates["last_tokens_prompt"])
				nodeLog.CompletionTokens = atoi(outcome.ContextUpdates["last_tokens_completion"])
				nodeLog.TotalTokens = atoi(outcome.ContextUpdates["last_tokens_total"])
				runLog.TotalPromptTokens += nodeLog.PromptTokens
				runLog.TotalCompletionTokens += nodeLog.CompletionTokens
				runLog.TotalTokens += nodeLog.TotalTokens
				nodeLog.InputText = outcome.ContextUpdates["input_text"]
				nodeLog.OutputText = outcome.ContextUpdates["output_text"]
			}

			runLog.NodeLogs = append(runLog.NodeLogs, nodeLog)

			if outcome.Status == pctx.StatusSuccess || outcome.Status == pctx.StatusPartialSuccess {
				nodeRetries[currentNode.ID] = 0
				finalOutcome = outcome
				break
			}

			if outcome.Status == pctx.StatusRetry {
				nodeRetries[currentNode.ID] = attempt
				if attempt < maxAttempts {
					delay := delayForAttempt(attempt, defaultBackoff)
					select {
					case <-ctx.Done():
						finalOutcome = &pctx.Outcome{Status: pctx.StatusFail, FailureReason: "cancelled during retry"}
						goto doneRetry
					case <-time.After(delay):
					}
					continue
				}
				if currentNode.AllowPartial {
					finalOutcome = &pctx.Outcome{Status: pctx.StatusPartialSuccess, Notes: "retries exhausted, partial accepted"}
				} else {
					finalOutcome = &pctx.Outcome{Status: pctx.StatusFail, FailureReason: "max retries exceeded"}
				}
				break
			}

			if outcome.Status == pctx.StatusFail {
				finalOutcome = outcome
				break
			}

			finalOutcome = outcome
			break
		}
	doneRetry:

		// Record completion
		completedNodes = append(completedNodes, currentNode.ID)
		nodeOutcomes[currentNode.ID] = finalOutcome

		// Apply context updates
		if finalOutcome.ContextUpdates != nil {
			pipeCtx.ApplyUpdates(finalOutcome.ContextUpdates)
		}
		pipeCtx.Set("outcome", string(finalOutcome.Status))
		if finalOutcome.PreferredLabel != "" {
			pipeCtx.Set("preferred_label", finalOutcome.PreferredLabel)
		}

		// Save checkpoint
		cp := pctx.NewCheckpoint(pipeCtx, currentNode.ID, completedNodes, nodeRetries)
		cpData, _ := cp.ToJSON()
		_ = os.WriteFile(filepath.Join(logsRoot, "checkpoint.json"), cpData, 0644)

		// Select next edge
		nextEdge := e.selectEdge(currentNode, finalOutcome, pipeCtx, graph)
		if nextEdge == nil {
			if finalOutcome.Status == pctx.StatusFail {
				// Try failure routing
				if t := currentNode.RetryTarget; t != "" {
					if n, ok := graph.Nodes[t]; ok {
						currentNode = n
						continue
					}
				}
				if t := currentNode.FallbackRetryTarget; t != "" {
					if n, ok := graph.Nodes[t]; ok {
						currentNode = n
						continue
					}
				}
				runLog.Status = RunStatusFailed
				runLog.ErrorMessage = fmt.Sprintf("Stage %s failed with no outgoing fail edge: %s", currentNode.ID, finalOutcome.FailureReason)
				break
			}
			runLog.Status = RunStatusSuccess
			break
		}

		// Handle loop_restart
		if nextEdge.LoopRestart {
			// For now, just continue from the target node
			if n, ok := graph.Nodes[nextEdge.To]; ok {
				currentNode = n
				continue
			}
		}

		// Advance to next node
		nextNode, ok := graph.Nodes[nextEdge.To]
		if !ok {
			runLog.Status = RunStatusFailed
			runLog.ErrorMessage = fmt.Sprintf("Next node %s not found in graph", nextEdge.To)
			break
		}
		currentNode = nextNode

		// Save run log after each step
		_ = e.saveRunLog(runLog, logsRoot)
	}

	runLog.EndTime = time.Now()
	runLog.DurationMs = runLog.EndTime.Sub(runLog.StartTime).Milliseconds()
	_ = e.saveRunLog(runLog, logsRoot)

	return runLog, nil
}

// selectEdge implements the 5-step edge selection algorithm from the spec
func (e *Engine) selectEdge(node *parser.Node, outcome *pctx.Outcome, pipeCtx *pctx.Context, graph *parser.Graph) *parser.Edge {
	edges := graph.OutgoingEdges(node.ID)
	if len(edges) == 0 {
		return nil
	}

	// Step 1: Condition-matching edges
	var conditionMatched []*parser.Edge
	for _, edge := range edges {
		if edge.Condition != "" {
			if evaluateCondition(edge.Condition, outcome, pipeCtx) {
				conditionMatched = append(conditionMatched, edge)
			}
		}
	}
	if len(conditionMatched) > 0 {
		return bestByWeightThenLexical(conditionMatched)
	}

	// Step 2: Preferred label
	if outcome.PreferredLabel != "" {
		norm := parser.NormalizeLabel(outcome.PreferredLabel)
		for _, edge := range edges {
			if parser.NormalizeLabel(edge.Label) == norm {
				return edge
			}
		}
	}

	// Step 3: Suggested next IDs
	if len(outcome.SuggestedNextIDs) > 0 {
		for _, suggestedID := range outcome.SuggestedNextIDs {
			for _, edge := range edges {
				if edge.To == suggestedID {
					return edge
				}
			}
		}
	}

	// Step 4 & 5: Weight with lexical tiebreak (unconditional edges only)
	var unconditional []*parser.Edge
	for _, edge := range edges {
		if edge.Condition == "" {
			unconditional = append(unconditional, edge)
		}
	}
	if len(unconditional) > 0 {
		return bestByWeightThenLexical(unconditional)
	}

	return bestByWeightThenLexical(edges)
}

// bestByWeightThenLexical sorts edges by weight desc, then by target ID asc
func bestByWeightThenLexical(edges []*parser.Edge) *parser.Edge {
	if len(edges) == 0 {
		return nil
	}
	sorted := make([]*parser.Edge, len(edges))
	copy(sorted, edges)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Weight != sorted[j].Weight {
			return sorted[i].Weight > sorted[j].Weight
		}
		return sorted[i].To < sorted[j].To
	})
	return sorted[0]
}

// evaluateCondition evaluates a condition expression against the current outcome and context
func evaluateCondition(condition string, outcome *pctx.Outcome, pipeCtx *pctx.Context) bool {
	condition = strings.TrimSpace(strings.ToLower(condition))

	// Simple condition evaluation: "outcome=success", "outcome!=success", etc.
	if strings.HasPrefix(condition, "outcome=") {
		expected := strings.TrimPrefix(condition, "outcome=")
		return strings.ToLower(string(outcome.Status)) == expected
	}
	if strings.HasPrefix(condition, "outcome!=") {
		expected := strings.TrimPrefix(condition, "outcome!=")
		return strings.ToLower(string(outcome.Status)) != expected
	}

	// Context key comparisons: "key=value", "key!=value"
	parts := strings.SplitN(condition, "!=", 2)
	if len(parts) == 2 {
		key := strings.TrimSpace(parts[0])
		expected := strings.TrimSpace(parts[1])
		actual := pipeCtx.GetString(key, "")
		return actual != expected
	}
	parts = strings.SplitN(condition, "=", 2)
	if len(parts) == 2 {
		key := strings.TrimSpace(parts[0])
		expected := strings.TrimSpace(parts[1])
		actual := pipeCtx.GetString(key, "")
		return actual == expected
	}

	return false
}

// checkGoalGates checks if all goal gates are satisfied
func (e *Engine) checkGoalGates(graph *parser.Graph, nodeOutcomes map[string]*pctx.Outcome) *parser.Node {
	for nodeID, outcome := range nodeOutcomes {
		node, ok := graph.Nodes[nodeID]
		if !ok {
			continue
		}
		if node.GoalGate {
			if outcome.Status != pctx.StatusSuccess && outcome.Status != pctx.StatusPartialSuccess {
				return node
			}
		}
	}
	return nil
}

// resolveRetryTarget finds a retry target node ID
func (e *Engine) resolveRetryTarget(node *parser.Node, graph *parser.Graph) string {
	if node.RetryTarget != "" {
		return node.RetryTarget
	}
	if node.FallbackRetryTarget != "" {
		return node.FallbackRetryTarget
	}
	if graph.RetryTarget != "" {
		return graph.RetryTarget
	}
	return graph.FallbackRetryTarget
}

// saveRunLog saves the run log to disk
func (e *Engine) saveRunLog(runLog *RunLog, logsRoot string) error {
	data, err := json.MarshalIndent(runLog, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(logsRoot, "run.json"), data, 0644)
}

func atoi(s string) int {
	if s == "" {
		return 0
	}
	var n int
	fmt.Sscanf(s, "%d", &n)
	return n
}
