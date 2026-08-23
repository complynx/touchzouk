package app

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	sessionCookieName = "touchzouk_admin"
	flowCookieName    = "touchzouk_oidc"
)

type AdminIdentity struct {
	Subject string `json:"sub"`
	Name    string `json:"name"`
	Expires int64  `json:"exp"`
}

type authContextKey struct{}

type oidcFlow struct {
	State    string    `json:"state"`
	Verifier string    `json:"verifier"`
	Nonce    string    `json:"nonce"`
	Expires  time.Time `json:"expires"`
}

type Authenticator struct {
	cfg      AuthConfig
	key      []byte
	provider *oidc.Provider
	oauth    oauth2.Config
	now      func() time.Time
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
	scopes := []string{oidc.ScopeOpenID, "profile", "urn:zitadel:iam:org:projects:roles"}
	if cfg.Zitadel.ProjectID != "" {
		scopes = append(scopes, "urn:zitadel:iam:org:project:id:"+cfg.Zitadel.ProjectID+":aud")
	}
	auth.oauth = oauth2.Config{
		ClientID:     cfg.Zitadel.ClientID,
		ClientSecret: cfg.Zitadel.ClientSecret,
		Endpoint:     provider.Endpoint(),
		RedirectURL:  cfg.Zitadel.RedirectURL,
		Scopes:       scopes,
	}
	return auth, nil
}

func (a *Authenticator) Login(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode == authModeStub {
		a.setSession(w, AdminIdentity{
			Subject: "stub-admin",
			Name:    a.cfg.StubUser,
			Expires: a.now().Add(12 * time.Hour).Unix(),
		})
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
	if !ok {
		http.Error(w, "ZITADEL did not return an ID token", http.StatusBadGateway)
		return
	}
	idToken, err := a.provider.Verifier(&oidc.Config{ClientID: a.cfg.Zitadel.ClientID}).Verify(r.Context(), rawIDToken)
	if err != nil {
		http.Error(w, "invalid ZITADEL ID token", http.StatusUnauthorized)
		return
	}
	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		http.Error(w, "invalid ZITADEL claims", http.StatusUnauthorized)
		return
	}
	if claimString(claims, "nonce") != flow.Nonce {
		http.Error(w, "invalid ZITADEL nonce", http.StatusUnauthorized)
		return
	}
	if !hasProjectRole(claims, a.cfg.Zitadel.ProjectID, a.cfg.Zitadel.AdminRole) {
		http.Error(w, "the ZITADEL admin role is required", http.StatusForbidden)
		return
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
	a.setSession(w, AdminIdentity{
		Subject: idToken.Subject,
		Name:    name,
		Expires: sessionExpiry.Unix(),
	})
	a.clearCookie(w, flowCookieName)
	http.Redirect(w, r, "/admin", http.StatusSeeOther)
}

func (a *Authenticator) Logout(w http.ResponseWriter, r *http.Request) {
	a.clearCookie(w, sessionCookieName)
	http.Redirect(w, r, "/listen", http.StatusSeeOther)
}

func (a *Authenticator) Identity(r *http.Request) (AdminIdentity, bool) {
	value, err := a.readSignedCookie(r, sessionCookieName)
	if err != nil {
		return AdminIdentity{}, false
	}
	var identity AdminIdentity
	err = json.Unmarshal([]byte(value), &identity)
	if err != nil || identity.Subject == "" || identity.Expires <= a.now().Unix() {
		return AdminIdentity{}, false
	}
	return identity, true
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

func (a *Authenticator) setSession(w http.ResponseWriter, identity AdminIdentity) {
	contents, _ := json.Marshal(identity)
	a.setSignedCookie(w, sessionCookieName, string(contents), time.Until(time.Unix(identity.Expires, 0)))
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
