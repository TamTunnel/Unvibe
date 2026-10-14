# Unvibe verify report

Source: http://localhost:8901/ · spec v1.0.0

## Screenshot diff

Threshold: 25% differing pixels per route (generous by design — pixel-perfect is out of scope).
Overall: **PASS**

| Route | Diff | Result |
|---|---|---|
| `/` | 0.6% | PASS |
| `/about` | 0.4% | PASS |
| `/dashboard` | 0.9% | PASS |

## Contract tests

Overall: **PASS**

- ✅ endpoint GET /api/projects referenced in api client — found in src/lib/api.ts
- ✅ endpoint GET /api/contact referenced in api client — found in src/lib/api.ts
- ✅ entity Rojects interface matches observed shape — interface Rojects covers observed fields
- ✅ route / wired in App.tsx — route registered
- ✅ route /about wired in App.tsx — route registered
- ✅ route /dashboard wired in App.tsx — route registered
- ✅ live: GET / → 2xx — HTTP 200
- ✅ live: GET /about → 2xx — HTTP 200
- ✅ live: GET /dashboard → 2xx — HTTP 200

## What this proves

Same routes exist, the same API endpoints are called with the same
shapes, and the same data model is created. It does not prove the UI
looks identical — judge the diff screenshots in `verify/` yourself.
