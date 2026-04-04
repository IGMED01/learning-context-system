#!/usr/bin/env node
// @ts-check

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputPath = path.resolve(process.argv[2] ?? "benchmark/rag-golden-set-200.json");

/**
 * @typedef {{
 *   key: string,
 *   project: string,
 *   docs: Array<{ title: string, content: string }>,
 *   intents: Array<{ query: string, expectedDocIndexes: number[] }>
 * }} DomainSpec
 */

/** @type {DomainSpec[]} */
const domainSpecs = [
  {
    key: "auth",
    project: "gold-auth",
    docs: [
      {
        title: "Auth middleware boundary",
        content: "El middleware autentica JWT, valida issuer y exp antes de ejecutar handlers."
      },
      {
        title: "Auth test matrix",
        content: "La matriz cubre token expirado, firma inválida y ausencia de credenciales."
      },
      {
        title: "Auth revocation contract",
        content: "La revocación invalida sesión en tiempo real y fuerza reautenticación."
      },
      {
        title: "Frontend style guide",
        content: "Documento de estilos visuales y componentes UI."
      },
      {
        title: "Build notes",
        content: "Notas de build y empaquetado para CLI."
      }
    ],
    intents: [
      { query: "¿Dónde validamos JWT antes del handler?", expectedDocIndexes: [0] },
      { query: "¿Qué casos mínimos debe cubrir auth tests?", expectedDocIndexes: [1] },
      { query: "¿Cómo funciona la revocación de sesión?", expectedDocIndexes: [2] },
      { query: "Necesito hardening del boundary de autenticación", expectedDocIndexes: [0, 1] },
      { query: "¿Qué hacer ante token expirado en producción?", expectedDocIndexes: [1, 2] }
    ]
  },
  {
    key: "runbook",
    project: "gold-runbook",
    docs: [
      {
        title: "Runbook token compromise",
        content: "Ante compromiso de token: rotar llaves, invalidar sesiones y auditar accesos."
      },
      {
        title: "Incident triage checklist",
        content: "Checklist de triage: impacto, alcance, mitigación y comunicación."
      },
      {
        title: "Postmortem template",
        content: "Template para registrar línea de tiempo, causa raíz y acciones preventivas."
      },
      {
        title: "CSS migration notes",
        content: "Notas de migración visual del frontend."
      },
      {
        title: "Analytics dashboard copy",
        content: "Texto de presentación para paneles de analytics."
      }
    ],
    intents: [
      { query: "¿Cuál es el runbook para compromiso de token?", expectedDocIndexes: [0] },
      { query: "¿Cómo priorizamos el triage de incidente?", expectedDocIndexes: [1] },
      { query: "Necesito plantilla de postmortem", expectedDocIndexes: [2] },
      { query: "Pasos de mitigación inmediata en incidente auth", expectedDocIndexes: [0, 1] },
      { query: "Cómo documentar incidente y acciones preventivas", expectedDocIndexes: [1, 2] }
    ]
  },
  {
    key: "compliance",
    project: "gold-compliance",
    docs: [
      {
        title: "PII logging policy",
        content: "Prohíbe PII en logs en claro; exige redacción o hash irreversible."
      },
      {
        title: "Retention standard",
        content: "Retención de logs operativos por 30 días con acceso auditado."
      },
      {
        title: "Access control policy",
        content: "Acceso por mínimo privilegio y revisión periódica de permisos."
      },
      {
        title: "UI onboarding guide",
        content: "Guía de onboarding para usuarios nuevos."
      },
      {
        title: "SEO checklist",
        content: "Checklist de SEO para web pública."
      }
    ],
    intents: [
      { query: "¿Qué política aplica a PII en logs?", expectedDocIndexes: [0] },
      { query: "¿Cuál es la retención de logs?", expectedDocIndexes: [1] },
      { query: "¿Cómo es el control de acceso mínimo privilegio?", expectedDocIndexes: [2] },
      { query: "Requisitos de compliance para observabilidad", expectedDocIndexes: [0, 1] },
      { query: "Cumplimiento en acceso y auditoría", expectedDocIndexes: [1, 2] }
    ]
  },
  {
    key: "session",
    project: "gold-session",
    docs: [
      {
        title: "Session revocation policy 2026",
        content: "Revocación en tiempo real por evento de riesgo y bloqueo preventivo."
      },
      {
        title: "Session revocation changelog 2026",
        content: "Se elimina ventana de 12h y se adopta invalidación inmediata."
      },
      {
        title: "Session risk scoring",
        content: "Score de riesgo combina anomalías de IP, dispositivo y firma."
      },
      {
        title: "Legacy policy 2025",
        content: "Política anterior con revocación por lote cada 12 horas."
      },
      {
        title: "Design tokens",
        content: "Tokens de diseño de interfaz."
      }
    ],
    intents: [
      { query: "¿Cuál es la política 2026 de revocación?", expectedDocIndexes: [0] },
      { query: "¿Qué cambió en revocación en 2026?", expectedDocIndexes: [1] },
      { query: "¿Cómo se calcula riesgo de sesión?", expectedDocIndexes: [2] },
      { query: "Necesito reglas vigentes de sesión y cambios", expectedDocIndexes: [0, 1] },
      { query: "¿Qué señales disparan bloqueo preventivo?", expectedDocIndexes: [0, 2] }
    ]
  },
  {
    key: "pipeline",
    project: "gold-pipeline",
    docs: [
      {
        title: "Pipeline path safety",
        content: "sourcePath y suitePath deben resolverse dentro del workspace."
      },
      {
        title: "Ingest hygiene gate",
        content: "Todo chunk ingestado pasa por evaluateMemoryWrite antes de persistir."
      },
      {
        title: "Project isolation contract",
        content: "Storage/recall operan aislados por projectId para evitar mezcla."
      },
      {
        title: "UI colors",
        content: "Paleta de colores del dashboard."
      },
      {
        title: "Marketing roadmap",
        content: "Roadmap comercial anual."
      }
    ],
    intents: [
      { query: "¿Cómo bloqueamos path traversal en pipeline?", expectedDocIndexes: [0] },
      { query: "¿Qué gate valida chunks antes de persistir?", expectedDocIndexes: [1] },
      { query: "¿Cómo aislamos memoria por proyecto?", expectedDocIndexes: [2] },
      { query: "Contrato de seguridad y aislamiento en pipeline", expectedDocIndexes: [0, 2] },
      { query: "Ingest seguro con hygiene gate", expectedDocIndexes: [0, 1] }
    ]
  },
  {
    key: "observability",
    project: "gold-observability",
    docs: [
      {
        title: "SDD metrics spec",
        content: "Métricas sdd_coverage_rate, sdd_injected_kinds y sdd_skipped_reason."
      },
      {
        title: "Teaching metrics spec",
        content: "Métricas teaching_coverage_rate y teaching_practice_rate."
      },
      {
        title: "Noise telemetry metrics",
        content: "noise_ratio, redundancy_ratio, context_half_life y source_entropy."
      },
      {
        title: "Footer copy",
        content: "Texto legal para el pie de página."
      },
      {
        title: "Icon set",
        content: "Listado de íconos UI."
      }
    ],
    intents: [
      { query: "¿Qué mide SDD en observabilidad?", expectedDocIndexes: [0] },
      { query: "¿Qué métricas tenemos de teaching?", expectedDocIndexes: [1] },
      { query: "¿Qué telemetry anti-ruido se captura?", expectedDocIndexes: [2] },
      { query: "Necesito métricas pedagógicas y de cobertura", expectedDocIndexes: [0, 1] },
      { query: "Cómo medimos ruido de conversación", expectedDocIndexes: [1, 2] }
    ]
  },
  {
    key: "versioning",
    project: "gold-versioning",
    docs: [
      {
        title: "Prompt version store",
        content: "Guarda versiones por promptKey con metadata y diff."
      },
      {
        title: "Rollback policy",
        content: "Rollback basado en score mínimo y preferencia por versión previa."
      },
      {
        title: "Rollback plan endpoint",
        content: "POST /api/versioning/rollback-plan construye plan de recuperación."
      },
      {
        title: "Banner animation",
        content: "Animación de portada para web."
      },
      {
        title: "Brand guidelines",
        content: "Guía de marca."
      }
    ],
    intents: [
      { query: "¿Cómo se guardan versiones de prompts?", expectedDocIndexes: [0] },
      { query: "¿Qué reglas usa rollback policy?", expectedDocIndexes: [1] },
      { query: "¿Qué endpoint construye rollback plan?", expectedDocIndexes: [2] },
      { query: "Versionado y rollback en NEXUS", expectedDocIndexes: [0, 1] },
      { query: "Plan de recuperación por caída de score", expectedDocIndexes: [1, 2] }
    ]
  },
  {
    key: "agent",
    project: "gold-agent",
    docs: [
      {
        title: "Agent runtime local-first",
        content: "El runtime de agente opera local-first sin dependencia externa obligatoria."
      },
      {
        title: "Agent SDD gate",
        content: "runGate=true aplica fail-fast según cobertura mínima configurable."
      },
      {
        title: "Agent context profile",
        content: "El endpoint agent usa selección de contexto con mode clean y SDD."
      },
      {
        title: "Landing page text",
        content: "Texto de landing comercial."
      },
      {
        title: "Photo assets list",
        content: "Inventario de assets gráficos."
      }
    ],
    intents: [
      { query: "¿El runtime de agente depende de servicios externos?", expectedDocIndexes: [0] },
      { query: "¿Cómo funciona el fail-fast SDD en agentes?", expectedDocIndexes: [1] },
      { query: "¿Qué perfil de contexto usa /api/agent?", expectedDocIndexes: [2] },
      { query: "Ejecución segura de agentes en local", expectedDocIndexes: [0, 1] },
      { query: "Modo clean y cobertura SDD para agentes", expectedDocIndexes: [1, 2] }
    ]
  },
  {
    key: "rag",
    project: "gold-rag",
    docs: [
      {
        title: "RAG auto-retrieve flow",
        content: "Si no hay chunks explícitos, /api/ask y /api/chat disparan auto-retrieval."
      },
      {
        title: "Reranker semantics",
        content: "Rerank combina retrievalScore y semanticScore para priorizar contexto."
      },
      {
        title: "RAG feature flags",
        content: "LCS_RAG_AUTO_RETRIEVE y LCS_RAG_ENABLE_RERANK controlan la ruta RAG."
      },
      {
        title: "Old static FAQ",
        content: "FAQ histórica no técnica."
      },
      {
        title: "Theme palette",
        content: "Paleta de tema visual."
      }
    ],
    intents: [
      { query: "¿Cuándo se activa auto-retrieve en RAG?", expectedDocIndexes: [0] },
      { query: "¿Qué pondera el reranker semántico?", expectedDocIndexes: [1] },
      { query: "¿Qué flags controlan RAG?", expectedDocIndexes: [2] },
      { query: "Flujo completo de recuperación en /api/ask y /api/chat", expectedDocIndexes: [0, 1] },
      { query: "Configurar y tunear RAG con flags", expectedDocIndexes: [1, 2] }
    ]
  },
  {
    key: "security",
    project: "gold-security",
    docs: [
      {
        title: "API body size limits",
        content: "La API rechaza body gigante con 413 para evitar abuso."
      },
      {
        title: "JWT auth hardening",
        content: "Valida alg HS256, issuer, audience y ventanas nbf/iat."
      },
      {
        title: "Rate limit cardinality",
        content: "Rate limiter usa eviction TTL-aware y LRU bajo presión de IPs."
      },
      {
        title: "Typography guide",
        content: "Guía tipográfica UI."
      },
      {
        title: "Illustration notes",
        content: "Notas de ilustración."
      }
    ],
    intents: [
      { query: "¿Cómo manejamos body demasiado grande?", expectedDocIndexes: [0] },
      { query: "¿Qué validaciones extra tiene JWT?", expectedDocIndexes: [1] },
      { query: "¿Cómo resiste rate limit a cardinalidad alta?", expectedDocIndexes: [2] },
      { query: "Hardening de auth y límites de request", expectedDocIndexes: [0, 1] },
      { query: "Protecciones anti-abuso en runtime API", expectedDocIndexes: [0, 2] }
    ]
  }
];

