import type {
  ExtractedEntities,
  EntityExtractorOptions,
  EntityPattern,
  DateRef,
  ArticleRef
} from "../types/core-contracts.d.ts";

// ── Month maps for date normalization ────────────────────────────────

const ENGLISH_MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12"
};

const SPANISH_MONTHS: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04",
  mayo: "05", junio: "06", julio: "07", agosto: "08",
  septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12"
};

const ALL_MONTHS: Record<string, string> = { ...ENGLISH_MONTHS, ...SPANISH_MONTHS };

function padTwo(n: string | number): string {
  return String(n).padStart(2, "0");
}

/**
 * Normalize a raw date string to ISO format (YYYY-MM-DD) when possible.
 */
function normalizeDate(raw: string): string {
  // ISO format: 2024-03-15
  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${padTwo(isoMatch[2])}-${padTwo(isoMatch[3])}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = raw.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${padTwo(dmy[2])}-${padTwo(dmy[1])}`;
  }

  // MM/DD/YYYY (ambiguous, but try if month <= 12)
  // We prefer DD/MM/YYYY above, so this only matches if first number > 12
  // Actually, the regex above already handles it. Skip this case.

  // "March 15, 2024" or "15 March 2024"
  const enLong1 = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (enLong1) {
    const month = ENGLISH_MONTHS[enLong1[1].toLowerCase()];
    if (month) {
      return `${enLong1[3]}-${month}-${padTwo(enLong1[2])}`;
    }
  }

  const enLong2 = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (enLong2) {
    const month = ENGLISH_MONTHS[enLong2[2].toLowerCase()];
    if (month) {
      return `${enLong2[3]}-${month}-${padTwo(enLong2[1])}`;
    }
  }

  // "15 de marzo de 2024"
  const esLong = raw.match(/^(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})$/i);
  if (esLong) {
    const month = SPANISH_MONTHS[esLong[2].toLowerCase()];
    if (month) {
      return `${esLong[3]}-${month}-${padTwo(esLong[1])}`;
    }
  }

  return raw;
}

// ── Regex patterns ───────────────────────────────────────────────────

// ISO dates
const ISO_DATE_RE = /\b(\d{4}-\d{1,2}-\d{1,2})\b/g;

// DD/MM/YYYY or DD-MM-YYYY
const DMY_DATE_RE = /\b(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})\b/g;

// English long dates: "March 15, 2024" or "March 15 2024"
const EN_LONG_DATE_RE = /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/gi;

// "15 March 2024"
const EN_LONG_DATE2_RE = /\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/gi;

// Spanish long dates: "15 de marzo de 2024"
const ES_LONG_DATE_RE = /\b(\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+\d{4})\b/gi;

// Legal article references
const ARTICLE_FULL_RE = /\b(Art(?:[íi]culo|\.)\s*\d+(?:\s*(?:bis|ter|qu[aá]ter|inc(?:iso)?\.?\s*\w+)?)?(?:\s+de\s+la\s+(?:Ley|Constituci[oó]n|Ordenanza|Resoluci[oó]n)\s+(?:N[°ºo.]?\s*)?\d[\w/.]*)?)/gi;

const SECTION_RE = /\b((?:Section|§)\s*\d+(?:\.\d+)*(?:\([a-z]\))?)/gi;

// Email
const EMAIL_RE = /\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g;

// URL
const URL_RE = /\bhttps?:\/\/[^\s<>)"']+/gi;

// Organization suffixes
const ORG_RE = /\b([A-Z][\w&.']*(?:\s+[A-Z][\w&.']*)*\s+(?:Inc\.|Corp\.|LLC|Ltd\.|S\.?A\.?|S\.?R\.?L\.?|PLC|GmbH|Co\.|Foundation|Association|University|Institute))\b/g;

// Proper nouns: 2+ consecutive capitalized words not at sentence start
// We look for sequences after a lowercase letter or mid-sentence
const PROPER_NOUN_RE = /(?<=[a-z,;:]\s)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/g;

/**
 * Parse an article reference into structured form.
 */
function parseArticleRef(raw: string): ArticleRef {
  const numberMatch = raw.match(/\b(\d+(?:\s*(?:bis|ter|qu[aá]ter))?)/);
  const lawMatch = raw.match(/(?:Ley|Constituci[oó]n|Ordenanza|Resoluci[oó]n)\s+(?:N[°ºo.]?\s*)?\d[\w/.]*/i);

  return {
    raw,
    number: numberMatch ? numberMatch[1].trim() : "",
    ...(lawMatch ? { law: lawMatch[0].trim() } : {})
  };
}

/**
 * Extract named entities from text using regex patterns.
 *
 * Detects: dates (multiple formats), legal article references,
 * emails, URLs, organizations, and capitalized proper nouns.
 * Supports custom patterns via options.
 */
export function extractEntities(text: string, options?: EntityExtractorOptions): ExtractedEntities {
  const people: string[] = [];
  const organizations: string[] = [];
  const dates: DateRef[] = [];
  const articles: ArticleRef[] = [];
  const locations: string[] = [];
  const emails: string[] = [];
  const urls: string[] = [];
  const custom: Record<string, string[]> = {};

  const seenDates = new Set<string>();
  const seenArticles = new Set<string>();
  const seenEmails = new Set<string>();
  const seenUrls = new Set<string>();
  const seenOrgs = new Set<string>();
  const seenNouns = new Set<string>();

  // ── Dates ──────────────────────────────────────────────────────
  function collectDates(re: RegExp): void {
    let m: RegExpExecArray | null;
    // Reset lastIndex for global regex
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1] ?? m[0];
      if (!seenDates.has(raw.toLowerCase())) {
        seenDates.add(raw.toLowerCase());
        dates.push({ raw, normalized: normalizeDate(raw) });
      }
    }
  }

  collectDates(ISO_DATE_RE);
  collectDates(DMY_DATE_RE);
  collectDates(EN_LONG_DATE_RE);
  collectDates(EN_LONG_DATE2_RE);
  collectDates(ES_LONG_DATE_RE);

  // ── Articles ───────────────────────────────────────────────────
  for (const re of [ARTICLE_FULL_RE, SECTION_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1] ?? m[0];
      const key = raw.toLowerCase().replace(/\s+/g, " ");
      if (!seenArticles.has(key)) {
        seenArticles.add(key);
        articles.push(parseArticleRef(raw));
      }
    }
  }

  // ── Emails ─────────────────────────────────────────────────────
  EMAIL_RE.lastIndex = 0;
  let em: RegExpExecArray | null;
  while ((em = EMAIL_RE.exec(text)) !== null) {
    const email = em[1].toLowerCase();
    if (!seenEmails.has(email)) {
      seenEmails.add(email);
      emails.push(em[1]);
    }
  }

  // ── URLs ───────────────────────────────────────────────────────
  URL_RE.lastIndex = 0;
  let um: RegExpExecArray | null;
  while ((um = URL_RE.exec(text)) !== null) {
    const url = um[0];
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      urls.push(url);
    }
  }

  // ── Organizations ──────────────────────────────────────────────
  ORG_RE.lastIndex = 0;
  let om: RegExpExecArray | null;
  while ((om = ORG_RE.exec(text)) !== null) {
    const org = om[1].trim();
    const key = org.toLowerCase();
    if (!seenOrgs.has(key)) {
      seenOrgs.add(key);
      organizations.push(org);
    }
  }

  // ── Proper nouns (people heuristic) ────────────────────────────
  PROPER_NOUN_RE.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = PROPER_NOUN_RE.exec(text)) !== null) {
    const name = pm[1].trim();
    const key = name.toLowerCase();
    // Skip if already captured as organization
    if (!seenNouns.has(key) && !seenOrgs.has(key)) {
      seenNouns.add(key);
      people.push(name);
    }
  }

  // ── Custom patterns ────────────────────────────────────────────
  if (options?.customPatterns) {
    for (const pattern of options.customPatterns) {
      const re = new RegExp(pattern.pattern, pattern.flags || "gi");
      const matches: string[] = [];
      let cm: RegExpExecArray | null;
      while ((cm = re.exec(text)) !== null) {
        const value = cm[1] ?? cm[0];
        if (!matches.includes(value)) {
          matches.push(value);
        }
      }
      if (matches.length > 0) {
        custom[pattern.name] = matches;
      }
    }
  }

  return { people, organizations, dates, articles, locations, emails, urls, custom };
}
