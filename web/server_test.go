package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/attractor/attractor/internal/config"
	"github.com/attractor/attractor/internal/db"
)

// newTestServer creates a Server backed by an in-memory SQLite DB and a temp
// logs/static directory. llmClient is nil (no real HTTP calls during tests).
func newTestServer(t *testing.T) *Server {
	t.Helper()

	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "test.db")
	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	// Minimal static dir with an index.html so the static handler doesn't 404.
	staticDir := filepath.Join(tmp, "static")
	if err := os.MkdirAll(staticDir, 0755); err != nil {
		t.Fatalf("mkdir staticDir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<html></html>"), 0644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}

	cfg := &config.Config{
		DefaultModel: "openai/gpt-4o",
		LogsDir:      filepath.Join(tmp, "logs"),
		DBPath:       dbPath,
		WebHost:      "localhost",
		WebPort:      "8080",
	}

	// llmClient nil — handleModels returns empty list, which is fine for tests.
	srv := NewServer(cfg, database, nil, staticDir)
	return srv
}

// do performs an HTTP request against the test server and returns the response.
func do(t *testing.T, srv *Server, method, path string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	return rr
}

// decodeJSON decodes the response body JSON into v.
func decodeJSON(t *testing.T, rr *httptest.ResponseRecorder, v interface{}) {
	t.Helper()
	if err := json.NewDecoder(rr.Body).Decode(v); err != nil {
		t.Fatalf("decode JSON (status %d, body %q): %v", rr.Code, rr.Body.String(), err)
	}
}

// ---------- Static handler ----------

func TestHandleStatic_Root(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodGet, "/", nil)
	if rr.Code != http.StatusOK {
		t.Errorf("want 200, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "<html>") {
		t.Errorf("expected index.html body, got %q", rr.Body.String())
	}
}

func TestHandleStatic_UnknownPath_FallsBackToIndex(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodGet, "/some/spa/route", nil)
	if rr.Code != http.StatusOK {
		t.Errorf("want 200, got %d", rr.Code)
	}
}

// ---------- GET /api/pipelines (empty) ----------

func TestGetPipelines_Empty(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodGet, "/api/pipelines", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var list []interface{}
	decodeJSON(t, rr, &list)
	if len(list) != 0 {
		t.Errorf("want empty list, got %d items", len(list))
	}
}

// ---------- POST /api/pipelines ----------

func TestCreatePipeline(t *testing.T) {
	srv := newTestServer(t)
	body := map[string]string{
		"name":        "my-pipeline",
		"description": "test desc",
		"dot_content": `digraph g { start [type=start]; exit [type=exit]; start -> exit; }`,
		"model":       "openai/gpt-4o",
	}
	rr := do(t, srv, http.MethodPost, "/api/pipelines", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d; body: %s", rr.Code, rr.Body.String())
	}
	var p db.Pipeline
	decodeJSON(t, rr, &p)
	if p.ID == "" {
		t.Error("expected non-empty ID")
	}
	if p.Name != "my-pipeline" {
		t.Errorf("want name 'my-pipeline', got %q", p.Name)
	}
}

func TestCreatePipeline_MissingName(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"description": "no name"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr.Code)
	}
}

func TestCreatePipeline_InvalidBody(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/pipelines", strings.NewReader("not-json"))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr.Code)
	}
}

func TestCreatePipeline_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodDelete, "/api/pipelines", nil)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr.Code)
	}
}

// ---------- GET /api/pipelines/{id} ----------

func TestGetPipelineByID(t *testing.T) {
	srv := newTestServer(t)
	// Create one first
	body := map[string]string{"name": "pipe1", "dot_content": "digraph {}"}
	rr := do(t, srv, http.MethodPost, "/api/pipelines", body)
	var created db.Pipeline
	decodeJSON(t, rr, &created)

	rr2 := do(t, srv, http.MethodGet, "/api/pipelines/"+created.ID, nil)
	if rr2.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr2.Code)
	}
	var got db.Pipeline
	decodeJSON(t, rr2, &got)
	if got.ID != created.ID {
		t.Errorf("want ID %q, got %q", created.ID, got.ID)
	}
}

func TestGetPipelineByID_NotFound(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodGet, "/api/pipelines/nonexistent-id", nil)
	if rr.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", rr.Code)
	}
}

// ---------- PUT /api/pipelines/{id} ----------

