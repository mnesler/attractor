// Package db implements the SQLite database layer for Attractor run logging.
package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// DB is the database handle
type DB struct {
	db *sql.DB
}

// Pipeline represents a registered pipeline definition
type Pipeline struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	DotContent  string    `json:"dot_content"`
	FilePath    string    `json:"file_path"`
	Model       string    `json:"model"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Run represents a pipeline run record
type Run struct {
	ID                    string    `json:"id"`
	PipelineID            string    `json:"pipeline_id"`
	PipelineName          string    `json:"pipeline_name"`
	GraphID               string    `json:"graph_id"`
	GraphGoal             string    `json:"graph_goal"`
	Model                 string    `json:"model"`
	Status                string    `json:"status"`
	StartTime             time.Time `json:"start_time"`
	EndTime               *time.Time `json:"end_time,omitempty"`
	DurationMs            int64     `json:"duration_ms"`
	TotalPromptTokens     int       `json:"total_prompt_tokens"`
	TotalCompletionTokens int       `json:"total_completion_tokens"`
	TotalTokens           int       `json:"total_tokens"`
	NodeCount             int       `json:"node_count"`
	ErrorMessage          string    `json:"error_message,omitempty"`
	LogsRoot              string    `json:"logs_root"`
	NodeLogsJSON          string    `json:"node_logs_json,omitempty"`
}

// NodeLog represents a single node execution log
type NodeLog struct {
	ID               int64     `json:"id"`
	RunID            string    `json:"run_id"`
	NodeID           string    `json:"node_id"`
	NodeLabel        string    `json:"node_label"`
	NodeType         string    `json:"node_type"`
	Status           string    `json:"status"`
	AttemptNum       int       `json:"attempt_num"`
	StartTime        time.Time `json:"start_time"`
	EndTime          time.Time `json:"end_time"`
	DurationMs       int64     `json:"duration_ms"`
	Model            string    `json:"model,omitempty"`
	PromptTokens     int       `json:"prompt_tokens"`
	CompletionTokens int       `json:"completion_tokens"`
	TotalTokens      int       `json:"total_tokens"`
	Notes            string    `json:"notes,omitempty"`
	FailureReason    string    `json:"failure_reason,omitempty"`
	InputText        string    `json:"input_text,omitempty"`
	OutputText       string    `json:"output_text,omitempty"`
}

// Open opens (or creates) the SQLite database
func Open(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	d := &DB{db: sqlDB}
	if err := d.migrate(); err != nil {
		return nil, fmt.Errorf("migration failed: %w", err)
	}
	return d, nil
}

// Close closes the database
func (d *DB) Close() error {
	return d.db.Close()
}

// migrate creates tables if they don't exist
func (d *DB) migrate() error {
	_, err := d.db.Exec(`
		CREATE TABLE IF NOT EXISTS pipelines (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			description TEXT,
			dot_content TEXT,
			file_path   TEXT,
			model       TEXT DEFAULT '',
			created_at  DATETIME NOT NULL,
			updated_at  DATETIME NOT NULL
		);

		CREATE TABLE IF NOT EXISTS runs (
			id                      TEXT PRIMARY KEY,
			pipeline_id             TEXT NOT NULL,
			pipeline_name           TEXT,
			graph_id                TEXT,
			graph_goal              TEXT,
			model                   TEXT,
			status                  TEXT NOT NULL DEFAULT 'running',
			start_time              DATETIME NOT NULL,
			end_time                DATETIME,
			duration_ms             INTEGER DEFAULT 0,
			total_prompt_tokens     INTEGER DEFAULT 0,
			total_completion_tokens INTEGER DEFAULT 0,
			total_tokens            INTEGER DEFAULT 0,
			node_count              INTEGER DEFAULT 0,
			error_message           TEXT,
			logs_root               TEXT,
			node_logs_json          TEXT,
			FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
		);

		CREATE TABLE IF NOT EXISTS node_logs (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id            TEXT NOT NULL,
			node_id           TEXT NOT NULL,
			node_label        TEXT,
			node_type         TEXT,
			status            TEXT NOT NULL,
			attempt_num       INTEGER DEFAULT 1,
			start_time        DATETIME NOT NULL,
			end_time          DATETIME NOT NULL,
			duration_ms       INTEGER DEFAULT 0,
			model             TEXT,
			prompt_tokens     INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens      INTEGER DEFAULT 0,
			notes             TEXT,
			failure_reason    TEXT,
			input_text        TEXT,
			output_text       TEXT,
			FOREIGN KEY (run_id) REFERENCES runs(id)
		);

		CREATE INDEX IF NOT EXISTS idx_runs_pipeline_id ON runs(pipeline_id);
		CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
		CREATE INDEX IF NOT EXISTS idx_runs_start_time ON runs(start_time);
		CREATE INDEX IF NOT EXISTS idx_node_logs_run_id ON node_logs(run_id);
	`)
	if err != nil {
		return err
	}

	// Add columns for existing databases (safe to call if columns already exist)
	for _, col := range []string{"input_text", "output_text"} {
		_, _ = d.db.Exec(fmt.Sprintf("ALTER TABLE node_logs ADD COLUMN %s TEXT", col))
	}

	return nil
}

// UpsertPipeline creates or updates a pipeline record
func (d *DB) UpsertPipeline(p *Pipeline) error {
	now := time.Now()
	_, err := d.db.Exec(`
		INSERT INTO pipelines (id, name, description, dot_content, file_path, model, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name=excluded.name,
			description=excluded.description,
			dot_content=excluded.dot_content,
			file_path=excluded.file_path,
			model=excluded.model,
			updated_at=excluded.updated_at
	`, p.ID, p.Name, p.Description, p.DotContent, p.FilePath, p.Model, now, now)
	return err
}

// GetPipeline retrieves a pipeline by ID
func (d *DB) GetPipeline(id string) (*Pipeline, error) {
	row := d.db.QueryRow(`SELECT id, name, description, dot_content, file_path, model, created_at, updated_at FROM pipelines WHERE id = ?`, id)
	var p Pipeline
	err := row.Scan(&p.ID, &p.Name, &p.Description, &p.DotContent, &p.FilePath, &p.Model, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &p, err
}

// ListPipelines returns all pipelines
func (d *DB) ListPipelines() ([]*Pipeline, error) {
	rows, err := d.db.Query(`SELECT id, name, description, dot_content, file_path, model, created_at, updated_at FROM pipelines ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pipelines []*Pipeline
	for rows.Next() {
		var p Pipeline
		err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.DotContent, &p.FilePath, &p.Model, &p.CreatedAt, &p.UpdatedAt)
		if err != nil {
			return nil, err
		}
		pipelines = append(pipelines, &p)
	}
	return pipelines, rows.Err()
}

