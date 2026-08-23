package app

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

func TestSignedSessionRejectsTampering(t *testing.T) {
	auth := &Authenticator{cfg: AuthConfig{SecureCookies: false}, key: []byte(strings.Repeat("s", 32)), now: time.Now}
	recorder := httptest.NewRecorder()
	auth.setSession(recorder, AdminIdentity{Subject: "admin", Name: "Admin", Expires: time.Now().Add(time.Hour).Unix()})
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
