// Command attractor is the CLI for the Attractor AI pipeline runner.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"text/tabwriter"
	"time"

	"github.com/attractor/attractor/internal/config"
	"github.com/attractor/attractor/internal/db"
	"github.com/attractor/attractor/internal/engine"
	"github.com/attractor/attractor/internal/handlers"
	"github.com/attractor/attractor/internal/llm"
	"github.com/attractor/attractor/internal/parser"
	"github.com/attractor/attractor/web"
	"github.com/google/uuid"
	"github.com/spf13/cobra"
)

func main() {
	if err := rootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func rootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "attractor",
		Short: "Attractor — DOT-based AI pipeline runner",
		Long: `Attractor runs AI pipelines defined in Graphviz DOT syntax.

Each node in the graph is an AI task (LLM call, tool execution, human gate, etc.).
Pipeline runs are logged to SQLite and viewable in the web dashboard.`,
	}

	root.AddCommand(
		runCmd(),
		serveCmd(),
		pipelineCmd(),
		modelsCmd(),
	)

	return root
}

// ---------- run ----------

func runCmd() *cobra.Command {
	var (
		model      string
		noLog      bool
		outputJSON bool
		prompt     string
	)

	cmd := &cobra.Command{
		Use:   "run [pipeline.dot]",
		Short: "Run a pipeline from a DOT file or a natural-language prompt",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 && prompt == "" {
				return fmt.Errorf("provide a .dot file or use --prompt to generate a pipeline")
			}

			cfg := config.Load()
			if err := cfg.EnsureDirs(); err != nil {
				return fmt.Errorf("failed to create dirs: %w", err)
			}

			// Resolve model
			if model == "" {
				model = cfg.DefaultModel
			}

			// Setup LLM client
			llmClient := llm.NewClient(cfg.OpenRouterAPIKey)

			var dotContent string
			var pipelineName string

			if prompt != "" {
				// Generate DOT from prompt
				fmt.Printf("Generating pipeline from prompt...\n")
				ctx := context.Background()
				generated, err := llmClient.GenerateDOT(ctx, prompt, model)
				if err != nil {
					return fmt.Errorf("failed to generate pipeline: %w", err)
				}
				dotContent = generated
				pipelineName = "generated"
				fmt.Printf("Pipeline generated.\n\n")
			} else {
				dotFile := args[0]
				data, err := os.ReadFile(dotFile)
				if err != nil {
					return fmt.Errorf("failed to read pipeline file: %w", err)
				}
				dotContent = string(data)
				pipelineName = filepath.Base(dotFile)
			}

			// Parse graph
			graph, err := parser.Parse(dotContent)
			if err != nil {
				return fmt.Errorf("failed to parse pipeline: %w", err)
			}

			// Setup registry and engine
			registry := handlers.NewRegistry(llmClient, model)
			eng := engine.NewEngine(registry, cfg.LogsDir)
			runID := uuid.New().String()

			fmt.Printf("Starting pipeline: %s\n", graph.ID)
			fmt.Printf("Goal: %s\n", graph.Goal)
			fmt.Printf("Model: %s\n", model)
			fmt.Printf("Run ID: %s\n", runID)
			fmt.Println()

			// Optionally log to DB
			var database *db.DB
			if !noLog {
				database, err = db.Open(cfg.DBPath)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to open database: %v\n", err)
					database = nil
				} else {
					defer database.Close()
					// Register or upsert pipeline
					dotFilePath := ""
					if len(args) > 0 {
						dotFilePath = args[0]
					}
					p := &db.Pipeline{
						ID:         uuid.New().String(),
						Name:       pipelineName,
						FilePath:   dotFilePath,
						DotContent: dotContent,
						Model:      model,
					}
					_ = database.UpsertPipeline(p)

					run := &db.Run{
						ID:           runID,
						PipelineID:   p.ID,
						PipelineName: pipelineName,
						GraphID:      graph.ID,
						GraphGoal:    graph.Goal,
						Model:        model,
						Status:       "running",
						StartTime:    time.Now(),
						LogsRoot:     filepath.Join(cfg.LogsDir, runID),
					}
					if err := database.CreateRun(run); err != nil {
						fmt.Fprintf(os.Stderr, "Warning: failed to create run record: %v\n", err)
					}
				}
			}

			// Execute
			ctx := context.Background()
			runLog, err := eng.Run(ctx, graph, runID, "", model)
			if err != nil {
				return fmt.Errorf("pipeline execution error: %w", err)
			}

			// Print summary
			if outputJSON {
				enc := json.NewEncoder(os.Stdout)
				enc.SetIndent("", "  ")
				return enc.Encode(runLog)
			}

			printRunSummary(runLog)

			// Update DB
			if database != nil {
				endTime := runLog.EndTime
				dbRun := &db.Run{
					ID:                    runID,
					Status:                string(runLog.Status),
					DurationMs:            runLog.DurationMs,
					TotalPromptTokens:     runLog.TotalPromptTokens,
					TotalCompletionTokens: runLog.TotalCompletionTokens,
					TotalTokens:           runLog.TotalTokens,
					NodeCount:             len(runLog.NodeLogs),
					ErrorMessage:          runLog.ErrorMessage,
					EndTime:               &endTime,
				}
				_ = database.UpdateRun(dbRun)
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
					_ = database.InsertNodeLog(dbNL)
				}
			}

			if runLog.Status != engine.RunStatusSuccess {
				return fmt.Errorf("pipeline failed: %s", runLog.ErrorMessage)
			}
			return nil
		},
	}

	cmd.Flags().StringVarP(&model, "model", "m", "", "Model override (e.g. openai/gpt-4o)")
	cmd.Flags().BoolVar(&noLog, "no-log", false, "Skip logging run to database")
	cmd.Flags().BoolVar(&outputJSON, "json", false, "Output run log as JSON")
	cmd.Flags().StringVar(&prompt, "prompt", "", "Generate a pipeline from a natural-language prompt")

	return cmd
}

