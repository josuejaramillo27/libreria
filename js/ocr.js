/**
 * js/ocr.js
 * Extracción de texto en el navegador usando Tesseract.js (imágenes) y PDF.js (PDFs nativos o escaneados).
 */

const PDFJS_WORKER =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const SPANISH_NUMBERS = {
  "media docena": 6,
  "una docena": 12,
  "1 docena": 12,
  docena: 12,
  "un par": 2,
  par: 2,
  uno: 1,
  una: 1,
  un: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

const UNIT_REGEX =
  /^(unidades|unidad|unds|und|u\.|cajas|caja|paquetes|paquete|paq\.?|pliegos|pliego|metros|metro|mts|frascos|frasco|blister|juegos|juego|set|docenas|docena|rollos|rollo|bolsas|bolsa)\b(?:\s+de)?\s+(.*)$/i;

const HEADER_NOISE_REGEX =
  /^(lista\s+de\s+[uú]tiles|[uú]tiles\s+escolares|colegio|instituci[oó]n|grado\s*:|secci[oó]n\s*:|nivel\s*:|alumno\s*:|fecha\s*:|nota\s*:|a[nñ]o\s+escolar|inicial|primaria|secundaria)\b/i;

/**
 * Ejecuta OCR sobre una imagen o canvas mediante Tesseract.js.
 */
async function runTesseract(source, onProgress) {
  if (!window.Tesseract) {
    throw new Error("Tesseract.js no se cargó correctamente. Verifica tu conexión a internet.");
  }

  const result = await window.Tesseract.recognize(source, "spa", {
    logger: (msg) => {
      if (msg.status === "recognizing text" && typeof msg.progress === "number") {
        onProgress?.({
          status: "Reconociendo texto (OCR)...",
          progress: Math.round(msg.progress * 100),
        });
      } else if (msg.status) {
        onProgress?.({ status: `OCR: ${msg.status}`, progress: 15 });
      }
    },
  });

  const text = (result?.data?.text || "").trim();
  const confidence = Number(result?.data?.confidence ?? 0);
  return { text, confidence };
}

/**
 * Extrae texto de un archivo PDF usando PDF.js; si es escaneado, renderiza páginas y aplica OCR.
 */
async function extractFromPDF(file, onProgress) {
  if (!window.pdfjsLib) {
    throw new Error("PDF.js no está disponible. Verifica tu conexión a internet.");
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

  onProgress?.({ status: "Leyendo documento PDF...", progress: 10 });
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;

  let textPages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(" ").trim();
    if (pageText) textPages.push(pageText);
    onProgress?.({
      status: `Leyendo página ${i} de ${pdf.numPages}...`,
      progress: Math.round((i / pdf.numPages) * 60),
    });
  }

  const combined = textPages.join("\n").trim();
  if (combined.length >= 15) {
    onProgress?.({ status: "Texto extraído del PDF", progress: 100 });
    return { text: combined, confidence: 98, warning: null };
  }

  // Fallback para PDF escaneado (sin texto embebido)
  const ocrPages = [];
  let minConf = 100;
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.({
      status: `PDF escaneado: aplicando OCR a página ${i}/${pdf.numPages}...`,
      progress: 30 + Math.round((i / pdf.numPages) * 60),
    });
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;

    const { text, confidence } = await runTesseract(canvas, onProgress);
    if (text) ocrPages.push(text);
    if (confidence < minConf) minConf = confidence;
  }

  const ocrCombined = ocrPages.join("\n").trim();
  if (!ocrCombined) {
    throw new Error("El PDF parece escaneado pero no se detectó texto legible.");
  }

  const warning =
    minConf < 45
      ? `Calidad OCR baja (${Math.round(minConf)}%). Revisa el texto extraído antes de cotizar.`
      : "PDF escaneado procesado con OCR. Verifica posibles errores de lectura.";

  onProgress?.({ status: "Completado", progress: 100 });
  return { text: ocrCombined, confidence: minConf, warning };
}

/**
 * Procesa una imagen (JPG/PNG/WEBP/BMP) o un PDF y devuelve el texto extraído + alertas.
 */
