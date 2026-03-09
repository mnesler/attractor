package db_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/attractor/attractor/internal/db"
)

// openTestDB creates a temporary SQLite DB for the test and registers cleanup.
func openTestDB(t *testing.T) *db.DB {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open() error: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func samplePipeline(id string) *db.Pipeline {
	return &db.Pipeline{
		ID:          id,
		Name:        "Test Pipeline " + id,
		Description: "A test pipeline",
		DotContent:  `digraph test { start [shape=Mdiamond] }`,
		FilePath:    "/tmp/test.dot",
		Model:       "openai/gpt-4o",
	}
}

// ---------- Pipeline CRUD ----------

func TestDB_UpsertAndGetPipeline(t *testing.T) {
	d := openTestDB(t)
	p := samplePipeline("p1")

	if err := d.UpsertPipeline(p); err != nil {
		t.Fatalf("UpsertPipeline() error: %v", err)
	}

	got, err := d.GetPipeline("p1")
	if err != nil {
		t.Fatalf("GetPipeline() error: %v", err)
	}
	if got == nil {
		t.Fatal("GetPipeline() returned nil, want pipeline")
	}
	if got.Name != p.Name {
		t.Errorf("Name = %q, want %q", got.Name, p.Name)
	}
	if got.DotContent != p.DotContent {
		t.Errorf("DotContent mismatch")
	}
	if got.Model != "openai/gpt-4o" {
		t.Errorf("Model = %q, want %q", got.Model, "openai/gpt-4o")
	}
}

func TestDB_GetPipeline_NotFound(t *testing.T) {
	d := openTestDB(t)
	got, err := d.GetPipeline("nonexistent")
	if err != nil {
		t.Fatalf("GetPipeline() unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("GetPipeline() = %v, want nil", got)
	}
}

func TestDB_UpsertPipeline_UpdatesExisting(t *testing.T) {
	d := openTestDB(t)
	p := samplePipeline("p1")
	_ = d.UpsertPipeline(p)

	p.Name = "Updated Name"
	p.Model = "anthropic/claude-3-5-sonnet"
	if err := d.UpsertPipeline(p); err != nil {
		t.Fatalf("second UpsertPipeline() error: %v", err)
	}

	got, _ := d.GetPipeline("p1")
	if got.Name != "Updated Name" {
		t.Errorf("updated Name = %q, want %q", got.Name, "Updated Name")
	}
	if got.Model != "anthropic/claude-3-5-sonnet" {
		t.Errorf("updated Model = %q", got.Model)
	}
}

func TestDB_ListPipelines(t *testing.T) {
	d := openTestDB(t)

	for _, id := range []string{"pa", "pb", "pc"} {
		_ = d.UpsertPipeline(samplePipeline(id))
	}

	pipelines, err := d.ListPipelines()
	if err != nil {
		t.Fatalf("ListPipelines() error: %v", err)
	}
	if len(pipelines) != 3 {
		t.Errorf("pipeline count = %d, want 3", len(pipelines))
	}
}

func TestDB_ListPipelines_Empty(t *testing.T) {
	d := openTestDB(t)
	pipelines, err := d.ListPipelines()
	if err != nil {
		t.Fatalf("ListPipelines() error: %v", err)
	}
	if len(pipelines) != 0 {
		t.Errorf("expected empty list, got %d", len(pipelines))
	}
}

func TestDB_UpdatePipelineModel(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))

	if err := d.UpdatePipelineModel("p1", "google/gemini-pro"); err != nil {
		t.Fatalf("UpdatePipelineModel() error: %v", err)
	}

	got, _ := d.GetPipeline("p1")
	if got.Model != "google/gemini-pro" {
		t.Errorf("Model after update = %q, want %q", got.Model, "google/gemini-pro")
	}
}

func TestDB_DeletePipeline(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	_ = d.UpsertPipeline(samplePipeline("p2"))

	if err := d.DeletePipeline("p1"); err != nil {
		t.Fatalf("DeletePipeline() error: %v", err)
	}

	got, _ := d.GetPipeline("p1")
	if got != nil {
		t.Error("deleted pipeline still found")
	}

	remaining, _ := d.ListPipelines()
	if len(remaining) != 1 {
		t.Errorf("pipeline count after delete = %d, want 1", len(remaining))
	}
}

// ---------- Run CRUD ----------

func sampleRun(id, pipelineID string) *db.Run {
	return &db.Run{
		ID:           id,
		PipelineID:   pipelineID,
		PipelineName: "Test Pipeline",
		GraphID:      "mygraph",
		GraphGoal:    "test the system",
		Model:        "openai/gpt-4o",
		Status:       "running",
		StartTime:    time.Now(),
		LogsRoot:     "/tmp/logs/" + id,
	}
}

func TestDB_CreateAndGetRun(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	r := sampleRun("r1", "p1")

	if err := d.CreateRun(r); err != nil {
		t.Fatalf("CreateRun() error: %v", err)
	}

	got, err := d.GetRun("r1")
	if err != nil {
		t.Fatalf("GetRun() error: %v", err)
	}
	if got == nil {
		t.Fatal("GetRun() returned nil")
	}
	if got.PipelineID != "p1" {
		t.Errorf("PipelineID = %q, want %q", got.PipelineID, "p1")
	}
	if got.Status != "running" {
		t.Errorf("Status = %q, want %q", got.Status, "running")
	}
}

