# Knowledge Backends (local-only / obsidian / notion)

**Actualizado:** 2026-04-02

## Objetivo

Permitir que cada proyecto use un backend de conocimiento configurable:
- `local-only`
- `obsidian`
- `notion`

La resolución se hace vía `KnowledgeResolver` por proyecto.

---

## Configuración mínima

En `learning-context.config.json`:

```json
{
  "sync": {
    "knowledgeBackend": "local-only",
    "retryPolicy": {
      "maxAttempts": 3,
      "backoffMs": 200,
      "maxBackoffMs": 5000
    },
    "dlq": {
      "enabled": true,
      "path": ".lcs/dlq",
      "ttlDays": 7
    }
  }
}
```

---

## Provider contract

Implementado en `src/integrations/knowledge-provider.js`:
- `sync(entry)`
- `delete(id)`
- `search(query, options?)`
- `list(project?, options?)`
- `health()`
- `getPendingSyncs(project)`

Errores especializados:
- `ProviderConnectionError`
- `ProviderWriteError`
- `ProviderRateLimitError`
- `ProviderValidationError`

---

## Resolver + DLQ

`src/integrations/knowledge-resolver.js`:
- resuelve provider por proyecto;
- agrega fallback y retry;
- escribe fallos transitorios en DLQ;
- soporta auto-retry y cuarentena por TTL.

Rutas DLQ:
- pendientes: `.lcs/dlq/<project>/pending.jsonl`
- cuarentena: `.lcs/dlq/<project>/quarantine.jsonl`

---

## Obsidian provider

`src/integrations/obsidian-provider.js`:
- escribe `.md` en `NEXUS/<project>/<type>/<slug>.md`;
- bloquea traversal y slugs inválidos;
- usa escrituras atómicas para evitar corrupción;
- expone búsqueda/listado sobre índices en memoria.

---

## Notion provider

`src/integrations/notion-provider.js`:
- adapta sync/list/search a la interface común;
- soporta reintentos;
- normaliza errores de rate-limit y validación.

---

## Comandos útiles

```bash
node src/cli.js sync-knowledge --title "Hardening JWT" --content "..." --project learning-context-system
node src/cli.js recall --project learning-context-system --query "jwt hardening"
node src/cli.js doctor-memory --project learning-context-system --format json
```

---

## Troubleshooting rápido

- Si Engram está bloqueado por Windows App Control, usar `memory.backend=local-only` temporalmente.
- Verificar estado con:
  - `node src/cli.js doctor --format json`
  - `node src/cli.js doctor-memory --project <project> --format json`
- Revisar DLQ para pendientes de sync antes de cerrar una sesión.
