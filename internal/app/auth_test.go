package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

func TestEncryptedSessionRejectsTampering(t *testing.T) {
	auth := &Authenticator{cfg: AuthConfig{SecureCookies: false}, key: []byte(strings.Repeat("s", 32)), now: time.Now}
	recorder := httptest.NewRecorder()
	require.NoError(t, auth.setSession(
		recorder,
		AdminIdentity{Subject: "admin", Name: "Admin", Expires: time.Now().Add(time.Hour).Unix()},
	))
	cookie := recorder.Result().Cookies()[0]
	request := httptest.NewRequestWithContext(t.Context(), "GET", "/admin", nil)
	request.AddCookie(cookie)
	_, ok := auth.Identity(request)
	require.True(t, ok, "valid session was rejected")
	cookie.Value += "tampered"
	tampered := httptest.NewRequestWithContext(t.Context(), "GET", "/admin", nil)
	tampered.AddCookie(cookie)
	_, ok = auth.Identity(tampered)
	require.False(t, ok, "tampered session was accepted")
}

func TestRefreshableSessionEncryptsRefreshToken(t *testing.T) {
	now := time.Now()
	auth := &Authenticator{
		cfg: AuthConfig{}, key: []byte(strings.Repeat("s", 32)),
		now: func() time.Time { return now },
	}
	recorder := httptest.NewRecorder()
	identity := AdminIdentity{Subject: "admin", Name: "Admin", Expires: time.Now().Add(time.Hour).Unix()}
	require.NoError(t, auth.setRefreshableSession(recorder, identity, "secret-refresh-token"))
	cookie := recorder.Result().Cookies()[0]
	assert.NotContains(t, cookie.Value, "secret-refresh-token")

	request := httptest.NewRequestWithContext(t.Context(), "GET", "/admin", nil)
	request.AddCookie(cookie)
	session, err := auth.readSession(request)
	require.NoError(t, err)
	assert.Equal(t, identity, session.Identity)
	assert.Equal(t, "secret-refresh-token", session.RefreshToken)
	assert.Equal(t, now.Add(refreshCookieLife).Unix(), session.RefreshUntil)

	now = now.Add(refreshCookieLife + time.Second)
	_, err = auth.readSession(request)
	assert.Error(t, err)
}

func TestObsoleteSignedSessionRequiresLogin(t *testing.T) {
	auth := &Authenticator{cfg: AuthConfig{}, key: []byte(strings.Repeat("s", 32)), now: time.Now}
	identity := AdminIdentity{Subject: "admin", Name: "Admin", Expires: time.Now().Add(time.Hour).Unix()}
	contents, err := json.Marshal(identity)
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	auth.setSignedCookie(recorder, sessionCookieName, string(contents), time.Hour)

	request := httptest.NewRequestWithContext(t.Context(), "GET", "/admin", nil)
	request.AddCookie(recorder.Result().Cookies()[0])
	_, ok := auth.Identity(request)
	assert.False(t, ok)
}

func TestRefreshSessionRequiresLoginAfterInvalidGrant(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
	}))
	defer tokenServer.Close()
	now := time.Now()
	auth := &Authenticator{
		cfg:   AuthConfig{Mode: authModeZitadel},
		key:   []byte(strings.Repeat("s", 32)),
		now:   func() time.Time { return now },
		oauth: oauth2.Config{ClientID: "client", Endpoint: oauth2.Endpoint{TokenURL: tokenServer.URL}},
	}
	recorder := httptest.NewRecorder()
	require.NoError(t, auth.setRefreshableSession(
		recorder,
		AdminIdentity{Subject: "admin", Name: "Admin", Expires: now.Add(-time.Minute).Unix()},
		"invalid-refresh-token",
	))
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/admin/session/refresh", nil)
	request.AddCookie(recorder.Result().Cookies()[0])

	_, err := auth.RefreshSession(httptest.NewRecorder(), request)
	assert.ErrorIs(t, err, errRefreshLoginRequired)
}