func TestDB_GetRun_NotFound(t *testing.T) {
	d := openTestDB(t)
	got, err := d.GetRun("nonexistent")
	if err != nil {
		t.Fatalf("GetRun() unexpected error: %v", err)
	}
	if got != nil {
		t.Error("GetRun() returned non-nil for missing run")
	}
}

func TestDB_UpdateRun(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	_ = d.CreateRun(sampleRun("r1", "p1"))

	endTime := time.Now()
	update := &db.Run{
		ID:                    "r1",
		Status:                "success",
		EndTime:               &endTime,
		DurationMs:            1500,
		TotalPromptTokens:     100,
		TotalCompletionTokens: 200,
		TotalTokens:           300,
		NodeCount:             3,
		ErrorMessage:          "",
		NodeLogsJSON:          `[{"node_id":"n1"}]`,
	}
	if err := d.UpdateRun(update); err != nil {
		t.Fatalf("UpdateRun() error: %v", err)
	}

	got, _ := d.GetRun("r1")
	if got.Status != "success" {
		t.Errorf("Status = %q, want %q", got.Status, "success")
	}
	if got.DurationMs != 1500 {
		t.Errorf("DurationMs = %d, want 1500", got.DurationMs)
	}
	if got.TotalTokens != 300 {
		t.Errorf("TotalTokens = %d, want 300", got.TotalTokens)
	}
	if got.EndTime == nil {
		t.Error("EndTime should not be nil after update")
	}
}

func TestDB_ListRuns_AllRuns(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))

	for _, id := range []string{"r1", "r2", "r3"} {
		_ = d.CreateRun(sampleRun(id, "p1"))
	}

	runs, err := d.ListRuns("", 0)
	if err != nil {
		t.Fatalf("ListRuns() error: %v", err)
	}
	if len(runs) != 3 {
		t.Errorf("run count = %d, want 3", len(runs))
	}
}

func TestDB_ListRuns_FilterByPipeline(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	_ = d.UpsertPipeline(samplePipeline("p2"))
	_ = d.CreateRun(sampleRun("r1", "p1"))
	_ = d.CreateRun(sampleRun("r2", "p1"))
	_ = d.CreateRun(sampleRun("r3", "p2"))

	runs, err := d.ListRuns("p1", 0)
	if err != nil {
		t.Fatalf("ListRuns() error: %v", err)
	}
	if len(runs) != 2 {
		t.Errorf("filtered run count = %d, want 2", len(runs))
	}
}

func TestDB_ListRuns_Limit(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	for _, id := range []string{"r1", "r2", "r3", "r4", "r5"} {
		_ = d.CreateRun(sampleRun(id, "p1"))
	}

	runs, err := d.ListRuns("", 3)
	if err != nil {
		t.Fatalf("ListRuns() error: %v", err)
	}
	if len(runs) != 3 {
		t.Errorf("limited run count = %d, want 3", len(runs))
	}
}

// ---------- NodeLog ----------

func TestDB_InsertAndGetNodeLogs(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	_ = d.CreateRun(sampleRun("r1", "p1"))

	now := time.Now()
	nl := &db.NodeLog{
		RunID:            "r1",
		NodeID:           "research",
		NodeLabel:        "Research",
		NodeType:         "codergen",
		Status:           "success",
		AttemptNum:       1,
		StartTime:        now,
		EndTime:          now.Add(2 * time.Second),
		DurationMs:       2000,
		Model:            "openai/gpt-4o",
		PromptTokens:     50,
		CompletionTokens: 100,
		TotalTokens:      150,
		Notes:            "completed",
	}

	if err := d.InsertNodeLog(nl); err != nil {
		t.Fatalf("InsertNodeLog() error: %v", err)
	}

	logs, err := d.GetNodeLogs("r1")
	if err != nil {
		t.Fatalf("GetNodeLogs() error: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("node log count = %d, want 1", len(logs))
	}

	got := logs[0]
	if got.NodeID != "research" {
		t.Errorf("NodeID = %q, want %q", got.NodeID, "research")
	}
	if got.Model != "openai/gpt-4o" {
		t.Errorf("Model = %q, want %q", got.Model, "openai/gpt-4o")
	}
	if got.TotalTokens != 150 {
		t.Errorf("TotalTokens = %d, want 150", got.TotalTokens)
	}
}

func TestDB_GetNodeLogs_Empty(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	_ = d.CreateRun(sampleRun("r1", "p1"))

	logs, err := d.GetNodeLogs("r1")
	if err != nil {
		t.Fatalf("GetNodeLogs() error: %v", err)
	}
	if len(logs) != 0 {
		t.Errorf("expected 0 node logs, got %d", len(logs))
	}
}

func TestDB_GetNodeLogs_MultipleNodes(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	_ = d.CreateRun(sampleRun("r1", "p1"))

	now := time.Now()
	for _, nodeID := range []string{"start", "research", "exit"} {
		_ = d.InsertNodeLog(&db.NodeLog{
			RunID:     "r1",
			NodeID:    nodeID,
			Status:    "success",
			StartTime: now,
			EndTime:   now,
		})
	}

	logs, err := d.GetNodeLogs("r1")
	if err != nil {
		t.Fatalf("GetNodeLogs() error: %v", err)
	}
	if len(logs) != 3 {
		t.Errorf("node log count = %d, want 3", len(logs))
	}
}

// ---------- GetPipelineStats ----------

func TestDB_GetPipelineStats_Empty(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))

	stats, err := d.GetPipelineStats("p1")
	if err != nil {
		t.Fatalf("GetPipelineStats() error: %v", err)
	}
	if stats.TotalRuns != 0 {
		t.Errorf("TotalRuns = %d, want 0", stats.TotalRuns)
	}
}

