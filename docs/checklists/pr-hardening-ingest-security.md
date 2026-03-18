# PR Validation + Hardening Checklist (ingest-security)

## Scope acotado

Solo se toca la superficie de **ingesta de findings de Prowler**:

- `src/security/prowler-ingest.js`
- `src/cli/app.js`
- `src/cli/formatters.js`
- contratos/tests/docs asociados a `ingest-security`

Fuera de alcance:

- selector core
- mentor loop
- flows de Engram (`recall/remember/close`)

## Checklist operativo

- [x] Validar que la PR previa sigue verde en CI.
- [x] Correr regresión local (`npm test`, `typecheck`, `build`, `build:smoke`).
- [x] Hardening: redacción de secretos en findings importados.
- [x] Hardening: descarte de findings vacíos/no útiles.
- [x] Refactor: unificar defaults de ingest (`DEFAULT_PROWLER_*`).
- [x] Cleanup: salida text/json con métricas de descarte/redacción.
- [x] Compatibilidad: fixture de contrato v1 actualizado.

## Criterios de aceptación (DoD)

- [x] `ingest-security` acepta formatos Prowler soportados (`[]`, `findings[]`, `Findings[]`, `items[]`).
- [x] Produce `chunkFile` compatible con `select/teach/readme`.
- [x] Contrato JSON estable validado por fixture.
- [x] No rompe comandos existentes de la CLI.
- [x] CI matrix Node 20/22 en verde.
- [x] Documentación de uso actualizada.
