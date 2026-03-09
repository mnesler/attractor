package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const OpenRouterBaseURL = "https://openrouter.ai/api/v1"

// Message represents a chat message
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatRequest is the request body for OpenRouter chat completions
type ChatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
	Temperature float64   `json:"temperature,omitempty"`
	Stream      bool      `json:"stream,omitempty"`
}

// ChatChoice represents a single completion choice
type ChatChoice struct {
	Index   int     `json:"index"`
	Message Message `json:"message"`
}

// Usage tracks token usage
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// ChatResponse is the response from OpenRouter
type ChatResponse struct {
	ID      string       `json:"id"`
	Model   string       `json:"model"`
	Choices []ChatChoice `json:"choices"`
	Usage   Usage        `json:"usage"`
	Error   *APIError    `json:"error,omitempty"`
}

// APIError represents an error returned by the API
type APIError struct {
	Message string `json:"message"`
	Code    int    `json:"code,omitempty"`
	Type    string `json:"type,omitempty"`
}

func (e *APIError) Error() string {
	return fmt.Sprintf("OpenRouter API error (code=%d type=%s): %s", e.Code, e.Type, e.Message)
}

// Model represents an available model
type Model struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	ContextLen  int     `json:"context_length"`
	Pricing     Pricing `json:"pricing"`
}

// Pricing holds model pricing info
type Pricing struct {
	Prompt     string `json:"prompt"`
	Completion string `json:"completion"`
}

// Client is the OpenRouter LLM client
type Client struct {
	APIKey     string
	BaseURL    string
	HTTPClient *http.Client
}

// NewClient creates a new OpenRouter client
func NewClient(apiKey string) *Client {
	return &Client{
		APIKey:  apiKey,
		BaseURL: OpenRouterBaseURL,
		HTTPClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// Complete sends a chat completion request and returns the response
func (c *Client) Complete(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("HTTP-Referer", "https://github.com/attractor/attractor")
	httpReq.Header.Set("X-Title", "Attractor Pipeline Runner")

	resp, err := c.HTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var apiErr struct {
			Error APIError `json:"error"`
		}
		if jsonErr := json.Unmarshal(respBody, &apiErr); jsonErr == nil && apiErr.Error.Message != "" {
			apiErr.Error.Code = resp.StatusCode
			return nil, &apiErr.Error
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var chatResp ChatResponse
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if chatResp.Error != nil {
		return nil, chatResp.Error
	}

	return &chatResp, nil
}

// GetText returns the first text response from a chat response
func (r *ChatResponse) GetText() string {
	if len(r.Choices) == 0 {
		return ""
	}
	return r.Choices[0].Message.Content
}

// ListModels fetches available models from OpenRouter
func (c *Client) ListModels(ctx context.Context) ([]Model, error) {
	httpReq, err := http.NewRequestWithContext(ctx, "GET", c.BaseURL+"/models", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.APIKey)

	resp, err := c.HTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Data []Model `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse models response: %w", err)
	}

	return result.Data, nil
}

// IsRetryable returns true if the error is transient and retrying may help
func IsRetryable(err error) bool {
	if err == nil {
		return false
	}
	if apiErr, ok := err.(*APIError); ok {
		// Retry on rate limits and server errors
		return apiErr.Code == 429 || apiErr.Code >= 500
	}
	return false
}
