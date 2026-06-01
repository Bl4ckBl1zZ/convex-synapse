// Package email sends transactional email (today: team invites) via
// Resend (https://resend.com). The feature is opt-in: when no API key +
// From address are configured, New returns a no-op Sender and invites
// keep working through the link the API returns — email is an addition,
// never a hard dependency. Callers gate on Enabled() so they can surface
// "emailed" vs "share this link" without inspecting provider internals.
package email

import "context"

// Message is a single transactional email. HTML is the rendered body;
// Text is an optional plaintext alternative (Resend includes both so
// text-only clients and spam filters stay happy).
type Message struct {
	To      string
	Subject string
	HTML    string
	Text    string
}

// Sender delivers transactional email. Enabled reports whether a real
// provider is wired — callers skip the send (and surface "link only")
// when it returns false rather than paying for a guaranteed-noop call.
type Sender interface {
	Enabled() bool
	Send(ctx context.Context, msg Message) error
}

// New returns a Resend-backed Sender when BOTH apiKey and from are set,
// otherwise a no-op. Both are required: Resend rejects a send with an
// empty From, so a key without a verified From address is effectively
// disabled — failing closed here keeps the invite path from logging a
// guaranteed 4xx on every invite.
func New(apiKey, from string) Sender {
	if apiKey == "" || from == "" {
		return noopSender{}
	}
	return newResendSender(apiKey, from)
}

// noopSender is the disabled state. Send is a successful no-op so callers
// that forget to check Enabled() still don't error; Enabled() is the
// honest signal.
type noopSender struct{}

func (noopSender) Enabled() bool                       { return false }
func (noopSender) Send(context.Context, Message) error { return nil }
