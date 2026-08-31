package app

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	sessionCookieName = "touchzouk_admin"
	flowCookieName    = "touchzouk_oidc"
	stubSessionLength = 12 * time.Hour
	refreshCookieLife = 30 * 24 * time.Hour
	refreshWindow     = 15 * time.Minute
)

var (
	errRefreshLoginRequired = errors.New("administrator login required")
	errRefreshUnavailable   = errors.New("identity provider refresh unavailable")
)

type AdminIdentity struct {
	Subject string `json:"sub"`
	Name    string `json:"name"`
	Expires int64  `json:"exp"`
}

type adminSession struct {
	Identity     AdminIdentity `json:"identity"`
	RefreshToken string        `json:"refresh_token,omitempty"`
	RefreshUntil int64         `json:"refresh_until,omitempty"`
}

type authContextKey struct{}

type oidcFlow struct {
	State    string    `json:"state"`
	Verifier string    `json:"verifier"`
	Nonce    string    `json:"nonce"`
	Expires  time.Time `json:"expires"`
}

type Authenticator struct {
	cfg       AuthConfig
	key       []byte
	provider  *oidc.Provider
	oauth     oauth2.Config
	revokeURL string
	now       func() time.Time
}

func NewAuthenticator(ctx context.Context, cfg AuthConfig) (*Authenticator, error) {
	auth := &Authenticator{
		cfg: cfg,
		key: []byte(cfg.SessionSecret),
		now: time.Now,
	}
	if cfg.Mode == authModeStub {
		return auth, nil
	}
	provider, err := oidc.NewProvider(ctx, cfg.Zitadel.Issuer)
	if err != nil {
		return nil, fmt.Errorf("discover ZITADEL: %w", err)
	}
	auth.provider = provider
	var metadata struct {
		RevocationEndpoint string `json:"revocation_endpoint"`
	}
	if err := provider.Claims(&metadata); err != nil {
		return nil, fmt.Errorf("read ZITADEL discovery metadata: %w", err)
	}
	if metadata.RevocationEndpoint == "" {
		return nil, errors.New("ZITADEL discovery metadata has no revocation endpoint")
	}
	auth.revokeURL = metadata.RevocationEndpoint
	auth.oauth = oauth2.Config{
		ClientID:     cfg.Zitadel.ClientID,
		ClientSecret: cfg.Zitadel.ClientSecret,
		Endpoint:     provider.Endpoint(),
		RedirectURL:  cfg.Zitadel.RedirectURL,
		Scopes:       zitadelScopes(cfg.Zitadel.ProjectID),
	}
	return auth, nil
}

func zitadelScopes(projectID string) []string {
	scopes := []string{oidc.ScopeOpenID, "profile", "offline_access", "urn:zitadel:iam:org:projects:roles"}
	if projectID != "" {
		scopes = append(scopes, "urn:zitadel:iam:org:project:id:"+projectID+":aud")
	}
	return scopes
}

func (a *Authenticator) Login(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode == authModeStub {
		if err := a.setSession(w, AdminIdentity{
			Subject: "stub-admin",
			Name:    a.cfg.StubUser,
			Expires: a.now().Add(stubSessionLength).Unix(),
		}); err != nil {
			http.Error(w, "could not begin login", http.StatusInternalServerError)
			return
		}
		http.Redirect(w, r, "/admin", http.StatusSeeOther)
		return
	}

	state, err := randomToken(32)
	if err != nil {
		http.Error(w, "could not begin login", http.StatusInternalServerError)
		return
	}
	nonce, err := randomToken(32)
	if err != nil {
		http.Error(w, "could not begin login", http.StatusInternalServerError)
		return
	}
	verifier := oauth2.GenerateVerifier()
	flow := oidcFlow{State: state, Verifier: verifier, Nonce: nonce, Expires: a.now().Add(10 * time.Minute)}
	flowJSON, err := json.Marshal(flow)
	if err != nil {
		http.Error(w, "could not begin login", http.StatusInternalServerError)
		return
	}
	a.setSignedCookie(w, flowCookieName, string(flowJSON), 10*time.Minute)

	location := a.oauth.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(verifier),
	)
	http.Redirect(w, r, location, http.StatusFound)
}

