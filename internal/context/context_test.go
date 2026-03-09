package context_test

import (
	"sync"
	"testing"

	pctx "github.com/attractor/attractor/internal/context"
)

// ---------- Context basic operations ----------

func TestContext_SetGet(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.Set("key", "value")

	v, ok := ctx.Get("key")
	if !ok {
		t.Fatal("Get() ok = false, want true")
	}
	if v != "value" {
		t.Errorf("Get() = %q, want %q", v, "value")
	}
}

func TestContext_GetMissing(t *testing.T) {
	ctx := pctx.NewContext()
	_, ok := ctx.Get("nonexistent")
	if ok {
		t.Error("Get() ok = true for missing key, want false")
	}
}

func TestContext_GetString_Default(t *testing.T) {
	ctx := pctx.NewContext()
	got := ctx.GetString("missing", "fallback")
	if got != "fallback" {
		t.Errorf("GetString() = %q, want %q", got, "fallback")
	}
}

func TestContext_GetString_Present(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.Set("k", "v")
	got := ctx.GetString("k", "fallback")
	if got != "v" {
		t.Errorf("GetString() = %q, want %q", got, "v")
	}
}

func TestContext_Overwrite(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.Set("x", "first")
	ctx.Set("x", "second")
	got := ctx.GetString("x", "")
	if got != "second" {
		t.Errorf("overwritten value = %q, want %q", got, "second")
	}
}

// ---------- ApplyUpdates ----------

func TestContext_ApplyUpdates(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.Set("existing", "old")

	ctx.ApplyUpdates(map[string]string{
		"existing": "new",
		"added":    "yes",
	})

	if ctx.GetString("existing", "") != "new" {
		t.Errorf("existing key after update = %q, want %q", ctx.GetString("existing", ""), "new")
	}
	if ctx.GetString("added", "") != "yes" {
		t.Errorf("added key after update = %q, want %q", ctx.GetString("added", ""), "yes")
	}
}

func TestContext_ApplyUpdates_Nil(t *testing.T) {
	ctx := pctx.NewContext()
	// Should not panic
	ctx.ApplyUpdates(nil)
}

// ---------- Logs ----------

func TestContext_Logs(t *testing.T) {
	ctx := pctx.NewContext()
	if len(ctx.Logs()) != 0 {
		t.Error("expected empty logs initially")
	}

	ctx.AppendLog("first")
	ctx.AppendLog("second")

	logs := ctx.Logs()
	if len(logs) != 2 {
		t.Fatalf("log count = %d, want 2", len(logs))
	}
	if logs[0] != "first" || logs[1] != "second" {
		t.Errorf("logs = %v, want [first second]", logs)
	}
}

func TestContext_Logs_ReturnsCopy(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.AppendLog("entry")

	logs := ctx.Logs()
	logs[0] = "mutated"

	// Original should be unaffected
	original := ctx.Logs()
	if original[0] != "entry" {
		t.Error("Logs() did not return a copy; mutation affected internal state")
	}
}

// ---------- Snapshot ----------

func TestContext_Snapshot(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.Set("a", "1")
	ctx.Set("b", "2")

	snap := ctx.Snapshot()
	if snap["a"] != "1" || snap["b"] != "2" {
		t.Errorf("snapshot = %v, want a=1 b=2", snap)
	}

	// Mutating snapshot must not affect context
	snap["a"] = "99"
	if ctx.GetString("a", "") != "1" {
		t.Error("Snapshot() did not return a copy")
	}
}

// ---------- Clone ----------

func TestContext_Clone(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.Set("key", "original")
	ctx.AppendLog("log1")

	clone := ctx.Clone()

	// Clone should have the same values
	if clone.GetString("key", "") != "original" {
		t.Errorf("clone key = %q, want %q", clone.GetString("key", ""), "original")
	}
	if len(clone.Logs()) != 1 {
		t.Errorf("clone log count = %d, want 1", len(clone.Logs()))
	}

	// Mutating clone must not affect original
	clone.Set("key", "mutated")
	if ctx.GetString("key", "") != "original" {
		t.Error("clone mutation affected original context")
	}
}

// ---------- Concurrent safety ----------

