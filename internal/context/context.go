// Package context implements the pipeline run context and outcome types.
package context

import (
	"encoding/json"
	"sync"
	"time"
)

// StageStatus represents the outcome status of a node handler
type StageStatus string

const (
	StatusSuccess        StageStatus = "success"
	StatusPartialSuccess StageStatus = "partial_success"
	StatusRetry          StageStatus = "retry"
	StatusFail           StageStatus = "fail"
	StatusSkipped        StageStatus = "skipped"
)

// Outcome is the result of executing a node handler
type Outcome struct {
	Status           StageStatus       `json:"status"`
	PreferredLabel   string            `json:"preferred_label,omitempty"`
	SuggestedNextIDs []string          `json:"suggested_next_ids,omitempty"`
	ContextUpdates   map[string]string `json:"context_updates,omitempty"`
	Notes            string            `json:"notes,omitempty"`
	FailureReason    string            `json:"failure_reason,omitempty"`
}

// Context is a thread-safe key-value store shared across all stages
type Context struct {
	mu     sync.RWMutex
	values map[string]string
	logs   []string
}

// NewContext creates a new empty Context
func NewContext() *Context {
	return &Context{
		values: make(map[string]string),
	}
}

// Set sets a key-value pair in the context
func (c *Context) Set(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.values[key] = value
}

// Get returns a value from the context
func (c *Context) Get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.values[key]
	return v, ok
}

// GetString returns a value with a default
func (c *Context) GetString(key, def string) string {
	if v, ok := c.Get(key); ok {
		return v
	}
	return def
}

// AppendLog appends a log entry
func (c *Context) AppendLog(entry string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.logs = append(c.logs, entry)
}

// Logs returns all log entries
func (c *Context) Logs() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]string, len(c.logs))
	copy(out, c.logs)
	return out
}

// Snapshot returns a serializable copy of the context values
func (c *Context) Snapshot() map[string]string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]string, len(c.values))
	for k, v := range c.values {
		out[k] = v
	}
	return out
}

// Clone creates a deep copy of the context (for parallel branch isolation)
func (c *Context) Clone() *Context {
	c.mu.RLock()
	defer c.mu.RUnlock()
	nc := &Context{
		values: make(map[string]string, len(c.values)),
		logs:   make([]string, len(c.logs)),
	}
	for k, v := range c.values {
		nc.values[k] = v
	}
	copy(nc.logs, c.logs)
	return nc
}

// ApplyUpdates merges a map of updates into the context
func (c *Context) ApplyUpdates(updates map[string]string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, v := range updates {
		c.values[k] = v
	}
}

// Checkpoint is a serializable snapshot of execution state
type Checkpoint struct {
	Timestamp      time.Time         `json:"timestamp"`
	CurrentNode    string            `json:"current_node"`
	CompletedNodes []string          `json:"completed_nodes"`
	NodeRetries    map[string]int    `json:"node_retries"`
	ContextValues  map[string]string `json:"context"`
	Logs           []string          `json:"logs"`
}

// NewCheckpoint creates a checkpoint from current state
func NewCheckpoint(ctx *Context, currentNode string, completedNodes []string, nodeRetries map[string]int) *Checkpoint {
	retries := make(map[string]int, len(nodeRetries))
	for k, v := range nodeRetries {
		retries[k] = v
	}
	return &Checkpoint{
		Timestamp:      time.Now(),
		CurrentNode:    currentNode,
		CompletedNodes: completedNodes,
		NodeRetries:    retries,
		ContextValues:  ctx.Snapshot(),
		Logs:           ctx.Logs(),
	}
}

// ToJSON serializes the checkpoint to JSON bytes
func (cp *Checkpoint) ToJSON() ([]byte, error) {
	return json.Marshal(cp)
}

// CheckpointFromJSON deserializes a checkpoint from JSON bytes
func CheckpointFromJSON(data []byte) (*Checkpoint, error) {
	var cp Checkpoint
	err := json.Unmarshal(data, &cp)
	return &cp, err
}

// RestoreContext restores a context from a checkpoint
func (cp *Checkpoint) RestoreContext() *Context {
	ctx := NewContext()
	ctx.ApplyUpdates(cp.ContextValues)
	for _, l := range cp.Logs {
		ctx.AppendLog(l)
	}
	return ctx
}