func (a *Authenticator) Callback(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode != authModeZitadel {
		http.NotFound(w, r)
		return
	}
	state := r.URL.Query().Get("state")
	if state == "" || r.URL.Query().Get("code") == "" {
		http.Error(w, "invalid login callback", http.StatusBadRequest)
		return
	}
	flowJSON, err := a.readSignedCookie(r, flowCookieName)
	var flow oidcFlow
	flowErr := json.Unmarshal([]byte(flowJSON), &flow)
	stateMatches := subtle.ConstantTimeCompare([]byte(state), []byte(flow.State)) == 1
	if err != nil || flowErr != nil || !stateMatches {
		http.Error(w, "invalid login state", http.StatusBadRequest)
		return
	}
	if flow.Expires.Before(a.now()) {
		http.Error(w, "login state expired", http.StatusBadRequest)
		return
	}

	token, err := a.oauth.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.VerifierOption(flow.Verifier))
	if err != nil {
		http.Error(w, "ZITADEL login failed", http.StatusBadGateway)
		return
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		http.Error(w, "ZITADEL did not return an ID token", http.StatusBadGateway)
		return
	}
	if token.RefreshToken == "" {
		http.Error(w, "ZITADEL did not return a refresh token", http.StatusBadGateway)
		return
	}
	identity, err := a.identityFromIDToken(r.Context(), rawIDToken, flow.Nonce)
	if errors.Is(err, errAdminRoleRequired) {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	if err != nil {
		http.Error(w, "invalid ZITADEL ID token", http.StatusUnauthorized)
		return
	}
	if err := a.setRefreshableSession(w, identity, token.RefreshToken); err != nil {
		http.Error(w, "could not save login", http.StatusInternalServerError)
		return
	}
	a.clearCookie(w, flowCookieName)
	http.Redirect(w, r, "/admin", http.StatusSeeOther)
}

func (a *Authenticator) Logout(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode == authModeZitadel {
		session, err := a.readSession(r)
		if err == nil && session.RefreshToken != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			if revokeErr := a.revokeRefreshToken(ctx, session.RefreshToken); revokeErr != nil {
				slog.Warn("revoke administrator refresh token", "error", revokeErr)
			}
			cancel()
		}
	}
	a.clearCookie(w, sessionCookieName)
	http.Redirect(w, r, "/listen", http.StatusSeeOther)
}

func (a *Authenticator) revokeRefreshToken(ctx context.Context, refreshToken string) error {
	form := url.Values{"token": {refreshToken}}
	if a.cfg.Zitadel.ClientSecret == "" {
		form.Set("client_id", a.cfg.Zitadel.ClientID)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, a.revokeURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if a.cfg.Zitadel.ClientSecret != "" {
		request.SetBasicAuth(a.cfg.Zitadel.ClientID, a.cfg.Zitadel.ClientSecret)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("ZITADEL token revocation returned %s", response.Status)
	}
	return nil
}

func (a *Authenticator) Identity(r *http.Request) (AdminIdentity, bool) {
	session, err := a.readSession(r)
	if err != nil || session.Identity.Expires <= a.now().Unix() {
		return AdminIdentity{}, false
	}
	return session.Identity, true
}

func (a *Authenticator) RefreshSession(w http.ResponseWriter, r *http.Request) (AdminIdentity, error) {
	session, err := a.readSession(r)
	if err != nil {
		return AdminIdentity{}, errRefreshLoginRequired
	}
	if a.cfg.Mode == authModeStub {
		session.Identity.Expires = a.now().Add(stubSessionLength).Unix()
		if setErr := a.setSession(w, session.Identity); setErr != nil {
			return AdminIdentity{}, setErr
		}
		return session.Identity, nil
	}
	if session.Identity.Expires > a.now().Add(refreshWindow).Unix() {
		return session.Identity, nil
	}
	if session.RefreshToken == "" {
		return AdminIdentity{}, errRefreshLoginRequired
	}
	current := &oauth2.Token{RefreshToken: session.RefreshToken, Expiry: a.now().Add(-time.Minute)}
	refreshed, err := a.oauth.TokenSource(r.Context(), current).Token()
	if err != nil {
		var retrieveErr *oauth2.RetrieveError
		if errors.As(err, &retrieveErr) && retrieveErr.ErrorCode == "invalid_grant" {
			return AdminIdentity{}, errRefreshLoginRequired
		}
		return AdminIdentity{}, fmt.Errorf("%w: %w", errRefreshUnavailable, err)
	}
	rawIDToken, ok := refreshed.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return AdminIdentity{}, errRefreshLoginRequired
	}
	identity, err := a.identityFromIDToken(r.Context(), rawIDToken, "")
	if err != nil || identity.Subject != session.Identity.Subject {
		return AdminIdentity{}, errRefreshLoginRequired
	}
	refreshToken := refreshed.RefreshToken
	if refreshToken == "" {
		refreshToken = session.RefreshToken
	}
	if err := a.setRefreshableSession(w, identity, refreshToken); err != nil {
		return AdminIdentity{}, err
	}
	return identity, nil
}

func (a *Authenticator) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity, ok := a.Identity(r)
		if !ok {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "administrator login required"})
			} else {
				http.Redirect(w, r, "/auth/login", http.StatusSeeOther)
			}
			return
		}
		ctx := context.WithValue(r.Context(), authContextKey{}, identity)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func identityFromContext(ctx context.Context) AdminIdentity {
	identity, _ := ctx.Value(authContextKey{}).(AdminIdentity)
	return identity
}

