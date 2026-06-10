# Autenticação e acesso

O Synapse usa email + senha como único método de login nativo. As sessões são JWTs de curta duração; automações que rodam por mais tempo (CLI, CI, scripts dentro do dashboard) usam tokens de acesso pessoais (PATs) opacos que começam com `syn_`. Não existe SSO, não existe SAML, não existe WorkOS — OIDC está no roadmap.

## Registro

`POST /v1/auth/register` com `{ email, password, name }`.

- Email precisa ter `@`; a coluna é `citext`, então colisões de caixa caem na mesma linha.
- Senha precisa ter no mínimo 8 chars, salva como hash bcrypt via `auth.HashPassword`.
- Email duplicado retorna `409 email_taken` — detectado por SQLSTATE 23505 em `users_email_key`.

**O primeiro usuário a se registrar vira o instance admin.** O INSERT usa `NOT EXISTS (SELECT 1 FROM users)` pra marcar `is_instance_admin = true` automaticamente, e um `pg_advisory_xact_lock(hashtext('synapse:first_instance_admin'))` serializa essa decisão.

Instance admins são as únicas contas autorizadas a acessar `/v1/admin/*`. Não viram admins de team automaticamente; admin de team é um papel separado em `team_members.role`.

Response: `{ accessToken, refreshToken, tokenType: "Bearer", expiresIn, user }`.

## Login

`POST /v1/auth/login` com `{ email, password }`. Mesmo response. Registra evento `audit.ActionLogin`. Credenciais inválidas sempre voltam como `401 invalid_credentials` — sem distinção entre "email inexistente" e "senha errada".

## TTL dos JWTs

HS256, assinados com `SYNAPSE_JWT_SECRET`. Dois tipos, ambos com claim `kind`:

| Token | TTL padrão | Override |
|---|---|---|
| Access | 24 horas | `SYNAPSE_JWT_ACCESS_TTL` |
| Refresh | 720 horas (30 dias) | `SYNAPSE_JWT_REFRESH_TTL` |

A rota de refresh (`POST /v1/auth/refresh`) confere a claim `kind` literal `"refresh"` e emite um par novo. O dashboard não faz refresh silencioso hoje; o TTL de 24h do access token aguenta a sessão inteira do operador.

## Personal access tokens (PATs)

Bytes aleatórios opacos — não são JWTs — gerados por `auth.GenerateToken`:

- 256 bits de entropia de `crypto/rand`
- base64url + prefixo `syn_` (scanners de secret estilo GitHub flagram vazamentos)
- guardados como digest SHA-256 hex em `access_tokens.token_hash`; plaintext devolvido **uma vez** na criação

Use como bearer: `Authorization: Bearer syn_<resto>`.

O middleware aceita JWTs e tokens `syn_*` nas mesmas rotas. PATs atualizam `access_tokens.last_used_at` e levam o escopo pro contexto da request.

### Gerenciando PATs pelo dashboard

Painel em `/me` (`dashboard/app/me/page.tsx`). Rotas (em `/v1`):

- `POST /v1/create_personal_access_token` — `{ name, scope?, scopeId?, expiresAt? }`
- `GET /v1/list_personal_access_tokens` — paginado, só metadata
- `POST /v1/delete_personal_access_token` — `{ id }`

Tokens com escopo têm rotas próprias: `POST /v1/teams/{ref}/access_tokens`, `POST /v1/projects/{id}/access_tokens`, `POST /v1/projects/{id}/app_access_tokens`.

## Escopos de PAT

Todo PAT carrega um de cinco escopos:

| Escopo | scopeId | Onde se cria | O que pode |
|---|---|---|---|
| `user` | nenhum | `/me` | Qualquer coisa que o dono faz pelo dashboard (default) |
| `team` | id do time | `/teams/<slug>/settings/access-tokens` | Tudo dentro daquele time |
| `project` | id do projeto | `/teams/<slug>/<project>/settings/access-tokens` | Tudo dentro daquele projeto |
| `app` | id do projeto | Mesmo lugar | Mesma superfície; rótulo separado pra UI "App tokens" |
| `deployment` | id do deployment | Painel de deploy keys da CLI | Só um deployment |

## Hierarquia de escopos

Token com escopo atua no próprio nível ou abaixo, nunca acima:

|        | Y = time | Y = projeto | Y = deployment |
|--------|----------|-------------|----------------|
| user   | sim      | sim         | sim            |
| team   | exato    | filho       | filho          |
| project / app | não | exato       | filho          |
| deployment    | não | não         | exato          |

Mismatch retorna `403 forbidden_token_scope`. Chamadas com JWT e PATs `user` passam direto.

## Revogação

Delete a linha. Pelo dashboard: `/me`, acha a linha, "Delete". Pela API: `POST /v1/delete_personal_access_token { "id": "<token-id>" }`. A próxima request com aquele token falha no middleware antes de chegar em qualquer handler.

Não tem "rotate" — cria token novo, cola no CI/scripts, deleta o velho.

## Redefinição de senha (v1.26+)

Esqueceu uma senha? A página de login tem o link **Esqueceu a senha?** — chega de pedir pro admin da instância mexer no banco. O fluxo:

1. `POST /v1/auth/forgot_password {email}` — **sempre** responde o mesmo `200 {ok:true}`, exista a conta ou não (sem oráculo de enumeração de usuário; até o envio do email é destacado, então nem o tempo de resposta vaza nada).
2. Se a conta existe **e** o email está configurado (Admin → Email) **e** o `SYNAPSE_PUBLIC_URL` está definido, um link de uso único `syn_reset_…` é enviado — guardado como SHA-256, **expira em 1 hora**, máximo de 3 ativos por conta.
3. `/reset-password?token=…` pede a senha nova (mínimo de 8 caracteres, mesma política do registro). Uma senha fraca por erro de digitação **não** consome o link.
4. No sucesso: o hash é trocado, os outros links de reset pendentes da conta morrem, e **refresh tokens emitidos antes da troca são recusados** — um reset desloga sessões antigas. Auditado como `passwordReset`.

Sem email configurado? O endpoint ainda responde 200 mas não cria nada — o admin da instância continua sendo o fallback manual. Tokens de acesso pessoais sobrevivem de propósito a um reset de senha (são credenciais separadas, estilo GitHub).

## E SSO / OIDC?

OIDC está no roadmap mas não foi shipped ainda. O Synapse continua com email + senha + JWT (agora com reset self-service) até lá; o operador é dono completo do limite de auth (sem WorkOS, sem SAML, sem provedor externo).

Por enquanto, o pattern prático pra times:

1. Cada operador se registra individualmente em `/login` (ou aceita convite — veja teams-and-projects).
2. Automação de longa duração usa PAT com escopo `team` ou `project`, não pessoal, pra sobreviver à saída do humano.

---

> **Rodapé (operadores Windows):** se `synapse <cmd>` imprime Unicode embaralhado ou trava no primeiro prompt, veja a seção de troubleshooting pro workaround `chcp 65001`. É problema de code page do SO, não algo que o Synapse faz.
