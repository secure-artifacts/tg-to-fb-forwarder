/**
 * 过滤规则：命中任一条则丢弃，不转发。
 * @param {string} text
 * @param {string[]} rules
 * @param {{ mode?: 'contains'|'exact'|'regex' }} options
 */
function shouldFilterMessage(text, rules, options = {}) {
  const mode = options.mode || "contains";
  const normalized = (text || "").trim();
  if (!normalized) return false;

  const maxRuleLen =
    (typeof TgFbConfig !== "undefined" && TgFbConfig.MAX_FILTER_RULE_LENGTH) || 200;
  const activeRules = (rules || [])
    .map((r) => String(r || "").trim().slice(0, maxRuleLen))
    .filter(Boolean);
  if (!activeRules.length) return false;

  for (const rule of activeRules) {
    if (mode === "exact") {
      if (normalized === rule) return true;
      continue;
    }
    if (mode === "regex") {
      const maxPat =
        (typeof TgFbConfig !== "undefined" && TgFbConfig.MAX_REGEX_PATTERN_LENGTH) || 120;
      const maxText =
        (typeof TgFbConfig !== "undefined" && TgFbConfig.MAX_FORWARD_TEXT_LENGTH) || 12000;
      if (rule.length > maxPat) {
        if (normalized.toLowerCase().includes(rule.toLowerCase().slice(0, maxPat))) return true;
        continue;
      }
      const sample = normalized.length > maxText ? normalized.slice(0, maxText) : normalized;
      try {
        if (new RegExp(rule, "i").test(sample)) return true;
      } catch {
        if (normalized.toLowerCase().includes(rule.toLowerCase())) return true;
      }
      continue;
    }
    if (normalized.toLowerCase().includes(rule.toLowerCase())) return true;
  }
  return false;
}

function parseRulesFromText(pasted) {
  return String(pasted || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseRulesFromCsv(csvText, columnLetter) {
  const col = columnToIndex(columnLetter);
  const lines = String(csvText || "").split(/\r?\n/);
  const rules = [];
  for (let i = 0; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (!row.length) continue;
    if (i === 0 && looksLikeHeader(row, col)) continue;
    const cell = row[col];
    if (cell && String(cell).trim()) rules.push(String(cell).trim());
  }
  return rules;
}

function columnToIndex(letter) {
  const s = String(letter || "A")
    .trim()
    .toUpperCase();
  let idx = 0;
  for (let i = 0; i < s.length; i++) {
    idx = idx * 26 + (s.charCodeAt(i) - 64);
  }
  return Math.max(0, idx - 1);
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function looksLikeHeader(row, col) {
  const cell = (row[col] || "").toLowerCase();
  return /过滤|filter|废话|keyword|关键词|规则/.test(cell);
}

function buildGoogleSheetCsvUrl(sheetUrl) {
  const raw = String(sheetUrl || "").trim();
  if (!raw) return null;
  const idMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return null;
  const gidMatch = raw.match(/[#&?]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`;
}

if (typeof globalThis !== "undefined") {
  globalThis.TgFbFilter = {
    shouldFilterMessage,
    parseRulesFromText,
    parseRulesFromCsv,
    buildGoogleSheetCsvUrl,
  };
}