func TestUpdatePipeline(t *testing.T) {
	srv := newTestServer(t)
	// Create
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "original"})
	var created db.Pipeline
	decodeJSON(t, rr, &created)

	// Update
	update := map[string]string{"name": "updated", "description": "new desc"}
	rr2 := do(t, srv, http.MethodPut, "/api/pipelines/"+created.ID, update)
	if rr2.Code != http.StatusOK {
		t.Fatalf("want 200, got %d; body: %s", rr2.Code, rr2.Body.String())
	}
	var updated db.Pipeline
	decodeJSON(t, rr2, &updated)
	if updated.Name != "updated" {
		t.Errorf("want name 'updated', got %q", updated.Name)
	}
}

func TestUpdatePipeline_InvalidBody(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "p"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	req := httptest.NewRequest(http.MethodPut, "/api/pipelines/"+p.ID, strings.NewReader("bad"))
	rr2 := httptest.NewRecorder()
	srv.ServeHTTP(rr2, req)
	if rr2.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr2.Code)
	}
}

// ---------- DELETE /api/pipelines/{id} ----------

func TestDeletePipeline(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "todelete"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	rr2 := do(t, srv, http.MethodDelete, "/api/pipelines/"+p.ID, nil)
	if rr2.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d", rr2.Code)
	}

	// Should now be 404
	rr3 := do(t, srv, http.MethodGet, "/api/pipelines/"+p.ID, nil)
	if rr3.Code != http.StatusNotFound {
		t.Errorf("want 404 after delete, got %d", rr3.Code)
	}
}

// ---------- PATCH /api/pipelines/{id}/model ----------

func TestPatchPipelineModel(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "mpipe"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	rr2 := do(t, srv, http.MethodPatch, "/api/pipelines/"+p.ID+"/model",
		map[string]string{"model": "openai/gpt-3.5-turbo"})
	if rr2.Code != http.StatusOK {
		t.Fatalf("want 200, got %d; body: %s", rr2.Code, rr2.Body.String())
	}
	var resp map[string]string
	decodeJSON(t, rr2, &resp)
	if resp["model"] != "openai/gpt-3.5-turbo" {
		t.Errorf("want model 'openai/gpt-3.5-turbo', got %q", resp["model"])
	}
}

func TestPatchPipelineModel_WrongMethod(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "mpipe2"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	rr2 := do(t, srv, http.MethodGet, "/api/pipelines/"+p.ID+"/model", nil)
	if rr2.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr2.Code)
	}
}

func TestPatchPipelineModel_InvalidBody(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "mpipe3"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	req := httptest.NewRequest(http.MethodPatch, "/api/pipelines/"+p.ID+"/model", strings.NewReader("bad"))
	rr2 := httptest.NewRecorder()
	srv.ServeHTTP(rr2, req)
	if rr2.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr2.Code)
	}
}

// ---------- GET /api/pipelines/{id}/runs ----------

func TestGetPipelineRuns_Empty(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "runpipe"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	rr2 := do(t, srv, http.MethodGet, "/api/pipelines/"+p.ID+"/runs", nil)
	if rr2.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr2.Code)
	}
	var runs []interface{}
	decodeJSON(t, rr2, &runs)
	if len(runs) != 0 {
		t.Errorf("want empty, got %d", len(runs))
	}
}

func TestGetPipelineRuns_WrongMethod(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "runpipe2"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	rr2 := do(t, srv, http.MethodPost, "/api/pipelines/"+p.ID+"/runs", nil)
	if rr2.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr2.Code)
	}
}

// ---------- GET /api/pipelines/{id}/stats ----------

func TestGetPipelineStats(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "statpipe"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	rr2 := do(t, srv, http.MethodGet, "/api/pipelines/"+p.ID+"/stats", nil)
	if rr2.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr2.Code)
	}
	var stats map[string]interface{}
	decodeJSON(t, rr2, &stats)
	// Stats should at least be a valid JSON object
	if stats == nil {
		t.Error("expected non-nil stats")
	}
}

func TestGetPipelineStats_WrongMethod(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{"name": "statpipe2"})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	rr2 := do(t, srv, http.MethodPost, "/api/pipelines/"+p.ID+"/stats", nil)
	if rr2.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr2.Code)
	}
}

// ---------- GET /api/runs (global) ----------

