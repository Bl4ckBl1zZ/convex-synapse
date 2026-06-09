package api

import (
	"bytes"
	"fmt"
	"html/template"

	"github.com/Iann29/synapse/internal/email"
)

// resetEmailTmpl renders the password-reset email body. Same dark theme +
// inline styles as the invite email; html/template contextually escapes
// the link so nothing can inject markup or a javascript: URL into the
// recipient's inbox.
var resetEmailTmpl = template.Must(template.New("reset").Parse(`<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0b0b0c;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5e5e5">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#161618;border:1px solid #2a2a2e;border-radius:12px">
      <tr><td style="padding:28px 32px">
        <h1 style="margin:0 0 12px;font-size:18px;color:#fff">Reset your Synapse password</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#bdbdbd">
          Someone (hopefully you) asked to reset the password for this
          account. The link below works once and expires in 1 hour.
        </p>
        <p style="margin:0 0 24px">
          <a href="{{.ResetURL}}" style="display:inline-block;padding:10px 18px;background:#7c5cff;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">Choose a new password</a>
        </p>
        <p style="margin:0;font-size:12px;line-height:1.5;color:#8a8a8a">
          Or paste this link into your browser:<br>
          <a href="{{.ResetURL}}" style="color:#a594ff;word-break:break-all">{{.ResetURL}}</a>
        </p>
        <p style="margin:16px 0 0;font-size:12px;color:#6a6a6a">
          If you didn't request this, you can safely ignore this email —
          your password stays unchanged.
        </p>
      </td></tr>
    </table>
  </body>
</html>`))

// buildPasswordResetEmail assembles the reset Message. The plaintext
// alternative mirrors the HTML and carries the raw link (tests — and
// text-only clients — read the token from here).
func buildPasswordResetEmail(to, resetURL string) email.Message {
	var buf bytes.Buffer
	// Execute can only fail on a template bug (the data shape is fixed) —
	// fall back to the plaintext body rather than send an empty HTML email.
	if err := resetEmailTmpl.Execute(&buf, struct{ ResetURL string }{ResetURL: resetURL}); err != nil {
		buf.Reset()
	}
	text := fmt.Sprintf(
		"Someone (hopefully you) asked to reset your Synapse password.\n\nChoose a new password (link works once, expires in 1 hour):\n%s\n\nIf you didn't request this, ignore this email — your password stays unchanged.",
		resetURL,
	)
	return email.Message{
		To:      to,
		Subject: "Reset your Synapse password",
		HTML:    buf.String(),
		Text:    text,
	}
}
