package api

import (
	"bytes"
	"fmt"
	"html/template"

	"github.com/Iann29/synapse/internal/email"
)

// inviteEmailTmpl renders the team-invite email body. html/template
// contextually escapes {{.Team}} (HTML text) and {{.AcceptURL}} (href +
// visible link), so an operator-chosen team name can't inject markup or a
// javascript: URL into the recipient's inbox. Styles are inline because
// most mail clients strip <style> blocks.
var inviteEmailTmpl = template.Must(template.New("invite").Parse(`<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0b0b0c;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5e5e5">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#161618;border:1px solid #2a2a2e;border-radius:12px">
      <tr><td style="padding:28px 32px">
        <h1 style="margin:0 0 12px;font-size:18px;color:#fff">You're invited to {{.Team}}</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#bdbdbd">
          You've been added as <strong style="color:#fff">{{.Role}}</strong> to the team
          <strong style="color:#fff">{{.Team}}</strong> on Synapse.
        </p>
        <p style="margin:0 0 24px">
          <a href="{{.AcceptURL}}" style="display:inline-block;padding:10px 18px;background:#7c5cff;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">Accept invite</a>
        </p>
        <p style="margin:0;font-size:12px;line-height:1.5;color:#8a8a8a">
          Or paste this link into your browser:<br>
          <a href="{{.AcceptURL}}" style="color:#a594ff;word-break:break-all">{{.AcceptURL}}</a>
        </p>
        <p style="margin:16px 0 0;font-size:12px;color:#6a6a6a">
          If you weren't expecting this invitation, you can safely ignore this email.
        </p>
      </td></tr>
    </table>
  </body>
</html>`))

// buildInviteEmail assembles the invite Message. The plaintext alternative
// mirrors the HTML so text-only clients (and spam filters) still get the
// team, role, and accept link.
func buildInviteEmail(to, teamName, role, acceptURL string) email.Message {
	var buf bytes.Buffer
	// Execute can only fail on a template bug (the data shape is fixed), so
	// a failure here is a programming error, not a runtime condition —
	// fall back to the plaintext body rather than send an empty HTML email.
	if err := inviteEmailTmpl.Execute(&buf, struct {
		Team, Role, AcceptURL string
	}{Team: teamName, Role: role, AcceptURL: acceptURL}); err != nil {
		buf.Reset()
	}
	text := fmt.Sprintf(
		"You've been invited to join %q (%s) on Synapse.\n\nAccept the invite:\n%s\n\nIf you weren't expecting this, you can ignore this email.",
		teamName, role, acceptURL,
	)
	return email.Message{
		To:      to,
		Subject: fmt.Sprintf("You're invited to join %s on Synapse", teamName),
		HTML:    buf.String(),
		Text:    text,
	}
}