func TestGetRuns_Empty(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodGet, "/api/runs", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var runs []interface{}
	decodeJSON(t, rr, &runs)
	if len(runs) != 0 {
		t.Errorf("want empty, got %d", len(runs))
	}
}

// ---------- POST /api/runs ----------

func TestPostRun_NoPipelineIDOrDotContent(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/runs", map[string]string{"model": "openai/gpt-4o"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr.Code)
	}
}

func TestPostRun_InvalidBody(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/runs", strings.NewReader("bad"))
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr.Code)
	}
}

func TestPostRun_UnknownPipelineID(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/runs", map[string]string{"pipeline_id": "does-not-exist"})
	if rr.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", rr.Code)
	}
}

func TestPostRun_InvalidDotContent(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/runs", map[string]string{
		"dot_content": "this is not valid dot @@@@",
		"name":        "bad-run",
	})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("want 400 for unparseable DOT, got %d; body: %s", rr.Code, rr.Body.String())
	}
}

func TestPostRun_AdHocDotContent_Accepted(t *testing.T) {
	srv := newTestServer(t)
	// Minimal valid DOT: start -> exit
	dot := `digraph pipeline {
		start [type=start];
		exit  [type=exit];
		start -> exit;
	}`
	rr := do(t, srv, http.MethodPost, "/api/runs", map[string]string{
		"dot_content": dot,
		"name":        "adhoc-test",
	})
	if rr.Code != http.StatusAccepted {
		t.Fatalf("want 202, got %d; body: %s", rr.Code, rr.Body.String())
	}
	var run db.Run
	decodeJSON(t, rr, &run)
	if run.ID == "" {
		t.Error("expected non-empty run ID")
	}
	if run.Status != "running" {
		t.Errorf("want status 'running', got %q", run.Status)
	}
}

func TestPostRun_FromPipelineID(t *testing.T) {
	srv := newTestServer(t)
	// Register a pipeline first
	dot := `digraph pipeline {
		start [type=start];
		exit  [type=exit];
		start -> exit;
	}`
	rr := do(t, srv, http.MethodPost, "/api/pipelines", map[string]string{
		"name":        "my-run-pipe",
		"dot_content": dot,
	})
	var p db.Pipeline
	decodeJSON(t, rr, &p)

	rr2 := do(t, srv, http.MethodPost, "/api/runs", map[string]string{
		"pipeline_id": p.ID,
	})
	if rr2.Code != http.StatusAccepted {
		t.Fatalf("want 202, got %d; body: %s", rr2.Code, rr2.Body.String())
	}
	var run db.Run
	decodeJSON(t, rr2, &run)
	if run.PipelineID != p.ID {
		t.Errorf("want pipeline_id %q, got %q", p.ID, run.PipelineID)
	}
}

func TestPostRuns_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPut, "/api/runs", nil)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr.Code)
	}
}

// ---------- GET /api/runs/{id} ----------

func TestGetRunByID_NotFound(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodGet, "/api/runs/no-such-run", nil)
	if rr.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", rr.Code)
	}
}

func TestGetRunByID(t *testing.T) {
	srv := newTestServer(t)
	// Create a run directly in the DB for determinism (skip async engine)
	database := srv.db
	now := time.Now()
	run := &db.Run{
		ID:           "run-abc",
		PipelineID:   "pipe-abc",
		PipelineName: "test",
		Status:       "success",
		StartTime:    now,
	}
	if err := database.CreateRun(run); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	rr := do(t, srv, http.MethodGet, "/api/runs/run-abc", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	decodeJSON(t, rr, &resp)
	if resp["id"] != "run-abc" {
		t.Errorf("want id 'run-abc', got %v", resp["id"])
	}
}

func TestGetRunByID_WrongMethod(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/runs/some-id", nil)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr.Code)
	}
}

// ---------- DELETE /api/runs/{id} ----------

func TestCancelRun_Success(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now()
	run := &db.Run{
		ID:         "run-cancel-ok",
		PipelineID: "pipe-1",
		Status:     "running",
		StartTime:  now,
	}
	if err := srv.db.CreateRun(run); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	rr := do(t, srv, http.MethodDelete, "/api/runs/run-cancel-ok", nil)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d; body: %s", rr.Code, rr.Body.String())
	}

	// Run should now be cancelled
	rr2 := do(t, srv, http.MethodGet, "/api/runs/run-cancel-ok", nil)
	if rr2.Code != http.StatusOK {
		t.Fatalf("want 200 after cancel, got %d", rr2.Code)
	}
	var resp map[string]interface{}
	decodeJSON(t, rr2, &resp)
	if resp["status"] != "cancelled" {
		t.Errorf("want status 'cancelled', got %v", resp["status"])
	}
}

