package alert

import (
	"bytes"
	"fmt"
	"html/template"

	"github.com/Iann29/synapse/internal/email"
)

// downEmailTmpl renders the deployment-down email body. Same dark theme +
// inline styles as the invite email (most mail clients strip <style>
// blocks); html/template contextually escapes the operator-chosen names so
// a deployment/project name can't inject markup into the inbox.
var downEmailTmpl = template.Must(template.New("down").Parse(`<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0b0b0c;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5e5e5">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#161618;border:1px solid #2a2a2e;border-radius:12px">
      <tr><td style="padding:28px 32px">
        <h1 style="margin:0 0 12px;font-size:18px;color:#fff">⚠️ Deployment {{.Deployment}} is down</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#bdbdbd">
          The deployment <strong style="color:#fff">{{.Deployment}}</strong> ({{.Type}})
          in project <strong style="color:#fff">{{.Project}}</strong>
          (team {{.Team}}) changed status:
          <strong style="color:#fff">{{.Previous}} → {{.Status}}</strong>.
        </p>
        {{if .DashboardURL}}<p style="margin:0 0 24px">
          <a href="{{.DashboardURL}}" style="display:inline-block;padding:10px 18px;background:#7c5cff;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">Open project</a>
        </p>{{end}}
        <p style="margin:0;font-size:12px;line-height:1.5;color:#8a8a8a">
          You're receiving this because you're an admin of the team {{.Team}} on Synapse.
          Alert emails can be turned off in the admin area (Alert settings).
        </p>
      </td></tr>
    </table>
  </body>
</html>`))

// buildDownEmail assembles the alert Message. The plaintext alternative
// mirrors the HTML so text-only clients (and spam filters) still get the
// deployment, transition, and link.
func buildDownEmail(to string, dc downContext, previousStatus, newStatus, dashboardURL string) email.Message {
	var buf bytes.Buffer
	// Execute can only fail on a template bug (the data shape is fixed) —
	// fall back to the plaintext body rather than send an empty HTML email.
	if err := downEmailTmpl.Execute(&buf, struct {
		Deployment, Type, Project, Team, Previous, Status, DashboardURL string
	}{
		Deployment:   dc.deploymentName,
		Type:         dc.deploymentType,
		Project:      dc.projectName,
		Team:         dc.teamName,
		Previous:     previousStatus,
		Status:       newStatus,
		DashboardURL: dashboardURL,
	}); err != nil {
		buf.Reset()
	}
	text := fmt.Sprintf(
		"Deployment %q (%s) in project %q (team %q) is down: %s -> %s.",
		dc.deploymentName, dc.deploymentType, dc.projectName, dc.teamName, previousStatus, newStatus,
	)
	if dashboardURL != "" {
		text += "\n\nOpen the project:\n" + dashboardURL
	}
	text += "\n\nYou're receiving this because you're a team admin on Synapse. Alert emails can be turned off in the admin area (Alert settings)."
	return email.Message{
		To:      to,
		Subject: fmt.Sprintf("⚠️ Deployment %s is down (%s)", dc.deploymentName, newStatus),
		HTML:    buf.String(),
		Text:    text,
	}
}
