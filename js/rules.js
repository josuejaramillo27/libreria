/**
 * js/rules.js
 * Motor de reglas de sinonimia, equivalencias de presentación y aprendizaje continuo.
 */

const STORAGE_KEY = "dkolor_rules_v1";

export const DEFAULT_RULES = {
  synonyms: [
    { alias: "goma", target: "cola" },
    { alias: "pegamento", target: "cola" },
    { alias: "lapicero", target: "boligrafo" },
    { alias: "esfero", target: "boligrafo" },
    { alias: "tajador", target: "sacapuntas" },
    { alias: "sacapuntas", target: "tajador" },
    { alias: "marcador", target: "plumon" },
    { alias: "rotulador", target: "plumon" },
    { alias: "hojas bond", target: "paquete hojas bond" },
    { alias: "papel bond", target: "paquete hojas bond" },
    { alias: "lapices de color", target: "colores" },
    { alias: "crayolas", target: "crayones" },
    { alias: "masking tape", target: "cinta masking" },
    { alias: "archivero", target: "archivador" },
  ],
  equivalences: [
    {
      id: "eq_goma_500ml",
      pattern: "goma 500 ml",
      targetId: "PROD_0005",
      targetName: "COLA ARTESCO APLICADOR 250G",
      multiplier: 2,
      note: "1 goma de 500 ml equivale a 2 frascos de 250g",
    },
  ],
};

/**
 * Normaliza texto a minúsculas sin tildes ni caracteres especiales.
 */
export function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bx\s*(\d+)\b/g, "x$1")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Carga reglas desde localStorage o usa las reglas iniciales.
 */
export function loadRules() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_RULES);
    const parsed = JSON.parse(raw);
    return {
      synonyms: Array.isArray(parsed.synonyms) ? parsed.synonyms : DEFAULT_RULES.synonyms,
      equivalences: Array.isArray(parsed.equivalences)
        ? parsed.equivalences
        : DEFAULT_RULES.equivalences,
    };
  } catch {
    return structuredClone(DEFAULT_RULES);
  }
}

/**
 * Guarda reglas en localStorage.
 */
export function saveRules(rules) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}

/**
 * Aplica sinónimos conocidos a una descripción normalizada.
 */
function applySynonyms(normDesc, synonyms) {
  let result = normDesc;
  let usedSynonym = false;

  const sorted = [...synonyms].sort((a, b) => b.alias.length - a.alias.length);
  for (const rule of sorted) {
    const aliasNorm = normalizeText(rule.alias);
    const targetNorm = normalizeText(rule.target);
    if (!aliasNorm || !targetNorm) continue;

    const regex = new RegExp(`\\b${aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    if (regex.test(result)) {
      result = result.replace(regex, targetNorm);
      usedSynonym = true;
    }
  }

  return { text: result.replace(/\s+/g, " ").trim(), usedSynonym };
}

/**
 * Calcula similitud entre la consulta normalizada y un producto del inventario.
 */
function scoreMatch(queryNorm, productNorm) {
  if (!queryNorm || !productNorm) return 0;
  if (queryNorm === productNorm) return 100;

  const qTokens = queryNorm.split(" ").filter(Boolean);
  const pTokens = productNorm.split(" ").filter(Boolean);
  const pSet = new Set(pTokens);

  let exactTokens = 0;
  let partialTokens = 0;

  for (const qt of qTokens) {
    if (pSet.has(qt)) {
      exactTokens += 1;
    } else if (pTokens.some((pt) => pt.includes(qt) || qt.includes(pt))) {
      partialTokens += 0.65;
    }
  }

  const coverage = (exactTokens + partialTokens) / Math.max(qTokens.length, 1);
  const bonusSubstring = productNorm.includes(queryNorm) ? 0.18 : 0;
  return Math.min(99, Math.round((coverage * 0.85 + bonusSubstring) * 100));
}

/**
 * Cruza un ítem parseado contra el inventario usando reglas de equivalencia y sinónimos.
 */
export function matchItemWithInventory(parsedItem, inventory, rules) {
  if (parsedItem.isIllegible) {
    return {
      rawText: parsedItem.rawText,
      producto: parsedItem.description,
      productId: null,
      unidad: parsedItem.unit || "unidad",
      cantidad: parsedItem.quantity || 1,
      precioUnitario: 0,
      status: "ilegible",
      ruleApplied: parsedItem.illegibleReason || "Texto ilegible",
    };
  }

  const normQuery = normalizeText(parsedItem.description);

  // 1. Reglas de equivalencia / sustitución por presentación o patrón
  for (const eq of rules.equivalences) {
    const patternNorm = normalizeText(eq.pattern);
    if (!patternNorm) continue;
    const patternTokens = patternNorm.split(" ").filter(Boolean);
    const matchesAll = patternTokens.every((tok) => normQuery.includes(tok));

    if (matchesAll) {
      const targetProd =
        inventory.find((p) => p.id === eq.targetId) ||
        inventory.find((p) => normalizeText(p.nombre) === normalizeText(eq.targetName));

      if (targetProd) {
        const multiplier = Number(eq.multiplier) > 0 ? Number(eq.multiplier) : 1;
        const adjustedQty = Math.round(parsedItem.quantity * multiplier * 100) / 100;
        return {
          rawText: parsedItem.rawText,
          producto: targetProd.nombre,
          productId: targetProd.id,
          unidad: targetProd.unidad || "unidad",
          cantidad: adjustedQty,
          precioUnitario: Number(targetProd.precio) || 0,
          status: "equivalencia",
          ruleApplied: eq.note || `Equivalencia (${eq.pattern} × ${multiplier})`,
        };
      }
    }
  }

  // 2. Diccionario de sinónimos
  const { text: expandedQuery, usedSynonym } = applySynonyms(normQuery, rules.synonyms);

  // 3. Búsqueda por similitud en inventario
  let bestProd = null;
  let bestScore = 0;

  for (const prod of inventory) {
    const prodNorm = normalizeText(`${prod.nombre} ${prod.unidad || ""}`);
    const s = scoreMatch(expandedQuery, prodNorm);
    if (s > bestScore) {
      bestScore = s;
      bestProd = prod;
    }
  }

  if (!bestProd || bestScore < 42) {
    return {
      rawText: parsedItem.rawText,
      producto: parsedItem.description,
      productId: null,
      unidad: parsedItem.unit || "unidad",
      cantidad: parsedItem.quantity || 1,
      precioUnitario: 0,
      status: "sin_coincidencia",
      ruleApplied: "No encontrado en inventario",
    };
  }

  const status = usedSynonym ? "sinonimo" : bestScore >= 75 ? "exacto" : "sinonimo";
  return {
    rawText: parsedItem.rawText,
    producto: bestProd.nombre,
    productId: bestProd.id,
    unidad: bestProd.unidad || parsedItem.unit || "unidad",
    cantidad: parsedItem.quantity || 1,
    precioUnitario: Number(bestProd.precio) || 0,
    status,
    ruleApplied: usedSynonym
      ? `Sinónimo aplicado (${bestScore}%)`
      : `Coincidencia (${bestScore}%)`,
  };
}
