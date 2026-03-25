// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").ExtractedEntities} ExtractedEntities
 * @typedef {import("../types/core-contracts.d.ts").EntityExtractorOptions} EntityExtractorOptions
 * @typedef {import("../types/core-contracts.d.ts").EntityPattern} EntityPattern
 * @typedef {import("../types/core-contracts.d.ts").DateRef} DateRef
 * @typedef {import("../types/core-contracts.d.ts").ArticleRef} ArticleRef
 */

// ── Month maps for date normalization ────────────────────────────────

/** @type {Record<string, string>} */
const ENGLISH_MONTHS = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12"
};

/** @type {Record<string, string>} */
const SPANISH_MONTHS = {
  enero: "01", febrero: "02", marzo: "03", abril: "04",
  mayo: "05", junio: "06", julio: "07", agosto: "08",
  septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12"
};

/**
 * @param {string | number} n
 * @returns {string}
 */
function padTwo(n) {
  return String(n).padStart(2, "0");
}

/**
 * Normalize a raw date string to ISO format (YYYY-MM-DD) when possible.
 * @param {string} raw
 * @returns {string}
 */
function normalizeDate(raw) {
  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${padTwo(isoMatch[2])}-${padTwo(isoMatch[3])}`;
  }

  const dmy = raw.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${padTwo(dmy[2])}-${padTwo(dmy[1])}`;
  }

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

const ISO_DATE_RE = /\b(\d{4}-\d{1,2}-\d{1,2})\b/g;
const DMY_DATE_RE = /\b(\d{1,2}[/\-]\d{1,2}[/\-]\d{4})\b/g;
const EN_LONG_DATE_RE = /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/gi;
const EN_LONG_DATE2_RE = /\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\b/gi;
const ES_LONG_DATE_RE = /\b(\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+\d{4})\b/gi;
const ARTICLE_FULL_RE = /\b(Art(?:[íi]culo|\.)\s*\d+(?:\s*(?:bis|ter|qu[aá]ter|inc(?:iso)?\.?\s*\w+)?)?(?:\s+de\s+la\s+(?:Ley|Constituci[oó]n|Ordenanza|Resoluci[oó]n)\s+(?:N[°ºo.]?\s*)?\d[\w/.]*)?)/gi;
const SECTION_RE = /\b((?:Section|§)\s*\d+(?:\.\d+)*(?:\([a-z]\))?)/gi;
const EMAIL_RE = /\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g;
const URL_RE = /\bhttps?:\/\/[^\s<>)"']+/gi;
const ORG_RE = /\b([A-Z][\w&.']*(?:\s+[A-Z][\w&.']*)*\s+(?:Inc\.|Corp\.|LLC|Ltd\.|S\.?A\.?|S\.?R\.?L\.?|PLC|GmbH|Co\.|Foundation|Association|University|Institute))\b/g;
const PROPER_NOUN_RE = /(?<=[a-z,;:]\s)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/g;

/**
 * Parse an article reference into structured form.
 * @param {string} raw
 * @returns {ArticleRef}
 */
function parseArticleRef(raw) {
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
 * @param {string} text
 * @param {EntityExtractorOptions} [options]
 * @returns {ExtractedEntities}
 */
export function extractEntities(text, options) {
  /** @type {string[]} */
  const people = [];
  /** @type {string[]} */
  const organizations = [];
  /** @type {DateRef[]} */
  const dates = [];
  /** @type {ArticleRef[]} */
  const articles = [];
  /** @type {string[]} */
  const locations = [];
  /** @type {string[]} */
  const emails = [];
  /** @type {string[]} */
  const urls = [];
  /** @type {Record<string, string[]>} */
  const custom = {};

  const seenDates = new Set();
  const seenArticles = new Set();
  const seenEmails = new Set();
  const seenUrls = new Set();
  const seenOrgs = new Set();
  const seenNouns = new Set();

  /**
   * @param {RegExp} re
   */
  function collectDates(re) {
    re.lastIndex = 0;
    let m;
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
    let m;
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
  let em;
  while ((em = EMAIL_RE.exec(text)) !== null) {
    const email = em[1].toLowerCase();
    if (!seenEmails.has(email)) {
      seenEmails.add(email);
      emails.push(em[1]);
    }
  }

  // ── URLs ───────────────────────────────────────────────────────
  URL_RE.lastIndex = 0;
  let um;
  while ((um = URL_RE.exec(text)) !== null) {
    const url = um[0];
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      urls.push(url);
    }
  }

  // ── Organizations ──────────────────────────────────────────────
  ORG_RE.lastIndex = 0;
  let om;
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
  let pm;
  while ((pm = PROPER_NOUN_RE.exec(text)) !== null) {
    const name = pm[1].trim();
    const key = name.toLowerCase();
    if (!seenNouns.has(key) && !seenOrgs.has(key)) {
      seenNouns.add(key);
      people.push(name);
    }
  }

  // ── Custom patterns ────────────────────────────────────────────
  if (options?.customPatterns) {
    for (const pattern of options.customPatterns) {
      const re = new RegExp(pattern.pattern, pattern.flags || "gi");
      /** @type {string[]} */
      const matches = [];
      let cm;
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
