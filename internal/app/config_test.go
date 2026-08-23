package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadConfigLocalDefaults(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "config.yaml")
	contents := `
server:
  public_url: "http://localhost:9090"
data_dir: data
site_dir: site
database:
  driver: sqlite
auth:
  mode: stub
  session_secret: "123456789012345678901234"
`
	require.NoError(t, os.WriteFile(path, []byte(contents), 0o600))
	cfg, err := LoadConfig(path)
	require.NoError(t, err)
	assert.Equal(t, "127.0.0.1:8080", cfg.Server.Address)
	assert.Equal(t, filepath.Join(directory, "data", "touchzouk.db"), cfg.Database.DSN)
	assert.Equal(t, 1024, cfg.Media.WaveformPoints)
}

func TestStubAuthRejectsNonLoopbackListenWithoutOptIn(t *testing.T) {
	cfg := Config{
		Server: ServerConfig{Address: ":8080", PublicURL: "http://localhost:8080"},
		Auth:   AuthConfig{Mode: "stub", SessionSecret: strings.Repeat("x", 32)},
	}
	err := cfg.applyDefaults(t.TempDir())
	require.ErrorContains(t, err, "server.address")
	cfg.Auth.StubAllowRemote = true
	require.NoError(t, cfg.applyDefaults(t.TempDir()))
}

func TestPublicURLRequiresHostname(t *testing.T) {
	cfg := Config{
		Server: ServerConfig{Address: ":8080"},
		Auth:   AuthConfig{Mode: "stub", SessionSecret: strings.Repeat("x", 32)},
	}
	require.ErrorContains(t, cfg.applyDefaults(t.TempDir()), "hostname")
}

func TestLoadConfigRejectsUnknownField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := `
server:
  public_url: "http://localhost:8080"
unknown: true
auth:
  mode: stub
  session_secret: "123456789012345678901234"
`
	require.NoError(t, os.WriteFile(path, []byte(contents), 0o600))
	_, err := LoadConfig(path)
	require.ErrorContains(t, err, "field unknown")
}

func TestLoadConfigRejectsTrailingDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := `
server:
  public_url: "http://localhost:8080"
auth:
  mode: stub
  session_secret: "123456789012345678901234"
---
auth:
  mode: zitadel
`
	require.NoError(t, os.WriteFile(path, []byte(contents), 0o600))
	_, err := LoadConfig(path)
	require.ErrorContains(t, err, "exactly one YAML document")
}

func TestLoadConfigExpandsOnlyExactEnvironmentReferences(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "config.yaml")
	t.Setenv("TOUCHZOUK_TEST_STUB_USER", "Admin: \"$cash\"\nsecond line")
	contents := `
server:
  public_url: "http://localhost:8080"
auth:
  mode: stub
  session_secret: "123456789012345678901234"
  stub_user: "${TOUCHZOUK_TEST_STUB_USER}"
`
	require.NoError(t, os.WriteFile(path, []byte(contents), 0o600))
	cfg, err := LoadConfig(path)
	require.NoError(t, err)
	assert.Equal(t, "Admin: \"$cash\"\nsecond line", cfg.Auth.StubUser)
}

func TestLoadConfigRejectsUnsetExactEnvironmentReference(t *testing.T) {
	const variable = "TOUCHZOUK_TEST_MISSING_EXACT_ENVIRONMENT_REFERENCE"
	require.NoError(t, os.Unsetenv(variable))
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := `
server:
  public_url: "http://localhost:8080"
auth:
  mode: stub
  session_secret: "${TOUCHZOUK_TEST_MISSING_EXACT_ENVIRONMENT_REFERENCE}"
`
	require.NoError(t, os.WriteFile(path, []byte(contents), 0o600))
	_, err := LoadConfig(path)
	require.ErrorContains(t, err, variable)
}

func TestZitadelRequiresSecureCookies(t *testing.T) {
	cfg := validZitadelConfig()
	cfg.Auth.SecureCookies = false
	require.ErrorContains(t, cfg.applyDefaults(t.TempDir()), "secure_cookies")
}

func TestZitadelRejectsHTTPIssuer(t *testing.T) {
	cfg := validZitadelConfig()
	cfg.Auth.Zitadel.Issuer = "http://id.example"
	require.ErrorContains(t, cfg.applyDefaults(t.TempDir()), "issuer")
}

func TestZitadelRequiresHTTPSPublicURL(t *testing.T) {
	cfg := validZitadelConfig()
	cfg.Server.PublicURL = "http://touchzo.uk"
	require.ErrorContains(t, cfg.applyDefaults(t.TempDir()), "public_url")
}

func TestZitadelRedirectMustUsePublicOriginAndCallbackPath(t *testing.T) {
	for name, redirectURL := range map[string]string{
		"different host": "https://attacker.example/auth/callback",
		"wrong path":     "https://touchzo.uk/callback",
		"userinfo":       "https://admin@touchzo.uk/auth/callback",
		"encoded path":   "https://touchzo.uk/auth%2Fcallback",
	} {
		t.Run(name, func(t *testing.T) {
			cfg := validZitadelConfig()
			cfg.Auth.Zitadel.RedirectURL = redirectURL
			require.ErrorContains(t, cfg.applyDefaults(t.TempDir()), "redirect_url")
		})
	}
}

func TestZitadelRedirectAllowsExplicitDefaultHTTPSPort(t *testing.T) {
	cfg := validZitadelConfig()
	cfg.Auth.Zitadel.RedirectURL = "https://touchzo.uk:443/auth/callback"
	require.NoError(t, cfg.applyDefaults(t.TempDir()))
}

func validZitadelConfig() Config {
	return Config{
		Server: ServerConfig{PublicURL: "https://touchzo.uk"},
		Auth: AuthConfig{
			Mode: "zitadel", SessionSecret: strings.Repeat("x", 32), SecureCookies: true,
			Zitadel: ZitadelConfig{
				Issuer: "https://id.example", ClientID: "client",
				RedirectURL: "https://touchzo.uk/auth/callback",
				ProjectID:   "project", AdminRole: "admin",
			},
		},
	}
}
