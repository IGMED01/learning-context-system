const DEFAULT_STOPWORDS = new Set([
  "a",
  "al",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "con",
  "de",
  "del",
  "el",
  "en",
  "for",
  "from",
  "how",
  "in",
  "is",
  "la",
  "las",
  "los",
  "of",
  "on",
  "or",
  "para",
  "por",
  "que",
  "the",
  "to",
  "un",
  "una",
  "with",
  "y"
]);

const KIND_PRIOR = {
  code: 1,
  test: 0.95,
  spec: 0.9,
  memory: 0.85,
  doc: 0.78,
  chat: 0.42,
  log: 0.2
};

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(text = "") {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s./_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text = "", stopwords = DEFAULT_STOPWORDS) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !stopwords.has(token));
}

function toSet(tokens) {
  return new Set(tokens);
}

function jaccardSimilarity(aTokens, bTokens) {
  const a = toSet(aTokens);
  const b = toSet(bTokens);

  if (!a.size || !b.size) {
    return 0;
  }

  let intersection = 0;

  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (a.size + b.size - intersection);
}

function overlapScore(chunkTokens, focusTokens) {
  if (!chunkTokens.length || !focusTokens.length) {
    return 0;
  }

  const chunkSet = toSet(chunkTokens);
  const focusSet = toSet(focusTokens);
  let overlap = 0;

  for (const token of focusSet) {
    if (chunkSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / focusSet.size;
}

function densityScore(tokens) {
  if (!tokens.length) {
    return 0;
  }

  const uniqueRatio = toSet(tokens).size / tokens.length;
  return clamp(uniqueRatio);
}

function approximateTokenCount(text = "") {
  return tokenize(text).length;
}

export function compressContent(content, focus = "", sentenceBudget = 3) {
  const focusTokens = tokenize(focus);
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length <= sentenceBudget) {
    return content.trim();
  }

  const ranked = sentences
    .map((sentence, index) => {
      const tokens = tokenize(sentence);
      return {
        sentence,
        index,
        score: overlapScore(tokens, focusTokens) * 0.7 + densityScore(tokens) * 0.3
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, sentenceBudget)
    .sort((left, right) => left.index - right.index);

  return ranked.map((item) => item.sentence).join(" ").trim();
}

export function scoreChunk(chunk, focus, selectedChunks = []) {
  const focusTokens = tokenize(focus);
  const chunkTokens = tokenize(chunk.content);
  const overlap = overlapScore(chunkTokens, focusTokens);
  const density = densityScore(chunkTokens);
  const kindPrior = KIND_PRIOR[chunk.kind] ?? 0.5;
  const certainty = clamp(chunk.certainty ?? 0.7);
  const recency = clamp(chunk.recency ?? 0.5);
  const teachingValue = clamp(chunk.teachingValue ?? 0.5);
  const priority = clamp(chunk.priority ?? 0.5);

  const redundancy = selectedChunks.length
    ? Math.max(
        ...selectedChunks.map((selected) =>
          jaccardSimilarity(chunkTokens, tokenize(selected.content))
        )
      )
    : 0;

  const positiveScore =
    overlap * 0.36 +
    kindPrior * 0.18 +
    certainty * 0.14 +
    recency * 0.1 +
    teachingValue * 0.12 +
    priority * 0.06 +
    density * 0.04;

  const penalty = redundancy * 0.25;
  const total = clamp(positiveScore - penalty);

  return {
    total,
    detail: {
      overlap,
      kindPrior,
      certainty,
      recency,
      teachingValue,
      priority,
      density,
      redundancy,
      penalty
    }
  };
}

export function selectContextWindow(chunks, options = {}) {
  const {
    focus = "",
    tokenBudget = 350,
    maxChunks = 6,
    minScore = 0.25,
    sentenceBudget = 3
  } = options;

  const prepared = chunks.map((chunk) => {
    const compressedContent = compressContent(chunk.content, focus, sentenceBudget);
    return {
      ...chunk,
      content: compressedContent,
      tokenCount: approximateTokenCount(compressedContent)
    };
  });

  const selected = [];
  const suppressed = [];
  let usedTokens = 0;

  const ranked = prepared
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, focus).total
    }))
    .sort((left, right) => right.score - left.score);

  for (const entry of ranked) {
    const rescored = scoreChunk(entry.chunk, focus, selected);
    const chunk = {
      ...entry.chunk,
      score: rescored.total,
      diagnostics: rescored.detail
    };

    if (chunk.score < minScore) {
      suppressed.push({
        id: chunk.id,
        reason: "score-below-threshold",
        score: chunk.score
      });
      continue;
    }

    if (selected.length >= maxChunks) {
      suppressed.push({
        id: chunk.id,
        reason: "max-chunks-reached",
        score: chunk.score
      });
      continue;
    }

    if (usedTokens + chunk.tokenCount > tokenBudget) {
      suppressed.push({
        id: chunk.id,
        reason: "token-budget-exceeded",
        score: chunk.score
      });
      continue;
    }

    if (chunk.diagnostics.redundancy >= 0.65) {
      suppressed.push({
        id: chunk.id,
        reason: "redundant-context",
        score: chunk.score
      });
      continue;
    }

    selected.push(chunk);
    usedTokens += chunk.tokenCount;
  }

  return {
    focus,
    tokenBudget,
    usedTokens,
    selected,
    suppressed
  };
}