// UpdatePipelineModel updates the model for a pipeline
func (d *DB) UpdatePipelineModel(id, model string) error {
	_, err := d.db.Exec(`UPDATE pipelines SET model=?, updated_at=? WHERE id=?`, model, time.Now(), id)
	return err
}

// DeletePipeline deletes a pipeline (and cascades to runs/node_logs via app logic)
func (d *DB) DeletePipeline(id string) error {
	_, err := d.db.Exec(`DELETE FROM pipelines WHERE id=?`, id)
	return err
}

// CreateRun inserts a new run record
func (d *DB) CreateRun(r *Run) error {
	_, err := d.db.Exec(`
		INSERT INTO runs (id, pipeline_id, pipeline_name, graph_id, graph_goal, model, status, start_time, logs_root)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, r.ID, r.PipelineID, r.PipelineName, r.GraphID, r.GraphGoal, r.Model, r.Status, r.StartTime, r.LogsRoot)
	return err
}

// UpdateRun updates a run record with final state
func (d *DB) UpdateRun(r *Run) error {
	nodeLogsJSON := ""
	if r.NodeLogsJSON != "" {
		nodeLogsJSON = r.NodeLogsJSON
	}
	_, err := d.db.Exec(`
		UPDATE runs SET
			status=?, end_time=?, duration_ms=?,
			total_prompt_tokens=?, total_completion_tokens=?, total_tokens=?,
			node_count=?, error_message=?, node_logs_json=?
		WHERE id=?
	`, r.Status, r.EndTime, r.DurationMs,
		r.TotalPromptTokens, r.TotalCompletionTokens, r.TotalTokens,
		r.NodeCount, r.ErrorMessage, nodeLogsJSON, r.ID)
	return err
}

// GetRun retrieves a run by ID
func (d *DB) GetRun(id string) (*Run, error) {
	row := d.db.QueryRow(`
		SELECT id, pipeline_id, pipeline_name, graph_id, graph_goal, model, status,
		       start_time, end_time, duration_ms, total_prompt_tokens, total_completion_tokens,
		       total_tokens, node_count, error_message, logs_root, node_logs_json
		FROM runs WHERE id=?
	`, id)
	var r Run
	var endTime sql.NullTime
	var errMsg, nodeLogsJSON sql.NullString
	err := row.Scan(&r.ID, &r.PipelineID, &r.PipelineName, &r.GraphID, &r.GraphGoal,
		&r.Model, &r.Status, &r.StartTime, &endTime, &r.DurationMs,
		&r.TotalPromptTokens, &r.TotalCompletionTokens, &r.TotalTokens,
		&r.NodeCount, &errMsg, &r.LogsRoot, &nodeLogsJSON)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if endTime.Valid {
		r.EndTime = &endTime.Time
	}
	r.ErrorMessage = errMsg.String
	r.NodeLogsJSON = nodeLogsJSON.String
	return &r, nil
}

// ListRuns returns runs, optionally filtered by pipeline ID
func (d *DB) ListRuns(pipelineID string, limit int) ([]*Run, error) {
	query := `
		SELECT id, pipeline_id, pipeline_name, graph_id, graph_goal, model, status,
		       start_time, end_time, duration_ms, total_prompt_tokens, total_completion_tokens,
		       total_tokens, node_count, error_message, logs_root
		FROM runs
	`
	var args []interface{}

	if pipelineID != "" {
		query += " WHERE pipeline_id=?"
		args = append(args, pipelineID)
	}
	query += " ORDER BY start_time DESC"
	if limit > 0 {
		query += fmt.Sprintf(" LIMIT %d", limit)
	}

	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var runs []*Run
	for rows.Next() {
		var r Run
		var endTime sql.NullTime
		var errMsg sql.NullString
		err := rows.Scan(&r.ID, &r.PipelineID, &r.PipelineName, &r.GraphID, &r.GraphGoal,
			&r.Model, &r.Status, &r.StartTime, &endTime, &r.DurationMs,
			&r.TotalPromptTokens, &r.TotalCompletionTokens, &r.TotalTokens,
			&r.NodeCount, &errMsg, &r.LogsRoot)
		if err != nil {
			return nil, err
		}
		if endTime.Valid {
			r.EndTime = &endTime.Time
		}
		r.ErrorMessage = errMsg.String
		runs = append(runs, &r)
	}
	return runs, rows.Err()
}

// CancelRun marks a running run as cancelled. Returns (true, nil) if the run
// was updated, or (false, nil) if it does not exist or is not in "running" state.
func (d *DB) CancelRun(id string) (bool, error) {
	now := time.Now()
	res, err := d.db.Exec(`
		UPDATE runs SET status='cancelled', end_time=? WHERE id=? AND status='running'
	`, now, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// InsertNodeLog inserts a node execution log
func (d *DB) InsertNodeLog(nl *NodeLog) error {
	_, err := d.db.Exec(`
		INSERT INTO node_logs (run_id, node_id, node_label, node_type, status, attempt_num,
		                       start_time, end_time, duration_ms, model, prompt_tokens,
		                       completion_tokens, total_tokens, notes, failure_reason,
		                       input_text, output_text)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, nl.RunID, nl.NodeID, nl.NodeLabel, nl.NodeType, nl.Status, nl.AttemptNum,
		nl.StartTime, nl.EndTime, nl.DurationMs, nl.Model, nl.PromptTokens,
		nl.CompletionTokens, nl.TotalTokens, nl.Notes, nl.FailureReason,
		nl.InputText, nl.OutputText)
	return err
}