func printRunSummary(runLog *engine.RunLog) {
	statusIcon := "✓"
	if runLog.Status == engine.RunStatusFailed {
		statusIcon = "✗"
	} else if runLog.Status == engine.RunStatusCancelled {
		statusIcon = "⊘"
	}

	fmt.Printf("%s Run %s\n", statusIcon, runLog.RunID)
	fmt.Printf("  Status:   %s\n", runLog.Status)
	fmt.Printf("  Duration: %dms\n", runLog.DurationMs)
	fmt.Printf("  Tokens:   %d prompt + %d completion = %d total\n",
		runLog.TotalPromptTokens, runLog.TotalCompletionTokens, runLog.TotalTokens)
	fmt.Printf("  Nodes:    %d\n", len(runLog.NodeLogs))
	if runLog.ErrorMessage != "" {
		fmt.Printf("  Error:    %s\n", runLog.ErrorMessage)
	}
	fmt.Println()

	if len(runLog.NodeLogs) > 0 {
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "NODE\tTYPE\tSTATUS\tDURATION\tTOKENS\tMODEL")
		for _, nl := range runLog.NodeLogs {
			model := nl.Model
			if model == "" {
				model = "-"
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%dms\t%d\t%s\n",
				nl.NodeID, nl.NodeType, nl.Status, nl.DurationMs, nl.TotalTokens, model)
		}
		tw.Flush()
	}
}

// ---------- serve ----------

func serveCmd() *cobra.Command {
	var (
		host string
		port string
	)

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the web dashboard",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := config.Load()
			if err := cfg.EnsureDirs(); err != nil {
				return fmt.Errorf("failed to create dirs: %w", err)
			}

			if host != "" {
				cfg.WebHost = host
			}
			if port != "" {
				cfg.WebPort = port
			}

			database, err := db.Open(cfg.DBPath)
			if err != nil {
				return fmt.Errorf("failed to open database: %w", err)
			}
			defer database.Close()

			llmClient := llm.NewClient(cfg.OpenRouterAPIKey)

			// Find static files directory
			staticDir := findStaticDir()

			srv := web.NewServer(cfg, database, llmClient, staticDir)
			return srv.Start()
		},
	}

	cmd.Flags().StringVar(&host, "host", "", "Listen host (default: localhost)")
	cmd.Flags().StringVar(&port, "port", "", "Listen port (default: 8080)")

	return cmd
}

