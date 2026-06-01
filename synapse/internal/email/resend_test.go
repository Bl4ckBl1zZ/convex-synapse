package email

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNew_DisabledUnlessBothSet(t *testing.T) {
	cases := []struct {
		key, from string
		enabled   bool
	}{
		{"", "", false},
		{"re_123", "", false},      // key without From → Resend would 4xx → disabled
		{"", "x@y.com", false},     // From without key → no auth → disabled
		{"re_123", "x@y.com", true},
	}
	for _, c := range cases {
		if got := New(c.key, c.from).Enabled(); got != c.enabled {
			t.Errorf("New(%q,%q).Enabled()=%v want %v", c.key, c.from, got, c.enabled)
		}
	}
}

func TestNoopSend_IsNil(t *testing.T) {
	if err := New("", "").Send(context.Background(), Message{To: "a@b.com"}); err != nil {
		t.Errorf("noop Send returned %v, want nil", err)
	}
}

func TestResendSend_PostsExpectedRequest(t *testing.T) {
	var gotAuth, gotCT string
	var gotBody map[string]any
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"abc"}`))
	}))
	defer stub.Close()

	s := newResendSender("re_test", "Synapse <no-reply@x.com>")
	s.endpoint = stub.URL
	if err := s.Send(context.Background(), Message{
		To: "dev@example.com", Subject: "hi", HTML: "<b>hi</b>", Text: "hi",
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	if gotAuth != "Bearer re_test" {
		t.Errorf("authorization: got %q, want %q", gotAuth, "Bearer re_test")
	}
	if gotCT != "application/json" {
		t.Errorf("content-type: got %q", gotCT)
	}
	if gotBody["from"] != "Synapse <no-reply@x.com>" {
		t.Errorf("from: got %v", gotBody["from"])
	}
	to, _ := gotBody["to"].([]any)
	if len(to) != 1 || to[0] != "dev@example.com" {
		t.Errorf("to: got %v, want [dev@example.com]", gotBody["to"])
	}
	if gotBody["subject"] != "hi" || gotBody["html"] != "<b>hi</b>" || gotBody["text"] != "hi" {
		t.Errorf("body fields: got %v", gotBody)
	}
}

func TestResendSend_Non2xxErrors(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"message":"invalid from"}`))
	}))
	defer stub.Close()

	s := newResendSender("re_test", "x@y.com")
	s.endpoint = stub.URL
	if err := s.Send(context.Background(), Message{To: "a@b.com", Subject: "s", HTML: "h"}); err == nil {
		t.Fatal("expected an error on 422, got nil")
	}
}

func TestResendSend_OmitsEmptyText(t *testing.T) {
	var gotBody map[string]any
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer stub.Close()

	s := newResendSender("re_test", "x@y.com")
	s.endpoint = stub.URL
	_ = s.Send(context.Background(), Message{To: "a@b.com", Subject: "s", HTML: "h"})
	if _, ok := gotBody["text"]; ok {
		t.Errorf("empty Text must be omitted from payload, got %v", gotBody)
	}
}
