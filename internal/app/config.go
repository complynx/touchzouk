package app

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

type Config struct {
	Server   ServerConfig   `yaml:"server"`
	DataDir  string         `yaml:"data_dir"`
	SiteDir  string         `yaml:"site_dir"`
	Database DatabaseConfig `yaml:"database"`
	Media    MediaConfig    `yaml:"media"`
	Auth     AuthConfig     `yaml:"auth"`
}

type ServerConfig struct {
	Address   string `yaml:"address"`
	PublicURL string `yaml:"public_url"`
}

type DatabaseConfig struct {
	Driver string `yaml:"driver"`
	DSN    string `yaml:"dsn"`
}

type MediaConfig struct {
	FFmpegPath     string `yaml:"ffmpeg_path"`
	FFprobePath    string `yaml:"ffprobe_path"`
	MaxUploadMB    int64  `yaml:"max_upload_mb"`
	WaveformPoints int    `yaml:"waveform_points"`
}

type AuthConfig struct {
	Mode            string        `yaml:"mode"`
	SessionSecret   string        `yaml:"session_secret"`
	StubUser        string        `yaml:"stub_user"`
	StubAllowRemote bool          `yaml:"stub_allow_remote"`
	SecureCookies   bool          `yaml:"secure_cookies"`
	Zitadel         ZitadelConfig `yaml:"zitadel"`
}

type ZitadelConfig struct {
	Issuer       string `yaml:"issuer"`
	ClientID     string `yaml:"client_id"`
	ClientSecret string `yaml:"client_secret"`
	RedirectURL  string `yaml:"redirect_url"`
	ProjectID    string `yaml:"project_id"`
	AdminRole    string `yaml:"admin_role"`
}

func LoadConfig(path string) (Config, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	decoder := yaml.NewDecoder(strings.NewReader(string(contents)))
	decoder.KnownFields(true)
	if decodeErr := decoder.Decode(&cfg); decodeErr != nil {
		return Config{}, fmt.Errorf("decode YAML: %w", decodeErr)
	}
	if trailingErr := decoder.Decode(&struct{}{}); !errors.Is(trailingErr, io.EOF) {
		return Config{}, errors.New("config must contain exactly one YAML document")
	}
	if expandErr := cfg.expandEnvironment(); expandErr != nil {
		return Config{}, expandErr
	}
	if defaultsErr := cfg.applyDefaults(filepath.Dir(path)); defaultsErr != nil {
		return Config{}, defaultsErr
	}
	return cfg, nil
}

var environmentReference = regexp.MustCompile(`^\$\{([A-Z_][A-Z0-9_]*)\}$`)

func (c *Config) expandEnvironment() error {
	fields := []struct {
		name  string
		value *string
	}{
		{"server.address", &c.Server.Address},
		{"server.public_url", &c.Server.PublicURL},
		{"data_dir", &c.DataDir},
		{"site_dir", &c.SiteDir},
		{"database.driver", &c.Database.Driver},
		{"database.dsn", &c.Database.DSN},
		{"media.ffmpeg_path", &c.Media.FFmpegPath},
		{"media.ffprobe_path", &c.Media.FFprobePath},
		{"auth.mode", &c.Auth.Mode},
		{"auth.session_secret", &c.Auth.SessionSecret},
		{"auth.stub_user", &c.Auth.StubUser},
		{"auth.zitadel.issuer", &c.Auth.Zitadel.Issuer},
		{"auth.zitadel.client_id", &c.Auth.Zitadel.ClientID},
		{"auth.zitadel.client_secret", &c.Auth.Zitadel.ClientSecret},
		{"auth.zitadel.redirect_url", &c.Auth.Zitadel.RedirectURL},
		{"auth.zitadel.project_id", &c.Auth.Zitadel.ProjectID},
		{"auth.zitadel.admin_role", &c.Auth.Zitadel.AdminRole},
	}
	for _, field := range fields {
		match := environmentReference.FindStringSubmatch(*field.value)
		if match == nil {
			continue
		}
		expanded, ok := os.LookupEnv(match[1])
		if !ok {
			return fmt.Errorf("%s references unset environment variable %s", field.name, match[1])
		}
		*field.value = expanded
	}
	return nil
}

func (c *Config) applyDefaults(configDir string) error {
	if err := c.applyServerDefaults(); err != nil {
		return err
	}
	c.applyPathDefaults(configDir)
	if err := c.applyDatabaseDefaults(configDir); err != nil {
		return err
	}
	if err := c.applyMediaDefaults(); err != nil {
		return err
	}
	return c.applyAuthDefaults()
}

func (c *Config) applyServerDefaults() error {
	if c.Server.Address == "" {
		c.Server.Address = "127.0.0.1:8080"
	}
	if c.Server.PublicURL == "" {
		c.Server.PublicURL = "http://" + c.Server.Address
	}
	publicURL, err := url.Parse(c.Server.PublicURL)
	if err != nil || publicURL.Scheme == "" || publicURL.Hostname() == "" ||
		publicURL.User != nil || publicURL.RawQuery != "" || publicURL.ForceQuery || publicURL.Fragment != "" {
		return errors.New(
			"server.public_url must be an absolute URL with a hostname and without userinfo, query, or fragment",
		)
	}
	c.Server.PublicURL = strings.TrimRight(c.Server.PublicURL, "/")
	return nil
}

func (c *Config) applyPathDefaults(configDir string) {
	if c.DataDir == "" {
		c.DataDir = "./data"
	}
	if !filepath.IsAbs(c.DataDir) {
		c.DataDir = filepath.Clean(filepath.Join(configDir, c.DataDir))
	}
	if c.SiteDir == "" {
		c.SiteDir = "./site"
	}
	if !filepath.IsAbs(c.SiteDir) {
		c.SiteDir = filepath.Clean(filepath.Join(configDir, c.SiteDir))
	}
}