func TestCancelRun_NotFound(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodDelete, "/api/runs/nonexistent-run", nil)
	if rr.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", rr.Code)
	}
}

func TestCancelRun_AlreadyTerminal(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now()
	run := &db.Run{
		ID:         "run-cancel-done",
		PipelineID: "pipe-1",
		Status:     "success",
		StartTime:  now,
	}
	if err := srv.db.CreateRun(run); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	rr := do(t, srv, http.MethodDelete, "/api/runs/run-cancel-done", nil)
	if rr.Code != http.StatusConflict {
		t.Errorf("want 409, got %d", rr.Code)
	}
}

// ---------- GET /api/runs/{id}/nodes ----------

func TestGetRunNodes_Empty(t *testing.T) {
	srv := newTestServer(t)
	// Create run in DB
	now := time.Now()
	run := &db.Run{ID: "run-nodes-test", PipelineID: "p1", Status: "success", StartTime: now}
	if err := srv.db.CreateRun(run); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	rr := do(t, srv, http.MethodGet, "/api/runs/run-nodes-test/nodes", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var nodes []interface{}
	decodeJSON(t, rr, &nodes)
	if len(nodes) != 0 {
		t.Errorf("want empty node list, got %d", len(nodes))
	}
}

func TestGetRunNodes_WrongMethod(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/runs/any-id/nodes", nil)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr.Code)
	}
}

// ---------- GET /api/models ----------

func TestGetModels_NilClient_ReturnsEmpty(t *testing.T) {
	srv := newTestServer(t) // llmClient is nil
	rr := do(t, srv, http.MethodGet, "/api/models", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d; body: %s", rr.Code, rr.Body.String())
	}
	var models []interface{}
	decodeJSON(t, rr, &models)
	// nil client causes ListModels to fail → empty list returned
	if models == nil {
		t.Error("expected non-nil (possibly empty) list")
	}
}

func TestGetModels_WrongMethod(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/models", nil)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr.Code)
	}
}

// ---------- GET /api/stats ----------

func TestGetGlobalStats_Empty(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodGet, "/api/stats", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var stats map[string]interface{}
	decodeJSON(t, rr, &stats)
	if v, ok := stats["total_runs"]; !ok || v.(float64) != 0 {
		t.Errorf("want total_runs=0, got %v", stats["total_runs"])
	}
}

func TestGetGlobalStats_WithRuns(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now()
	for _, s := range []string{"success", "success", "failed", "running"} {
		run := &db.Run{
			ID:         "r-" + s + "-" + now.Format("150405.000000000"),
			PipelineID: "p1",
			Status:     s,
			StartTime:  now,
		}
		now = now.Add(time.Millisecond) // ensure unique IDs
		if err := srv.db.CreateRun(run); err != nil {
			t.Fatalf("CreateRun: %v", err)
		}
	}

	rr := do(t, srv, http.MethodGet, "/api/stats", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	var stats map[string]interface{}
	decodeJSON(t, rr, &stats)
	if stats["total_runs"].(float64) != 4 {
		t.Errorf("want total_runs=4, got %v", stats["total_runs"])
	}
	if stats["success_runs"].(float64) != 2 {
		t.Errorf("want success_runs=2, got %v", stats["success_runs"])
	}
	if stats["failed_runs"].(float64) != 1 {
		t.Errorf("want failed_runs=1, got %v", stats["failed_runs"])
	}
	if stats["running_runs"].(float64) != 1 {
		t.Errorf("want running_runs=1, got %v", stats["running_runs"])
	}
}

func TestGetGlobalStats_WrongMethod(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodPost, "/api/stats", nil)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr.Code)
	}
}

// ---------- Content-Type ----------

func TestJSONContentType(t *testing.T) {
	srv := newTestServer(t)
	rr := do(t, srv, http.MethodGet, "/api/pipelines", nil)
	ct := rr.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("want Content-Type application/json, got %q", ct)
	}
}