func TestLogoutRevokesRefreshToken(t *testing.T) {
	var revokedToken, clientID, clientSecret string
	var requestErr error
	revokeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestErr = r.ParseForm()
		if requestErr != nil {
			http.Error(w, "invalid form", http.StatusBadRequest)
			return
		}
		revokedToken = r.Form.Get("token")
		clientID, clientSecret, _ = r.BasicAuth()
		w.WriteHeader(http.StatusOK)
	}))
	defer revokeServer.Close()
	auth := &Authenticator{
		cfg: AuthConfig{
			Mode:    authModeZitadel,
			Zitadel: ZitadelConfig{ClientID: "client", ClientSecret: "secret"},
		},
		key: []byte(strings.Repeat("s", 32)), revokeURL: revokeServer.URL, now: time.Now,
	}
	sessionRecorder := httptest.NewRecorder()
	require.NoError(t, auth.setRefreshableSession(
		sessionRecorder,
		AdminIdentity{Subject: "admin", Name: "Admin", Expires: time.Now().Add(time.Hour).Unix()},
		"refresh-token",
	))
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/auth/logout", nil)
	request.AddCookie(sessionRecorder.Result().Cookies()[0])
	response := httptest.NewRecorder()

	auth.Logout(response, request)
	require.NoError(t, requestErr)
	assert.Equal(t, http.StatusSeeOther, response.Code)
	assert.Equal(t, "refresh-token", revokedToken)
	assert.Equal(t, "client", clientID)
	assert.Equal(t, "secret", clientSecret)
	require.NoError(t, response.Result().Cookies()[0].Valid())
	assert.Equal(t, -1, response.Result().Cookies()[0].MaxAge)
}

func TestHasProjectRole(t *testing.T) {
	claims := map[string]any{
		"urn:zitadel:iam:org:project:123:roles": map[string]any{"admin": map[string]any{"org": "example"}},
	}
	assert.True(t, hasProjectRole(claims, "123", "admin"))
	assert.False(t, hasProjectRole(claims, "123", "editor"))
}

func TestHasProjectRoleDoesNotFallBackToAnotherProject(t *testing.T) {
	claims := map[string]any{
		"urn:zitadel:iam:org:project:roles": map[string]any{"admin": map[string]any{"org": "example"}},
	}
	assert.False(t, hasProjectRole(claims, "configured-project", "admin"))
}

func TestZitadelScopesRequestRefreshTokens(t *testing.T) {
	assert.Contains(t, zitadelScopes("project"), "offline_access")
}

func TestOIDCFlowIsStoredInSignedCookie(t *testing.T) {
	auth := &Authenticator{
		cfg: AuthConfig{Mode: "zitadel"}, key: []byte(strings.Repeat("k", 32)), now: time.Now,
		oauth: oauth2.Config{
			ClientID: "client", RedirectURL: "https://app.example/auth/callback",
			Endpoint: oauth2.Endpoint{AuthURL: "https://id.example/authorize"},
		},
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), "GET", "/auth/login", nil)
	auth.Login(recorder, request)
	require.Equal(t, 302, recorder.Code)
	var flowCookie string
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.Name == flowCookieName {
			flowCookie = cookie.Value
		}
	}
	require.NotEmpty(t, flowCookie)
	callbackRequest := httptest.NewRequestWithContext(t.Context(), "GET", "/auth/callback", nil)
	callbackRequest.AddCookie(recorder.Result().Cookies()[0])
	encoded, err := auth.readSignedCookie(callbackRequest, flowCookieName)
	require.NoError(t, err)
	var flow oidcFlow
	require.NoError(t, json.Unmarshal([]byte(encoded), &flow))
	location, err := url.Parse(recorder.Header().Get("Location"))
	require.NoError(t, err)
	assert.NotEmpty(t, flow.State)
	assert.NotEmpty(t, flow.Verifier)
	assert.NotEmpty(t, flow.Nonce)
	assert.Equal(t, flow.State, location.Query().Get("state"))
}
