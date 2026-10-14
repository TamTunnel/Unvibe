# Security Policy

## Reporting a vulnerability

Unvibe is security-sensitive tooling: it crawls live apps, handles session
cookies, and generates code. If you find a vulnerability, please report it
privately:

- Email: security@tamtunnel.dev (or open a private security advisory on GitHub)
- Include: what you found, how to reproduce it, and the impact you see.

We aim to acknowledge within 3 business days and to ship a fix before any
public disclosure. Please do not open a public issue for security bugs.

## Scope notes

- The `--cookie` option intentionally accepts session cookies — that is the
  documented way to capture authed routes of apps you own. Treat cookies like
  credentials: never commit them, never paste them into issues.
- `--api-key` and `--cookie` are visible in `ps` output and shell history.
  Prefer the env-var forms: `UNVIBE_API_KEY` for the LLM key, and
  `UNVIBE_COOKIE` for the session cookie (read automatically when `--cookie`
  is not given). The CLI flags remain for one-off use.
- API keys in output repos are always redacted during capture; `.env.example`
  ships with empty values. If you ever see a real key in generated output,
  that is a bug — report it.
- The mock LLM provider is deterministic and offline; networked providers
  send spec JSON (behavioral data, no bundle source) to your chosen endpoint.
