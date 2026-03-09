// Package web implements the HTTP API server and web dashboard for Attractor.
package web

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/attractor/attractor/internal/config"
	"github.com/attractor/attractor/internal/db"
	"github.com/attractor/attractor/internal/engine"
	"github.com/attractor/attractor/internal/handlers"
	"github.com/attractor/attractor/internal/llm"
	"github.com/attractor/attractor/internal/parser"

	"github.com/google/uuid"
)

// Server is the HTTP API + dashboard server
type Server struct {
	cfg      *config.Config
	db       *db.DB
	llm      *llm.Client
	registry *handlers.Registry
	mux      *http.ServeMux
	staticDir string
}

// NewServer creates a new Server
func NewServer(cfg *config.Config, database *db.DB, llmClient *llm.Client, staticDir string) *Server {
	s := &Server{
		cfg:       cfg,
		db:        database,
		llm:       llmClient,
		registry:  handlers.NewRegistry(llmClient, cfg.DefaultModel),
		staticDir: staticDir,
	}
	s.mux = http.NewServeMux()
	s.routes()
	return s
}

// routes registers all HTTP routes
func (s *Server) routes() {
	// API routes
	s.mux.HandleFunc("/api/pipelines", s.handlePipelines)
	s.mux.HandleFunc("/api/pipelines/", s.handlePipelineByID)
	s.mux.HandleFunc("/api/runs", s.handleRuns)
	s.mux.HandleFunc("/api/runs/", s.handleRunByID)
	s.mux.HandleFunc("/api/models", s.handleModels)
	s.mux.HandleFunc("/api/stats", s.handleGlobalStats)

	// Static files — serve index.html for all non-API routes
	s.mux.HandleFunc("/", s.handleStatic)
}

// ServeHTTP implements http.Handler
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// Start starts the HTTP server
func (s *Server) Start() error {
	addr := s.cfg.WebHost + ":" + s.cfg.WebPort
	log.Printf("Attractor dashboard listening on http://%s", addr)
	return http.ListenAndServe(addr, s)
}

// ---------- Static ----------

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	// Only serve index.html for the root or unrecognized paths
	path := r.URL.Path
	if path == "/" || path == "" {
		http.ServeFile(w, r, filepath.Join(s.staticDir, "index.html"))
		return
	}
	// Try serving exact file; fall back to index.html for SPA
	full := filepath.Join(s.staticDir, filepath.Clean(path))
	if _, err := os.Stat(full); err == nil {
		http.ServeFile(w, r, full)
		return
	}
	http.ServeFile(w, r, filepath.Join(s.staticDir, "index.html"))
}

// ---------- Pipelines ----------

