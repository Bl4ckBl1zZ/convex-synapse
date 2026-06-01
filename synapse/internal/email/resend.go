package email

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// resendDefaultEndpoint is Resend's transactional-send API. resendSender
// keeps it as a field so unit tests can point Send at an httptest stub.
const resendDefaultEndpoint = "https://api.resend.com/emails"

// resendSender delivers via Resend's REST API. The 10s client timeout
// bounds the invite handler: email is best-effort, so a slow/unreachable
// Resend must not hang the operator's "invite" click indefinitely.
type resendSender struct {
	apiKey   string
	from     string
	endpoint string
	http     *http.Client
}

func newResendSender(apiKey, from string) *resendSender {
	return &resendSender{
		apiKey:   apiKey,
		from:     from,
		endpoint: resendDefaultEndpoint,
		http:     &http.Client{Timeout: 10 * time.Second},
	}
}

func (s *resendSender) Enabled() bool { return true }

func (s *resendSender) Send(ctx context.Context, msg Message) error {
	payload := map[string]any{
		"from":    s.from,
		"to":      []string{msg.To},
		"subject": msg.Subject,
		"html":    msg.HTML,
	}
	// Resend rejects an empty "text" field rather than ignoring it, so
	// only include the plaintext alternative when the caller set one.
	if msg.Text != "" {
		payload["text"] = msg.Text
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("email: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("email: request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("email: send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Cap the body so a misbehaving provider can't blow up logs.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("email: resend returned %d: %s",
			resp.StatusCode, bytes.TrimSpace(snippet))
	}
	return nil
}