func (a *Authenticator) identityFromIDToken(
	ctx context.Context,
	rawIDToken string,
	nonce string,
) (AdminIdentity, error) {
	idToken, err := a.provider.Verifier(&oidc.Config{ClientID: a.cfg.Zitadel.ClientID}).Verify(ctx, rawIDToken)
	if err != nil {
		return AdminIdentity{}, err
	}
	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		return AdminIdentity{}, err
	}
	if nonce != "" && claimString(claims, "nonce") != nonce {
		return AdminIdentity{}, errors.New("invalid ZITADEL nonce")
	}
	if !hasProjectRole(claims, a.cfg.Zitadel.ProjectID, a.cfg.Zitadel.AdminRole) {
		return AdminIdentity{}, errAdminRoleRequired
	}
	name := claimString(claims, "name")
	if name == "" {
		name = claimString(claims, "preferred_username")
	}
	if name == "" {
		name = "Administrator"
	}
	sessionExpiry := a.now().Add(2 * time.Hour)
	if idToken.Expiry.Before(sessionExpiry) {
		sessionExpiry = idToken.Expiry
	}
	return AdminIdentity{Subject: idToken.Subject, Name: name, Expires: sessionExpiry.Unix()}, nil
}

var errAdminRoleRequired = errors.New("the ZITADEL admin role is required")

func (a *Authenticator) setSession(w http.ResponseWriter, identity AdminIdentity) error {
	return a.setEncryptedSessionCookie(
		w,
		adminSession{Identity: identity},
		time.Unix(identity.Expires, 0).Sub(a.now()),
	)
}

func (a *Authenticator) setRefreshableSession(
	w http.ResponseWriter,
	identity AdminIdentity,
	refreshToken string,
) error {
	session := adminSession{
		Identity: identity, RefreshToken: refreshToken,
		RefreshUntil: a.now().Add(refreshCookieLife).Unix(),
	}
	return a.setEncryptedSessionCookie(w, session, refreshCookieLife)
}

func (a *Authenticator) setEncryptedSessionCookie(
	w http.ResponseWriter,
	session adminSession,
	lifetime time.Duration,
) error {
	contents, err := json.Marshal(session) //nolint:gosec // The refresh token is immediately encrypted with AES-GCM.
	if err != nil {
		return err
	}
	key := sha256.Sum256(a.key)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	sealed := gcm.Seal(nonce, nonce, contents, []byte(sessionCookieName))
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // Secure is required for ZITADEL; loopback stub auth may use HTTP.
		Name: sessionCookieName, Value: "v2_" + base64.RawURLEncoding.EncodeToString(sealed), Path: "/",
		HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteLaxMode,
		MaxAge: int(lifetime.Seconds()),
	})
	return nil
}

func (a *Authenticator) readSession(r *http.Request) (adminSession, error) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return adminSession{}, err
	}
	if !strings.HasPrefix(cookie.Value, "v2_") {
		return adminSession{}, errors.New("obsolete administrator session")
	}
	return a.readEncryptedSession(cookie.Value)
}

func (a *Authenticator) readEncryptedSession(value string) (adminSession, error) {
	sealed, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, "v2_"))
	if err != nil {
		return adminSession{}, err
	}
	key := sha256.Sum256(a.key)
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return adminSession{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(sealed) < gcm.NonceSize() {
		return adminSession{}, errors.New("invalid encrypted session")
	}
	contents, err := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], []byte(sessionCookieName))
	if err != nil {
		return adminSession{}, err
	}
	var session adminSession
	if err := json.Unmarshal(contents, &session); err != nil || session.Identity.Subject == "" ||
		session.RefreshToken != "" && session.RefreshUntil <= a.now().Unix() {
		return adminSession{}, errors.New("invalid encrypted session")
	}
	return session, nil
}

func (a *Authenticator) setSignedCookie(w http.ResponseWriter, name, value string, lifetime time.Duration) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(value))
	mac := hmac.New(sha256.New, a.key)
	_, _ = mac.Write([]byte(name + "\x00" + payload))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // Secure is required for ZITADEL; loopback stub auth may use HTTP.
		Name: name, Value: payload + "." + signature, Path: "/",
		HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteLaxMode,
		MaxAge: int(lifetime.Seconds()),
	})
}

func (a *Authenticator) readSignedCookie(r *http.Request, name string) (string, error) {
	cookie, err := r.Cookie(name)
	if err != nil {
		return "", err
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return "", errors.New("invalid signed cookie")
	}
	mac := hmac.New(sha256.New, a.key)
	_, _ = mac.Write([]byte(name + "\x00" + parts[0]))
	expected := mac.Sum(nil)
	actual, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(expected, actual) {
		return "", errors.New("invalid cookie signature")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	return string(decoded), err
}

func (a *Authenticator) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // Secure is required for ZITADEL; loopback stub auth may use HTTP.
		Name: name, Value: "", Path: "/", HttpOnly: true, Secure: a.cfg.SecureCookies,
		SameSite: http.SameSiteLaxMode, MaxAge: -1,
	})
}

func randomToken(bytes int) (string, error) {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func claimString(claims map[string]any, key string) string {
	value, _ := claims[key].(string)
	return value
}

func hasProjectRole(claims map[string]any, projectID, role string) bool {
	if projectID == "" {
		return false
	}
	roles, ok := claims["urn:zitadel:iam:org:project:"+projectID+":roles"].(map[string]any)
	if ok {
		if _, found := roles[role]; found {
			return true
		}
	}
	return false
}