func (s *Server) handlePipelines(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		pipelines, err := s.db.ListPipelines()
		if err != nil {
			jsonError(w, "failed to list pipelines", http.StatusInternalServerError)
			return
		}
		jsonOK(w, pipelines)

	case http.MethodPost:
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			DotContent  string `json:"dot_content"`
			FilePath    string `json:"file_path"`
			Model       string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonError(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.Name == "" {
			jsonError(w, "name is required", http.StatusBadRequest)
			return
		}
		// Load dot content from file if not provided directly
		if req.DotContent == "" && req.FilePath != "" {
			data, err := os.ReadFile(req.FilePath)
			if err != nil {
				jsonError(w, fmt.Sprintf("failed to read file: %v", err), http.StatusBadRequest)
				return
			}
			req.DotContent = string(data)
		}
		p := &db.Pipeline{
			ID:          uuid.New().String(),
			Name:        req.Name,
			Description: req.Description,
			DotContent:  req.DotContent,
			FilePath:    req.FilePath,
			Model:       req.Model,
		}
		if err := s.db.UpsertPipeline(p); err != nil {
			jsonError(w, "failed to create pipeline", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
		jsonOK(w, p)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handlePipelineByID(w http.ResponseWriter, r *http.Request) {
	// Parse path: /api/pipelines/{id}[/runs|/stats|/model]
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/pipelines/")
	parts := strings.SplitN(trimmed, "/", 2)
	id := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}

	if id == "" {
		jsonError(w, "pipeline id required", http.StatusBadRequest)
		return
	}

	switch sub {
	case "runs":
		s.handlePipelineRuns(w, r, id)
	case "stats":
		s.handlePipelineStats(w, r, id)
	case "model":
		s.handlePipelineModel(w, r, id)
	default:
		s.handleSinglePipeline(w, r, id)
	}
}

func (s *Server) handleSinglePipeline(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		p, err := s.db.GetPipeline(id)
		if err != nil {
			jsonError(w, "db error", http.StatusInternalServerError)
			return
		}
		if p == nil {
			jsonError(w, "pipeline not found", http.StatusNotFound)
			return
		}
		jsonOK(w, p)

	case http.MethodPut:
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			DotContent  string `json:"dot_content"`
			FilePath    string `json:"file_path"`
			Model       string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonError(w, "invalid request body", http.StatusBadRequest)
			return
		}
		p := &db.Pipeline{
			ID:          id,
			Name:        req.Name,
			Description: req.Description,
			DotContent:  req.DotContent,
			FilePath:    req.FilePath,
			Model:       req.Model,
		}
		if err := s.db.UpsertPipeline(p); err != nil {
			jsonError(w, "failed to update pipeline", http.StatusInternalServerError)
			return
		}
		jsonOK(w, p)

	case http.MethodDelete:
		if err := s.db.DeletePipeline(id); err != nil {
			jsonError(w, "failed to delete pipeline", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handlePipelineRuns(w http.ResponseWriter, r *http.Request, pipelineID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	runs, err := s.db.ListRuns(pipelineID, 100)
	if err != nil {
		jsonError(w, "failed to list runs", http.StatusInternalServerError)
		return
	}
	jsonOK(w, runs)
}

func (s *Server) handlePipelineStats(w http.ResponseWriter, r *http.Request, pipelineID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	stats, err := s.db.GetPipelineStats(pipelineID)
	if err != nil {
		jsonError(w, "failed to get stats", http.StatusInternalServerError)
		return
	}
	jsonOK(w, stats)
}

func (s *Server) handlePipelineModel(w http.ResponseWriter, r *http.Request, pipelineID string) {
	if r.Method != http.MethodPatch {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.db.UpdatePipelineModel(pipelineID, req.Model); err != nil {
		jsonError(w, "failed to update model", http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]string{"model": req.Model})
}

// ---------- Runs ----------

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		runs, err := s.db.ListRuns("", 50)
		if err != nil {
			jsonError(w, "failed to list runs", http.StatusInternalServerError)
			return
		}
		jsonOK(w, runs)

	case http.MethodPost:
		// Create and start a new run
		var req struct {
			PipelineID string `json:"pipeline_id"`
			Model      string `json:"model"`
			// Optional: inline dot content instead of pipeline_id
			DotContent string `json:"dot_content"`
			Name       string `json:"name"`
			// Optional: generate DOT from a natural-language prompt
			Prompt string `json:"prompt"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonError(w, "invalid request body", http.StatusBadRequest)
			return
		}

		var dotContent string
		var pipelineID string
		var pipelineName string
		var model string

		if req.PipelineID != "" {
			p, err := s.db.GetPipeline(req.PipelineID)
			if err != nil || p == nil {
				jsonError(w, "pipeline not found", http.StatusNotFound)
				return
			}
			dotContent = p.DotContent
			// Load from file if no inline content
			if dotContent == "" && p.FilePath != "" {
				data, err := os.ReadFile(p.FilePath)
				if err != nil {
					jsonError(w, fmt.Sprintf("failed to read pipeline file: %v", err), http.StatusInternalServerError)
					return
				}
				dotContent = string(data)
			}
			pipelineID = p.ID
			pipelineName = p.Name
			model = p.Model
		} else if req.DotContent != "" {
			dotContent = req.DotContent
			pipelineName = req.Name
			if pipelineName == "" {
				pipelineName = "adhoc"
			}
			// Create a transient pipeline record
			p := &db.Pipeline{
				ID:         uuid.New().String(),
				Name:       pipelineName,
				DotContent: dotContent,
				Model:      req.Model,
			}
			if err := s.db.UpsertPipeline(p); err != nil {
				jsonError(w, "failed to create adhoc pipeline", http.StatusInternalServerError)
				return
			}
			pipelineID = p.ID
		} else if req.Prompt != "" {
			// Generate DOT from a natural-language prompt using the LLM
			genModel := req.Model
			if genModel == "" {
				genModel = s.cfg.DefaultModel
			}
			generated, err := s.llm.GenerateDOT(r.Context(), req.Prompt, genModel)
			if err != nil {
				jsonError(w, fmt.Sprintf("failed to generate pipeline: %v", err), http.StatusInternalServerError)
				return
			}
			dotContent = generated
			pipelineName = req.Name
			if pipelineName == "" {
				pipelineName = "generated"
			}
			p := &db.Pipeline{
				ID:         uuid.New().String(),
				Name:       pipelineName,
				DotContent: dotContent,
				Model:      genModel,
			}
			if err := s.db.UpsertPipeline(p); err != nil {
				jsonError(w, "failed to create generated pipeline", http.StatusInternalServerError)
				return
			}
			pipelineID = p.ID
		} else {
			jsonError(w, "pipeline_id, dot_content, or prompt required", http.StatusBadRequest)
			return
		}

		if req.Model != "" {
			model = req.Model
		}
		if model == "" {
			model = s.cfg.DefaultModel
		}

		// Parse the DOT content
		graph, err := parser.Parse(dotContent)
		if err != nil {
			jsonError(w, fmt.Sprintf("failed to parse pipeline: %v", err), http.StatusBadRequest)
			return
		}

		runID := uuid.New().String()
		run := &db.Run{
			ID:           runID,
			PipelineID:   pipelineID,
			PipelineName: pipelineName,
			GraphID:      graph.ID,
			GraphGoal:    graph.Goal,
			Model:        model,
			Status:       "running",
			StartTime:    time.Now(),
			LogsRoot:     filepath.Join(s.cfg.LogsDir, runID),
		}
		if err := s.db.CreateRun(run); err != nil {
			jsonError(w, "failed to create run record", http.StatusInternalServerError)
			return
		}

		// Launch run asynchronously
		go s.executeRun(runID, pipelineID, graph, model)

		w.WriteHeader(http.StatusAccepted)
		jsonOK(w, run)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// executeRun runs the pipeline and updates the DB when done
func (s *Server) executeRun(runID, pipelineID string, graph *parser.Graph, model string) {
	eng := engine.NewEngine(s.registry, s.cfg.LogsDir)
	ctx := context.Background()

	runLog, err := eng.Run(ctx, graph, runID, pipelineID, model)

	// Build updated run record
	run := &db.Run{
		ID:                    runID,
		PipelineID:            pipelineID,
		Status:                string(runLog.Status),
		DurationMs:            runLog.DurationMs,
		TotalPromptTokens:     runLog.TotalPromptTokens,
		TotalCompletionTokens: runLog.TotalCompletionTokens,
		TotalTokens:           runLog.TotalTokens,
		NodeCount:             len(runLog.NodeLogs),
	}
	if err != nil {
		run.Status = "failed"
		run.ErrorMessage = err.Error()
	}
	endTime := runLog.EndTime
	run.EndTime = &endTime

	// Serialize node logs to JSON
	if len(runLog.NodeLogs) > 0 {
		data, _ := json.Marshal(runLog.NodeLogs)
		run.NodeLogsJSON = string(data)
	}

	if dbErr := s.db.UpdateRun(run); dbErr != nil {
		log.Printf("failed to update run %s in db: %v", runID, dbErr)
	}

	// Also insert individual node logs
	for _, nl := range runLog.NodeLogs {
		dbNL := &db.NodeLog{
			RunID:            runID,
			NodeID:           nl.NodeID,
			NodeLabel:        nl.NodeLabel,
			NodeType:         nl.NodeType,
			Status:           string(nl.Status),
			AttemptNum:       nl.AttemptNum,
			StartTime:        nl.StartTime,
			EndTime:          nl.EndTime,
			DurationMs:       nl.DurationMs,
			Model:            nl.Model,
			PromptTokens:     nl.PromptTokens,
			CompletionTokens: nl.CompletionTokens,
			TotalTokens:      nl.TotalTokens,
			Notes:            nl.Notes,
			FailureReason:    nl.FailureReason,
		}
		if dbErr := s.db.InsertNodeLog(dbNL); dbErr != nil {
			log.Printf("failed to insert node log for run %s node %s: %v", runID, nl.NodeID, dbErr)
		}
	}
}

func (s *Server) handleRunByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/runs/")
	if id == "" {
		jsonError(w, "run id required", http.StatusBadRequest)
		return
	}

	// Sub-path: /api/runs/{id}/nodes
	parts := strings.SplitN(id, "/", 2)
	runID := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}

	if sub == "nodes" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		nodeLogs, err := s.db.GetNodeLogs(runID)
		if err != nil {
			jsonError(w, "failed to get node logs", http.StatusInternalServerError)
			return
		}
		jsonOK(w, nodeLogs)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	run, err := s.db.GetRun(runID)
	if err != nil {
		jsonError(w, "db error", http.StatusInternalServerError)
		return
	}
	if run == nil {
		jsonError(w, "run not found", http.StatusNotFound)
		return
	}

	// Attach node logs inline
	type runWithNodes struct {
		*db.Run
		NodeLogs interface{} `json:"node_logs"`
	}
	nodeLogs, _ := s.db.GetNodeLogs(runID)
	jsonOK(w, runWithNodes{Run: run, NodeLogs: nodeLogs})
}

// ---------- Models ----------

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if s.llm == nil {
		jsonOK(w, []interface{}{})
		return
	}
	models, err := s.llm.ListModels(ctx)
	if err != nil {
		// Return empty list instead of error so UI still works
		jsonOK(w, []interface{}{})
		return
	}
	jsonOK(w, models)
}

// ---------- Global stats ----------

func (s *Server) handleGlobalStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	runs, err := s.db.ListRuns("", 0)
	if err != nil {
		jsonError(w, "failed to get runs", http.StatusInternalServerError)
		return
	}

	type GlobalStats struct {
		TotalRuns             int `json:"total_runs"`
		SuccessRuns           int `json:"success_runs"`
		FailedRuns            int `json:"failed_runs"`
		RunningRuns           int `json:"running_runs"`
		TotalPromptTokens     int `json:"total_prompt_tokens"`
		TotalCompletionTokens int `json:"total_completion_tokens"`
		TotalTokens           int `json:"total_tokens"`
	}

	var stats GlobalStats
	stats.TotalRuns = len(runs)
	for _, run := range runs {
		switch run.Status {
		case "success":
			stats.SuccessRuns++
		case "failed":
			stats.FailedRuns++
		case "running":
			stats.RunningRuns++
		}
		stats.TotalPromptTokens += run.TotalPromptTokens
		stats.TotalCompletionTokens += run.TotalCompletionTokens
		stats.TotalTokens += run.TotalTokens
	}

	jsonOK(w, stats)
}

// ---------- Helpers ----------

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("json encode error: %v", err)
	}
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