func TestContext_ConcurrentReadWrite(t *testing.T) {
	ctx := pctx.NewContext()
	const goroutines = 50

	var wg sync.WaitGroup
	wg.Add(goroutines * 2)

	// Writers
	for i := 0; i < goroutines; i++ {
		go func(i int) {
			defer wg.Done()
			ctx.Set("k", "v")
			ctx.AppendLog("entry")
		}(i)
	}
	// Readers
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			ctx.GetString("k", "")
			ctx.Logs()
			ctx.Snapshot()
		}()
	}

	wg.Wait() // Should not race or deadlock
}

// ---------- Checkpoint ----------

func TestCheckpoint_RoundTrip(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.Set("stage", "research")
	ctx.Set("tokens", "42")
	ctx.AppendLog("started")

	retries := map[string]int{"node1": 1, "node2": 0}
	completed := []string{"start", "node1"}

	cp := pctx.NewCheckpoint(ctx, "node2", completed, retries)

	data, err := cp.ToJSON()
	if err != nil {
		t.Fatalf("ToJSON() error: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("ToJSON() returned empty bytes")
	}

	restored, err := pctx.CheckpointFromJSON(data)
	if err != nil {
		t.Fatalf("CheckpointFromJSON() error: %v", err)
	}

	if restored.CurrentNode != "node2" {
		t.Errorf("CurrentNode = %q, want %q", restored.CurrentNode, "node2")
	}
	if len(restored.CompletedNodes) != 2 {
		t.Errorf("CompletedNodes count = %d, want 2", len(restored.CompletedNodes))
	}
	if restored.NodeRetries["node1"] != 1 {
		t.Errorf("NodeRetries[node1] = %d, want 1", restored.NodeRetries["node1"])
	}
	if restored.ContextValues["stage"] != "research" {
		t.Errorf("ContextValues[stage] = %q, want %q", restored.ContextValues["stage"], "research")
	}
}

func TestCheckpoint_RestoreContext(t *testing.T) {
	ctx := pctx.NewContext()
	ctx.Set("model", "gpt-4o")
	ctx.AppendLog("run started")

	cp := pctx.NewCheckpoint(ctx, "step1", nil, nil)
	restored := cp.RestoreContext()

	if restored.GetString("model", "") != "gpt-4o" {
		t.Errorf("restored model = %q, want %q", restored.GetString("model", ""), "gpt-4o")
	}
	if len(restored.Logs()) != 1 || restored.Logs()[0] != "run started" {
		t.Errorf("restored logs = %v, want [run started]", restored.Logs())
	}
}

func TestCheckpointFromJSON_Invalid(t *testing.T) {
	_, err := pctx.CheckpointFromJSON([]byte("not json"))
	if err == nil {
		t.Error("expected error for invalid JSON, got nil")
	}
}

// ---------- Outcome ----------

func TestOutcome_Fields(t *testing.T) {
	o := &pctx.Outcome{
		Status:           pctx.StatusSuccess,
		PreferredLabel:   "continue",
		SuggestedNextIDs: []string{"n2", "n3"},
		ContextUpdates:   map[string]string{"last_stage": "n1"},
		Notes:            "all good",
		FailureReason:    "",
	}

	if o.Status != pctx.StatusSuccess {
		t.Errorf("Status = %q, want %q", o.Status, pctx.StatusSuccess)
	}
	if o.PreferredLabel != "continue" {
		t.Errorf("PreferredLabel = %q", o.PreferredLabel)
	}
	if len(o.SuggestedNextIDs) != 2 {
		t.Errorf("SuggestedNextIDs count = %d, want 2", len(o.SuggestedNextIDs))
	}
}

func TestStageStatus_Constants(t *testing.T) {
	statuses := []pctx.StageStatus{
		pctx.StatusSuccess,
		pctx.StatusPartialSuccess,
		pctx.StatusRetry,
		pctx.StatusFail,
		pctx.StatusSkipped,
	}
	seen := map[pctx.StageStatus]bool{}
	for _, s := range statuses {
		if seen[s] {
			t.Errorf("duplicate StageStatus value: %q", s)
		}
		seen[s] = true
		if s == "" {
			t.Error("empty StageStatus constant")
		}
	}
}
