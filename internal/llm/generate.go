package llm

import (
	"context"
	"fmt"
	"strings"
)

const dotGenerationSystemPrompt = `You are an expert at designing AI pipeline workflows using Graphviz DOT syntax for the Attractor pipeline runner.

Given a natural-language goal, produce a valid Attractor DOT pipeline that accomplishes it.

Rules:
- Output ONLY the raw DOT source, no markdown fences, no explanation.
- The graph must be a digraph.
- Always include a graph-level "goal" attribute that captures the user's intent.
- Always start with a node shaped Mdiamond labeled "Start" and end with a node shaped Msquare labeled "End".
- Use shape=box for LLM nodes; set a "prompt" attribute that instructs the LLM step.
- For multi-step workflows, chain LLM nodes logically (research → analyse → summarize, etc.).
- Use {{last_response}} to pass output from one node's prompt to the next.
- Use $goal to reference the top-level goal inside prompts.
- Keep pipelines focused: 2–5 LLM nodes is typical; do not over-engineer.
- Set default_max_retry = 1 on the graph.

Example of a valid two-node pipeline:
digraph simple_research {
    graph [
        goal = "Research quantum computing and summarize"
        default_max_retry = 1
    ]
    start     [shape=Mdiamond, label="Start"]
    research  [shape=box, label="Research",  prompt="Research this topic thoroughly: $goal\n\nProvide key facts and recent developments."]
    summarize [shape=box, label="Summarize", prompt="Write a concise 3-paragraph summary for a technical audience.\n\nResearch: {{last_response}}"]
    exit      [shape=Msquare, label="End"]
    start -> research -> summarize -> exit
}`

// GenerateDOT calls the LLM to produce an Attractor DOT pipeline definition
// from a natural-language prompt.
func (c *Client) GenerateDOT(ctx context.Context, prompt, model string) (string, error) {
	resp, err := c.Complete(ctx, ChatRequest{
		Model: model,
		Messages: []Message{
			{Role: "system", Content: dotGenerationSystemPrompt},
			{Role: "user", Content: prompt},
		},
		MaxTokens:   2048,
		Temperature: 0.2,
	})
	if err != nil {
		return "", fmt.Errorf("LLM error: %w", err)
	}
	raw := strings.TrimSpace(resp.GetText())
	// Strip any accidental markdown code fences the model may have added
	raw = strings.TrimPrefix(raw, "```dot")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	return strings.TrimSpace(raw), nil
}