export async function extractTextFromFile(file, onProgress) {
  if (!file) throw new Error("No se seleccionó ningún archivo.");

  const name = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || name.endsWith(".pdf");
  const isImage =
    file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp|bmp)$/i.test(name);

  if (!isPdf && !isImage) {
    throw new Error("Formato no compatible. Sube una imagen (JPG/PNG) o un archivo PDF.");
  }

  if (isPdf) {
    return extractFromPDF(file, onProgress);
  }

  onProgress?.({ status: "Iniciando OCR de imagen...", progress: 5 });
  const { text, confidence } = await runTesseract(file, onProgress);
  onProgress?.({ status: "Completado", progress: 100 });

  if (!text || text.length < 3) {
    throw new Error(
      "No se pudo leer texto en la imagen. Puede estar muy borrosa, oscura o sin contenido."
    );
  }

  let warning = null;
  if (confidence < 45) {
    warning = `Imagen borrosa o con baja confianza OCR (${Math.round(
      confidence
    )}%). Revisa el texto antes de cotizar.`;
  }

  return { text, confidence, warning };
}

/**
 * Detecta si una línea parece ruido ilegible de OCR.
 */
function isIllegibleLine(text) {
  const trimmed = text.trim();
  if (trimmed.length < 3) return "Texto demasiado corto";
  if (/(\?\?\?|###|□□)/.test(trimmed)) return "Caracteres ilegibles detectados";

  const nonSpace = trimmed.replace(/\s+/g, "");
  const alphaCount = (nonSpace.match(/[a-záéíóúñü]/gi) || []).length;
  if (!nonSpace.length || alphaCount / nonSpace.length < 0.35) {
    return "Proporción insuficiente de letras (posible ruido OCR)";
  }
  return null;
}

/**
 * Parsea el texto de una lista escolar en ítems estructurados.
 */
export function parseSchoolList(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (HEADER_NOISE_REGEX.test(raw) && !/\d+\s+\w+/.test(raw)) continue;

    // Quitar viñetas o numeración inicial ("1. ", "2) ", "• ", "- ")
    const body = raw.replace(/^\s*(?:\d+[.)]\s*|[-•*▪▫►]+\s*)/, "").trim();
    if (!body) continue;

    const badReason = isIllegibleLine(body);
    if (badReason) {
      items.push({
        lineNumber: i + 1,
        rawText: raw,
        quantity: 1,
        unit: "unidad",
        description: body,
        isIllegible: true,
        illegibleReason: badReason,
      });
      continue;
    }

    let quantity = 1;
    let rest = body;

    // 1. Fracción al inicio (ej. "1/2 ciento")
    const fracMatch = rest.match(/^(\d+)\s*\/\s*(\d+)\s+(.*)$/);
    if (fracMatch) {
      const num = parseFloat(fracMatch[1]);
      const den = parseFloat(fracMatch[2]);
      quantity = den > 0 ? Math.round((num / den) * 100) / 100 : 1;
      rest = fracMatch[3].trim();
    } else {
      // 2. Número al inicio (ej. "2 cuadernos", "03 x lapiceros")
      const numMatch = rest.match(/^(\d+(?:[.,]\d+)?)\s*(?:x\s+)?(.*)$/i);
      if (numMatch) {
        quantity = parseFloat(numMatch[1].replace(",", ".")) || 1;
        rest = numMatch[2].trim();
      } else {
        // 3. Número en palabras en español
        const lower = rest.toLowerCase();
        for (const [word, val] of Object.entries(SPANISH_NUMBERS)) {
          const re = new RegExp(`^${word}\\b\\s*(?:de\\s+)?(.*)$`, "i");
          const m = lower.match(re);
          if (m) {
            quantity = val;
            rest = rest.slice(rest.length - m[1].length).trim();
            break;
          }
        }
      }
    }

    let unit = "unidad";
    let description = rest;
    const unitMatch = rest.match(UNIT_REGEX);
    if (unitMatch) {
      unit = unitMatch[1].toLowerCase().replace(/\.$/, "");
      description = unitMatch[2].trim();
    }

    const badDesc = isIllegibleLine(description);
    items.push({
      lineNumber: i + 1,
      rawText: raw,
      quantity: quantity > 0 ? quantity : 1,
      unit,
      description: description || body,
      isIllegible: Boolean(badDesc),
      illegibleReason: badDesc || null,
    });
  }

  return items;
}