func (c *Config) applyDatabaseDefaults(configDir string) error {
	if c.Database.Driver == "" {
		c.Database.Driver = databaseDriverSQLite
	}
	c.Database.Driver = strings.ToLower(c.Database.Driver)
	if c.Database.Driver != databaseDriverSQLite && c.Database.Driver != databaseDriverPostgres {
		return errors.New("database.driver must be sqlite or postgres")
	}
	if c.Database.DSN == "" {
		if c.Database.Driver == databaseDriverPostgres {
			return errors.New("database.dsn is required for postgres")
		}
		c.Database.DSN = filepath.Join(c.DataDir, "touchzouk.db")
	} else if c.Database.Driver == databaseDriverSQLite && !filepath.IsAbs(c.Database.DSN) {
		c.Database.DSN = filepath.Clean(filepath.Join(configDir, c.Database.DSN))
	}
	return nil
}

func (c *Config) applyMediaDefaults() error {
	if c.Media.FFmpegPath == "" {
		c.Media.FFmpegPath = "ffmpeg"
	}
	if c.Media.FFprobePath == "" {
		c.Media.FFprobePath = "ffprobe"
	}
	if c.Media.MaxUploadMB <= 0 {
		c.Media.MaxUploadMB = 1024
	}
	if c.Media.WaveformPoints <= 0 {
		c.Media.WaveformPoints = 1024
	}
	if c.Media.WaveformPoints < 64 || c.Media.WaveformPoints > 4096 {
		return errors.New("media.waveform_points must be between 64 and 4096")
	}
	return nil
}

func (c *Config) applyAuthDefaults() error {
	c.Auth.Mode = strings.ToLower(c.Auth.Mode)
	if c.Auth.Mode == "" {
		return errors.New("auth.mode must be explicitly set to stub or zitadel")
	}
	if c.Auth.Mode != authModeStub && c.Auth.Mode != authModeZitadel {
		return errors.New("auth.mode must be stub or zitadel")
	}
	if len(c.Auth.SessionSecret) < 24 {
		return errors.New("auth.session_secret must be at least 24 characters")
	}
	if c.Auth.Mode == authModeStub {
		return c.validateStubAuth()
	}
	return c.validateZitadelAuth()
}

func (c *Config) validateStubAuth() error {
	parsedPublicURL, err := url.Parse(c.Server.PublicURL)
	if err != nil {
		return errors.New("auth.mode stub is allowed only for loopback or .localhost public URLs")
	}
	publicHost := parsedPublicURL.Hostname()
	localPublicHost := publicHost == "localhost" || strings.HasSuffix(publicHost, ".localhost") ||
		publicHost == "127.0.0.1" || publicHost == "::1"
	if publicHost == "" || !localPublicHost {
		return errors.New("auth.mode stub is allowed only for loopback or .localhost public URLs")
	}
	listenHost, _, err := net.SplitHostPort(c.Server.Address)
	if err != nil {
		return fmt.Errorf("server.address must include a host and port: %w", err)
	}
	listenIP := net.ParseIP(listenHost)
	loopbackListenHost := strings.EqualFold(listenHost, "localhost") ||
		listenIP != nil && listenIP.IsLoopback()
	if !c.Auth.StubAllowRemote && !loopbackListenHost {
		return errors.New(
			"auth.mode stub requires a loopback server.address unless auth.stub_allow_remote is explicitly true",
		)
	}
	if c.Auth.StubUser == "" {
		c.Auth.StubUser = "Local administrator"
	}
	return nil
}

func (c *Config) validateZitadelAuth() error {
	if !c.Auth.SecureCookies {
		return errors.New("auth.secure_cookies must be true with ZITADEL")
	}
	publicURL, err := url.Parse(c.Server.PublicURL)
	if err != nil || publicURL.Scheme != "https" {
		return errors.New("server.public_url must use HTTPS with ZITADEL")
	}
	z := c.Auth.Zitadel
	if z.Issuer == "" || z.ClientID == "" || z.RedirectURL == "" || z.ProjectID == "" || z.AdminRole == "" {
		return errors.New("auth.zitadel issuer, client_id, redirect_url, project_id, and admin_role are required")
	}
	issuer, err := url.Parse(z.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil ||
		issuer.RawQuery != "" || issuer.Fragment != "" {
		return errors.New("auth.zitadel.issuer must be an absolute HTTPS URL without userinfo, query, or fragment")
	}
	return validateZitadelRedirect(publicURL, z.RedirectURL)
}

func validateZitadelRedirect(publicURL *url.URL, redirectURL string) error {
	redirect, err := url.Parse(redirectURL)
	if err != nil || redirect.Scheme != "https" || redirect.Host == "" || redirect.User != nil ||
		redirect.RawQuery != "" || redirect.ForceQuery || redirect.Fragment != "" ||
		redirect.EscapedPath() != "/auth/callback" || !sameURLOrigin(publicURL, redirect) {
		return errors.New(
			"auth.zitadel.redirect_url must use server.public_url's origin and the exact /auth/callback path",
		)
	}
	return nil
}

func sameURLOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Hostname(), right.Hostname()) &&
		originPort(left) == originPort(right)
}

func originPort(value *url.URL) string {
	if port := value.Port(); port != "" {
		return port
	}
	if strings.EqualFold(value.Scheme, "https") {
		return "443"
	}
	if strings.EqualFold(value.Scheme, "http") {
		return "80"
	}
	return ""
}
