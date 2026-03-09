// Package config handles Attractor configuration.
package config

import (
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
)

// Config holds the global configuration
type Config struct {
	OpenRouterAPIKey string
	DefaultModel     string
	LogsDir          string
	DBPath           string
	WebHost          string
	WebPort          string
}

// DefaultModel is the fallback model if none is configured
const DefaultModelName = "openai/gpt-4o"

// Load loads configuration from environment variables and .env files
func Load() *Config {
	// Try to load .env from current dir and home dir
	_ = godotenv.Load(".env")
	home, _ := os.UserHomeDir()
	_ = godotenv.Load(filepath.Join(home, ".attractor", ".env"))
	_ = godotenv.Load(filepath.Join(home, ".attractor.env"))

	cfg := &Config{
		OpenRouterAPIKey: getEnv("OPENROUTER_API_KEY", ""),
		DefaultModel:     getEnv("ATTRACTOR_MODEL", DefaultModelName),
		LogsDir:          getEnv("ATTRACTOR_LOGS_DIR", defaultLogsDir()),
		DBPath:           getEnv("ATTRACTOR_DB_PATH", defaultDBPath()),
		WebHost:          getEnv("ATTRACTOR_WEB_HOST", "localhost"),
		WebPort:          getEnv("ATTRACTOR_WEB_PORT", "8080"),
	}

	return cfg
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func defaultLogsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".attractor/logs"
	}
	return filepath.Join(home, ".attractor", "logs")
}

func defaultDBPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".attractor/attractor.db"
	}
	return filepath.Join(home, ".attractor", "attractor.db")
}

// EnsureDirs creates necessary directories
func (c *Config) EnsureDirs() error {
	dirs := []string{
		c.LogsDir,
		filepath.Dir(c.DBPath),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return err
		}
	}
	return nil
}