// GetNodeLogs retrieves all node logs for a run
func (d *DB) GetNodeLogs(runID string) ([]*NodeLog, error) {
	rows, err := d.db.Query(`
		SELECT id, run_id, node_id, node_label, node_type, status, attempt_num,
		       start_time, end_time, duration_ms, model, prompt_tokens,
		       completion_tokens, total_tokens, notes, failure_reason,
		       input_text, output_text
		FROM node_logs WHERE run_id=? ORDER BY id ASC
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []*NodeLog
	for rows.Next() {
		var nl NodeLog
		var model, notes, failureReason, inputText, outputText sql.NullString
		err := rows.Scan(&nl.ID, &nl.RunID, &nl.NodeID, &nl.NodeLabel, &nl.NodeType,
			&nl.Status, &nl.AttemptNum, &nl.StartTime, &nl.EndTime, &nl.DurationMs,
			&model, &nl.PromptTokens, &nl.CompletionTokens, &nl.TotalTokens,
			&notes, &failureReason, &inputText, &outputText)
		if err != nil {
			return nil, err
		}
		nl.Model = model.String
		nl.Notes = notes.String
		nl.FailureReason = failureReason.String
		nl.InputText = inputText.String
		nl.OutputText = outputText.String
		logs = append(logs, &nl)
	}
	return logs, rows.Err()
}

// RunStats contains aggregate statistics for a pipeline
type RunStats struct {
	TotalRuns      int     `json:"total_runs"`
	SuccessRuns    int     `json:"success_runs"`
	FailedRuns     int     `json:"failed_runs"`
	RunningRuns    int     `json:"running_runs"`
	AvgDurationMs  float64 `json:"avg_duration_ms"`
	TotalTokens    int     `json:"total_tokens"`
}

// GetPipelineStats returns aggregate stats for a pipeline
func (d *DB) GetPipelineStats(pipelineID string) (*RunStats, error) {
	row := d.db.QueryRow(`
		SELECT
			COUNT(*),
			COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END), 0),
			AVG(CASE WHEN duration_ms > 0 THEN duration_ms ELSE NULL END),
			SUM(total_tokens)
		FROM runs WHERE pipeline_id=?
	`, pipelineID)
	var stats RunStats
	var avgDuration sql.NullFloat64
	var totalTokens sql.NullInt64
	err := row.Scan(&stats.TotalRuns, &stats.SuccessRuns, &stats.FailedRuns, &stats.RunningRuns,
		&avgDuration, &totalTokens)
	if err != nil {
		return nil, err
	}
	stats.AvgDurationMs = avgDuration.Float64
	stats.TotalTokens = int(totalTokens.Int64)
	return &stats, nil
}

// NodeLogsFromJSON parses node logs from JSON
func NodeLogsFromJSON(data string) ([]*NodeLog, error) {
	if data == "" {
		return nil, nil
	}
	var logs []*NodeLog
	err := json.Unmarshal([]byte(data), &logs)
	return logs, err
}