const queryVariants = [
  "necesito aplicarlo hoy en producción",
  "dame pasos concretos sin romper compatibilidad",
  "incluye validación y pruebas recomendadas",
  "prioriza seguridad y trazabilidad"
];

/** @type {Array<{ id: string, project: string, domain: string, title: string, content: string }>} */
const documents = [];
/** @type {Array<{ id: string, project: string, domain: string, query: string, expectedDocIds: string[] }>} */
const cases = [];

let globalCaseIndex = 1;
for (const domain of domainSpecs) {
  const domainDocIds = domain.docs.map((doc, index) => `${domain.key}-doc-${index + 1}`);
  domain.docs.forEach((doc, index) => {
    documents.push({
      id: domainDocIds[index],
      project: domain.project,
      domain: domain.key,
      title: doc.title,
      content: doc.content
    });
  });

  for (const [intentIndex, intent] of domain.intents.entries()) {
    for (const [variantIndex, variant] of queryVariants.entries()) {
      const expectedDocIds = intent.expectedDocIndexes.map((docIndex) => domainDocIds[docIndex]);
      cases.push({
        id: `case-${String(globalCaseIndex).padStart(3, "0")}`,
        project: domain.project,
        domain: domain.key,
        query: `${intent.query} (${variant}; v${variantIndex + 1}; intent ${intentIndex + 1})`,
        expectedDocIds
      });
      globalCaseIndex += 1;
    }
  }
}

const payload = {
  suite: "nexus-rag-golden-set-v1",
  metadata: {
    generatedBy: "scripts/generate-rag-golden-set.js",
    totalCases: cases.length,
    totalDocuments: documents.length,
    domains: domainSpecs.length
  },
  documents,
  cases
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(
  `Generated RAG golden set at ${outputPath} with ${cases.length} cases and ${documents.length} documents.`
);