// findStaticDir locates the web/static directory relative to the binary or CWD
func findStaticDir() string {
	// Check relative to executable
	exe, err := os.Executable()
	if err == nil {
		candidates := []string{
			filepath.Join(filepath.Dir(exe), "web", "static"),
			filepath.Join(filepath.Dir(exe), "..", "web", "static"),
			filepath.Join(filepath.Dir(exe), "..", "..", "web", "static"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				return c
			}
		}
	}
	// Fall back to CWD
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, "web", "static")
}

// ---------- pipeline ----------

func pipelineCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pipeline",
		Short: "Manage pipelines",
	}

	cmd.AddCommand(pipelineListCmd(), pipelineAddCmd(), pipelineDeleteCmd())
	return cmd
}

func pipelineListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List registered pipelines",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := config.Load()
			database, err := db.Open(cfg.DBPath)
			if err != nil {
				return fmt.Errorf("failed to open database: %w", err)
			}
			defer database.Close()

			pipelines, err := database.ListPipelines()
			if err != nil {
				return err
			}

			if len(pipelines) == 0 {
				fmt.Println("No pipelines registered. Use 'attractor pipeline add <file.dot>' to add one.")
				return nil
			}

			tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tNAME\tMODEL\tFILE")
			for _, p := range pipelines {
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", p.ID[:8]+"...", p.Name, p.Model, p.FilePath)
			}
			tw.Flush()
			return nil
		},
	}
}

func pipelineAddCmd() *cobra.Command {
	var (
		name        string
		description string
		model       string
	)

	cmd := &cobra.Command{
		Use:   "add <file.dot>",
		Short: "Register a pipeline from a DOT file",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dotFile := args[0]
			cfg := config.Load()
			database, err := db.Open(cfg.DBPath)
			if err != nil {
				return fmt.Errorf("failed to open database: %w", err)
			}
			defer database.Close()

			data, err := os.ReadFile(dotFile)
			if err != nil {
				return fmt.Errorf("failed to read file: %w", err)
			}

			absPath, _ := filepath.Abs(dotFile)

			if name == "" {
				name = filepath.Base(dotFile)
			}
			if model == "" {
				model = cfg.DefaultModel
			}

			p := &db.Pipeline{
				ID:          uuid.New().String(),
				Name:        name,
				Description: description,
				DotContent:  string(data),
				FilePath:    absPath,
				Model:       model,
			}
			if err := database.UpsertPipeline(p); err != nil {
				return fmt.Errorf("failed to save pipeline: %w", err)
			}

			fmt.Printf("Pipeline registered:\n  ID:   %s\n  Name: %s\n  File: %s\n", p.ID, p.Name, p.FilePath)
			return nil
		},
	}

	cmd.Flags().StringVar(&name, "name", "", "Pipeline name (default: filename)")
	cmd.Flags().StringVar(&description, "description", "", "Pipeline description")
	cmd.Flags().StringVarP(&model, "model", "m", "", "Default model for this pipeline")

	return cmd
}

func pipelineDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete a registered pipeline",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := args[0]
			cfg := config.Load()
			database, err := db.Open(cfg.DBPath)
			if err != nil {
				return fmt.Errorf("failed to open database: %w", err)
			}
			defer database.Close()

			if err := database.DeletePipeline(id); err != nil {
				return fmt.Errorf("failed to delete pipeline: %w", err)
			}
			fmt.Printf("Pipeline %s deleted.\n", id)
			return nil
		},
	}
}

// ---------- models ----------

func modelsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "models",
		Short: "List available models from OpenRouter",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg := config.Load()
			if cfg.OpenRouterAPIKey == "" {
				return fmt.Errorf("OPENROUTER_API_KEY not set")
			}

			client := llm.NewClient(cfg.OpenRouterAPIKey)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			models, err := client.ListModels(ctx)
			if err != nil {
				return fmt.Errorf("failed to list models: %w", err)
			}

			tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tNAME\tCONTEXT")
			for _, m := range models {
				fmt.Fprintf(tw, "%s\t%s\t%d\n", m.ID, m.Name, m.ContextLen)
			}
			tw.Flush()
			return nil
		},
	}
}