func TestDB_GetPipelineStats_Counts(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))

	endTime := time.Now()
	createAndFinish := func(id, status string, tokens, dur int) {
		_ = d.CreateRun(sampleRun(id, "p1"))
		_ = d.UpdateRun(&db.Run{
			ID:          id,
			Status:      status,
			DurationMs:  int64(dur),
			TotalTokens: tokens,
			EndTime:     &endTime,
		})
	}

	createAndFinish("r1", "success", 100, 1000)
	createAndFinish("r2", "success", 200, 2000)
	createAndFinish("r3", "failed", 0, 500)
	// r4 stays "running"
	_ = d.CreateRun(sampleRun("r4", "p1"))

	stats, err := d.GetPipelineStats("p1")
	if err != nil {
		t.Fatalf("GetPipelineStats() error: %v", err)
	}

	if stats.TotalRuns != 4 {
		t.Errorf("TotalRuns = %d, want 4", stats.TotalRuns)
	}
	if stats.SuccessRuns != 2 {
		t.Errorf("SuccessRuns = %d, want 2", stats.SuccessRuns)
	}
	if stats.FailedRuns != 1 {
		t.Errorf("FailedRuns = %d, want 1", stats.FailedRuns)
	}
	if stats.RunningRuns != 1 {
		t.Errorf("RunningRuns = %d, want 1", stats.RunningRuns)
	}
	if stats.TotalTokens != 300 {
		t.Errorf("TotalTokens = %d, want 300", stats.TotalTokens)
	}
}

// ---------- NodeLogsFromJSON ----------

func TestNodeLogsFromJSON(t *testing.T) {
	json := `[{"run_id":"r1","node_id":"n1","status":"success"},{"run_id":"r1","node_id":"n2","status":"fail"}]`

	logs, err := db.NodeLogsFromJSON(json)
	if err != nil {
		t.Fatalf("NodeLogsFromJSON() error: %v", err)
	}
	if len(logs) != 2 {
		t.Errorf("log count = %d, want 2", len(logs))
	}
	if logs[0].NodeID != "n1" || logs[1].NodeID != "n2" {
		t.Errorf("unexpected node IDs: %v", logs)
	}
}

func TestNodeLogsFromJSON_Empty(t *testing.T) {
	logs, err := db.NodeLogsFromJSON("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if logs != nil {
		t.Errorf("expected nil for empty input, got %v", logs)
	}
}

func TestNodeLogsFromJSON_Invalid(t *testing.T) {
	_, err := db.NodeLogsFromJSON("not json")
	if err == nil {
		t.Error("expected error for invalid JSON, got nil")
	}
}

// ---------- Multiple pipeline isolation ----------

func TestDB_MultiPipeline_Isolation(t *testing.T) {
	d := openTestDB(t)
	_ = d.UpsertPipeline(samplePipeline("p1"))
	_ = d.UpsertPipeline(samplePipeline("p2"))
	_ = d.CreateRun(sampleRun("r1", "p1"))
	_ = d.CreateRun(sampleRun("r2", "p2"))
	_ = d.CreateRun(sampleRun("r3", "p2"))

	runs1, _ := d.ListRuns("p1", 0)
	runs2, _ := d.ListRuns("p2", 0)

	if len(runs1) != 1 {
		t.Errorf("p1 runs = %d, want 1", len(runs1))
	}
	if len(runs2) != 2 {
		t.Errorf("p2 runs = %d, want 2", len(runs2))
	}
}

// ---------- persistence across reopen ----------

func TestDB_PersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "persist.db")

	// Write
	{
		d, err := db.Open(path)
		if err != nil {
			t.Fatalf("first Open() error: %v", err)
		}
		_ = d.UpsertPipeline(samplePipeline("p1"))
		d.Close()
	}

	// Reopen and verify
	{
		d, err := db.Open(path)
		if err != nil {
			t.Fatalf("second Open() error: %v", err)
		}
		defer d.Close()

		got, err := d.GetPipeline("p1")
		if err != nil {
			t.Fatalf("GetPipeline() after reopen error: %v", err)
		}
		if got == nil {
			t.Fatal("pipeline not found after db reopen")
		}
	}

	_ = os.Remove(path)
}
