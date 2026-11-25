/**
 * js/app.js
 * Controlador principal del Sistema de Cotización Escolar D'Kolor (100% frontend modular).
 */

import { extractTextFromFile, parseSchoolList } from "./ocr.js";
import { exportQuoteToPDF } from "./pdf.js";
import { loadRules, matchItemWithInventory, normalizeText, saveRules } from "./rules.js";

const INVENTORY_STORAGE_KEY = "dkolor_inventory_v1";

// Respaldo mínimo embebido por si se abre index.html directamente con file:// (sin servidor)
const FALLBACK_SAMPLE_INVENTORY = [
  { id: "PROD_0001", nombre: "CUADERNO A4 CONTI CUADRICULADO 100H", precio: 3.2, stock: 120, unidad: "unidad" },
  { id: "PROD_0005", nombre: "COLA ARTESCO APLICADOR 250G", precio: 4.0, stock: 85, unidad: "frasco 250g" },
  { id: "PROD_0007", nombre: "BOLÍGRAFO FABER CASTELL 035 AZUL", precio: 0.7, stock: 300, unidad: "unidad" },
  { id: "PROD_0010", nombre: "COLORES FABER CASTELL LARGOS X 12", precio: 7.5, stock: 110, unidad: "caja x 12" },
  { id: "PROD_0012", nombre: "BORRADOR ARTESCO BLANCO GRANDE", precio: 1.0, stock: 150, unidad: "unidad" },
  { id: "PROD_0013", nombre: "TAJADOR ARTESCO METÁLICO DOBLE", precio: 1.5, stock: 140, unidad: "unidad" },
  { id: "PROD_0014", nombre: "PLUMÓN DELGADO FABER CASTELL X 12", precio: 8.5, stock: 65, unidad: "estuche x 12" },
  { id: "PROD_0020", nombre: "PAQUETE HOJAS BOND A4 75G X 500", precio: 16.5, stock: 40, unidad: "paquete" },
];

const state = {
  inventory: [],
  rules: loadRules(),
  quoteRows: [],
  learningRowIndex: null,
};

const $ = (id) => document.getElementById(id);

/* -------------------- Notificaciones (Toasts) -------------------- */
function showToast(message, type = "info") {
  const container = $("toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

/* -------------------- Inventario & Persistencia -------------------- */
function saveInventory() {
  localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(state.inventory));
  renderInventoryUI();
}

async function fetchJsonSafe(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function normalizeProductRow(raw, idx) {
  const id = String(raw.id ?? raw.codigo ?? `PROD_${String(idx + 1).padStart(4, "0")}`).trim();
  const nombre = String(raw.nombre ?? raw.descripcion ?? "").trim();
  const precio = Number(raw.precio ?? raw.precio_und ?? 0) || 0;
  const stock = Number(raw.stock ?? 0) || 0;
  const unidad = String(raw.unidad ?? "unidad").trim() || "unidad";
  return { id, nombre, precio, stock, unidad };
}

async function initInventory() {
  try {
    const saved = localStorage.getItem(INVENTORY_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length) {
        state.inventory = parsed;
        renderInventoryUI();
        return;
      }
    }
  } catch {
    // Ignorar localStorage corrupto y recargar muestra
  }

  try {
    const sample = await fetchJsonSafe("data/sample-inventory.json");
    state.inventory = sample.map(normalizeProductRow).filter((p) => p.nombre);
  } catch {
    state.inventory = FALLBACK_SAMPLE_INVENTORY;
  }
  saveInventory();
}

async function loadDkolorFullCatalog() {
  try {
    const raw = await fetchJsonSafe("data/products.json");
    state.inventory = raw.map(normalizeProductRow).filter((p) => p.nombre);
    saveInventory();
    showToast(`Catálogo D'Kolor cargado (${state.inventory.length} productos).`, "success");
  } catch {
    showToast("No se pudo leer data/products.json (usa un servidor local o GitHub Pages).", "warning");
  }
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(sep).map((h) => normalizeText(h));

  const idxId = headers.findIndex((h) => ["id", "codigo"].includes(h));
  const idxName = headers.findIndex((h) => ["nombre", "descripcion", "producto"].includes(h));
  const idxPrice = headers.findIndex((h) => h.includes("precio"));
  const idxStock = headers.findIndex((h) => h.includes("stock"));
  const idxUnit = headers.findIndex((h) => ["unidad", "presentacion"].includes(h));

  return lines
    .slice(1)
    .map((line, i) => {
      const cols = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
      return normalizeProductRow(
        {
          id: idxId >= 0 ? cols[idxId] : undefined,
          nombre: idxName >= 0 ? cols[idxName] : cols[0],
          precio: idxPrice >= 0 ? cols[idxPrice] : 0,
          stock: idxStock >= 0 ? cols[idxStock] : 0,
          unidad: idxUnit >= 0 ? cols[idxUnit] : "unidad",
        },
        i
      );
    })
    .filter((p) => p.nombre);
}

async function handleInventoryFileUpload(file) {
  if (!file) return;
  try {
    const content = await file.text();
    let items = [];
    if (file.name.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(content);
      items = (Array.isArray(parsed) ? parsed : []).map(normalizeProductRow).filter((p) => p.nombre);
    } else {
      items = parseCSV(content);
    }

    if (!items.length) {
      throw new Error("El archivo no contiene productos válidos.");
    }
    state.inventory = items;
    saveInventory();
    showToast(`Inventario importado: ${items.length} productos.`, "success");
  } catch (err) {
    showToast(`Error al importar inventario: ${err.message}`, "danger");
  }
}

/* -------------------- Renderizado de Inventario y Reglas -------------------- */
function renderInventoryUI() {
  $("statInventoryCount").textContent = state.inventory.length;
  $("statRulesCount").textContent =
    state.rules.synonyms.length + state.rules.equivalences.length;

  // Datalist para autocompletado en la tabla Excel
  const dl = $("inventoryDatalist");
  dl.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const prod of state.inventory.slice(0, 500)) {
    const opt = document.createElement("option");
    opt.value = prod.nombre;
    opt.label = `S/ ${prod.precio.toFixed(2)} • ${prod.unidad}`;
    frag.appendChild(opt);
  }
  dl.appendChild(frag);

  // Select de producto sustituto en modal de equivalencias
  const sel = $("eqTargetProduct");
  sel.innerHTML = "";
  for (const prod of state.inventory.slice(0, 300)) {
    const opt = document.createElement("option");
    opt.value = prod.id;
    opt.textContent = `${prod.nombre} (S/ ${prod.precio.toFixed(2)})`;
    sel.appendChild(opt);
  }

  renderQuickInventoryPreview();
  renderModalInventoryList();
}

function renderQuickInventoryPreview() {
  const query = normalizeText($("quickInventorySearch").value);
  const container = $("quickInventoryPreview");
  const filtered = state.inventory
    .filter((p) => !query || normalizeText(`${p.id} ${p.nombre}`).includes(query))
    .slice(0, 25);

  container.innerHTML = "";
  if (!filtered.length) {
    container.innerHTML = `<div class="rule-item"><small>Sin resultados en inventario.</small></div>`;
    return;
  }

  for (const prod of filtered) {
    const row = document.createElement("div");
    row.className = "rule-item";
    row.innerHTML = `
      <div style="min-width:0;">
        <div style="font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(prod.nombre)}</div>
        <small>${escapeHtml(prod.id)} • ${escapeHtml(prod.unidad)} • Stock: ${prod.stock}</small>
      </div>
      <strong style="color:var(--success); white-space:nowrap;">S/ ${prod.precio.toFixed(2)}</strong>
    `;
    container.appendChild(row);
  }
}

function renderModalInventoryList() {
  const list = $("modalInventoryList");
  list.innerHTML = "";
  for (const prod of state.inventory.slice(0, 80)) {
    const div = document.createElement("div");
    div.className = "rule-item";
    div.innerHTML = `
      <div>
        <strong>${escapeHtml(prod.nombre)}</strong>
        <small>${escapeHtml(prod.id)} • ${escapeHtml(prod.unidad)} • Stock: ${prod.stock} • S/ ${prod.precio.toFixed(2)}</small>
      </div>
      <button class="btn btn-sm btn-ghost" data-del-prod="${escapeHtml(prod.id)}">Eliminar</button>
    `;
    list.appendChild(div);
  }
}

function renderRulesModal() {
  $("statRulesCount").textContent =
    state.rules.synonyms.length + state.rules.equivalences.length;

  const synList = $("synonymsList");
  synList.innerHTML = "";
  state.rules.synonyms.forEach((s, idx) => {
    const item = document.createElement("div");
    item.className = "rule-item";
    item.innerHTML = `
      <div>
        <strong>"${escapeHtml(s.alias)}"</strong> → <code>${escapeHtml(s.target)}</code>
      </div>
      <button class="btn btn-sm btn-ghost" data-del-syn="${idx}">Eliminar</button>
    `;
    synList.appendChild(item);
  });

  const eqList = $("equivalencesList");
  eqList.innerHTML = "";
  state.rules.equivalences.forEach((eq, idx) => {
    const item = document.createElement("div");
    item.className = "rule-item";
    item.innerHTML = `
      <div>
        <strong>"${escapeHtml(eq.pattern)}"</strong> → ${eq.multiplier}× <code>${escapeHtml(eq.targetName)}</code>
        <small>${escapeHtml(eq.note || "")}</small>
      </div>
      <button class="btn btn-sm btn-ghost" data-del-eq="${idx}">Eliminar</button>
    `;
    eqList.appendChild(item);
  });
}

/* -------------------- Tabla de Cotización (Estilo Excel) -------------------- */
const STATUS_BADGES = {
  exacto: ["Exacto", "badge-exacto"],
  sinonimo: ["Sinónimo", "badge-sinonimo"],
  equivalencia: ["Equivalencia", "badge-equivalencia"],
  sin_coincidencia: ["Sin coincidencia", "badge-sin_coincidencia"],
  ilegible: ["Ilegible", "badge-ilegible"],
  manual: ["Manual", "badge-manual"],
};

function renderQuoteTable() {
  const tbody = $("quoteTableBody");
  const empty = $("quoteEmptyState");
  tbody.innerHTML = "";

  empty.style.display = state.quoteRows.length ? "none" : "block";

  state.quoteRows.forEach((row, idx) => {
    const tr = document.createElement("tr");
    const subtotal = (Number(row.cantidad) || 0) * (Number(row.precioUnitario) || 0);
    const [badgeText, badgeClass] = STATUS_BADGES[row.status] || STATUS_BADGES.manual;

    tr.innerHTML = `
      <td style="text-align:center; color:var(--text-muted); font-size:12px;">${idx + 1}</td>
      <td>
        <div class="cell-raw" title="${escapeHtml(row.rawText || "")}">${escapeHtml(row.rawText || "Manual")}</div>
      </td>
      <td>
        <input
          class="cell-input"
          type="text"
          list="inventoryDatalist"
          value="${escapeHtml(row.producto)}"
          data-row="${idx}"
          data-field="producto"
          placeholder="Nombre del artículo..."
        />
      </td>
      <td>
        <input
          class="cell-input"
          type="text"
          value="${escapeHtml(row.unidad)}"
          data-row="${idx}"
          data-field="unidad"
        />
      </td>
      <td>
        <input
          class="cell-input right"
          type="number"
          min="0"
          step="0.5"
          value="${row.cantidad}"
          data-row="${idx}"
          data-field="cantidad"
        />
      </td>
      <td>
        <input
          class="cell-input right"
          type="number"
          min="0"
          step="0.05"
          value="${Number(row.precioUnitario).toFixed(2)}"
          data-row="${idx}"
          data-field="precioUnitario"
        />
      </td>
      <td class="cell-subtotal" data-subtotal-row="${idx}">S/ ${subtotal.toFixed(2)}</td>
      <td>
        <span class="badge ${badgeClass}" title="${escapeHtml(row.ruleApplied || "")}">${badgeText}</span>
      </td>
      <td style="text-align:center; white-space:nowrap;">
        <button class="btn btn-icon btn-ghost" title="Guardar como regla aprendida" data-learn-row="${idx}">
          Aprender
        </button>
        <button class="btn btn-icon btn-ghost" title="Eliminar fila" data-del-row="${idx}">
          ✕
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  recalculateTotals();
}

function recalculateTotals() {
  const subtotal = state.quoteRows.reduce(
    (acc, r) => acc + (Number(r.cantidad) || 0) * (Number(r.precioUnitario) || 0),
    0
  );
  const discountPct = Math.max(0, Math.min(100, Number($("quoteDiscount").value) || 0));
  const discountAmount = subtotal * (discountPct / 100);
  const total = Math.max(0, subtotal - discountAmount);

  $("totalSubtotal").textContent = `S/ ${subtotal.toFixed(2)}`;
  $("totalDiscount").textContent = `- S/ ${discountAmount.toFixed(2)}`;
  $("totalGrand").textContent = `S/ ${total.toFixed(2)}`;
}

/* -------------------- Procesamiento de Lista Escolar -------------------- */
function processExtractedText() {
  const raw = $("extractedText").value.trim();
  if (!raw) {
    showToast("Pega o extrae una lista escolar primero.", "warning");
    return;
  }

  const parsed = parseSchoolList(raw);
  if (!parsed.length) {
    showToast("No se detectaron ítems válidos en el texto.", "warning");
    return;
  }

  state.quoteRows = parsed.map((item) =>
    matchItemWithInventory(item, state.inventory, state.rules)
  );
  renderQuoteTable();

  const issues = state.quoteRows.filter((r) =>
    ["ilegible", "sin_coincidencia"].includes(r.status)
  ).length;

  if (issues > 0) {
    showToast(`Lista procesada. ${issues} ítem(s) requieren revisión manual.`, "warning");
  } else {
    showToast(`Lista procesada: ${state.quoteRows.length} ítems cotizados.`, "success");
  }
}

async function handleListFile(file) {
  const progressWrap = $("ocrProgressWrap");
  const fill = $("ocrProgressFill");
  const statusLbl = $("ocrStatusLabel");
  const pctLbl = $("ocrPctLabel");
  const alertBox = $("ocrAlert");

  alertBox.className = "alert";
  alertBox.textContent = "";
  progressWrap.classList.add("active");
  fill.style.width = "5%";

  try {
    const { text, warning } = await extractTextFromFile(file, ({ status, progress }) => {
      statusLbl.textContent = status;
      pctLbl.textContent = `${progress}%`;
      fill.style.width = `${progress}%`;
    });

    $("extractedText").value = text;
    if (warning) {
      alertBox.className = "alert alert-warning show";
      alertBox.textContent = warning;
    }
    processExtractedText();
  } catch (err) {
    alertBox.className = "alert alert-danger show";
    alertBox.textContent = err.message || "Error al leer el archivo.";
    showToast(err.message, "danger");
  } finally {
    setTimeout(() => progressWrap.classList.remove("active"), 800);
  }
}

/* -------------------- Flujo "Aprender" desde Edición -------------------- */
function openLearnModal(rowIndex) {
  const row = state.quoteRows[rowIndex];
  if (!row) return;
  state.learningRowIndex = rowIndex;

  $("learnRawText").value = row.rawText || row.producto;
  $("learnPattern").value = normalizeText(row.rawText || row.producto).replace(/^\d+\s+/, "");
  $("learnProductName").value = row.producto;
  $("learnMultiplier").value = row.cantidad || 1;

  const firstWord = normalizeText(row.rawText || "").replace(/^\d+\s+/, "").split(" ")[0] || "";
  const targetWord = normalizeText(row.producto).split(" ")[0] || "";
  $("learnAlias").value = firstWord;
  $("learnTargetTerm").value = targetWord;

  openModal("learnModal");
}

/* -------------------- Utilidades Modales & Escape -------------------- */
function openModal(id) {
  $(id).classList.add("open");
  $(id).setAttribute("aria-hidden", "false");
}

function closeModal(id) {
  $(id).classList.remove("open");
  $(id).setAttribute("aria-hidden", "true");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* -------------------- Eventos de Interfaz -------------------- */
function bindEvents() {
  // Fecha de hoy por defecto
  $("quoteDate").value = new Date().toISOString().slice(0, 10);

  // Botones barra superior
  $("btnTopLoadInventory").addEventListener("click", () => $("inventoryFileInput").click());
  $("inventoryFileInput").addEventListener("change", (e) => {
    handleInventoryFileUpload(e.target.files[0]);
    e.target.value = "";
  });

  $("btnTopImportList").addEventListener("click", () => $("listFileInput").click());
  $("btnTopManageRules").addEventListener("click", () => {
    renderRulesModal();
    openModal("rulesModal");
  });
  $("btnOpenInventoryModal").addEventListener("click", () => {
    renderRulesModal();
    openModal("rulesModal");
    document.querySelector('[data-tab="tab-inventory"]').click();
  });

  $("btnTopExportPdf").addEventListener("click", async () => {
    try {
      const subtotal = state.quoteRows.reduce(
        (acc, r) => acc + (Number(r.cantidad) || 0) * (Number(r.precioUnitario) || 0),
        0
      );
      const discountPct = Number($("quoteDiscount").value) || 0;
      const discountAmount = subtotal * (discountPct / 100);
      const total = Math.max(0, subtotal - discountAmount);

      await exportQuoteToPDF({
        quoteNumber: $("quoteNumber").value,
        date: $("quoteDate").value,
        clientName: $("quoteClient").value,
        discountPct,
        rows: state.quoteRows,
        subtotal,
        discountAmount,
        total,
      });
      showToast("Cotización exportada en PDF.", "success");
    } catch (err) {
      showToast(err.message, "warning");
    }
  });

  // Dropzone
  const dropzone = $("dropzone");
  dropzone.addEventListener("click", () => $("listFileInput").click());
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) handleListFile(e.dataTransfer.files[0]);
  });
  $("listFileInput").addEventListener("change", (e) => {
    if (e.target.files.length) handleListFile(e.target.files[0]);
    e.target.value = "";
  });

  // Botones lista
  $("btnProcessList").addEventListener("click", processExtractedText);
  $("btnClearText").addEventListener("click", () => {
    $("extractedText").value = "";
    $("ocrAlert").className = "alert";
  });
  $("btnLoadSampleList").addEventListener("click", () => {
    $("extractedText").value = [
      "LISTA DE UTILES ESCOLARES",
      "1. 3 cuadernos a4 conti cuadriculados",
      "2. 1 goma de 500 ml",
      "3. 4 lapiceros faber castell azul",
      "4. 1 caja de colores faber castell x 12",
      "5. 2 tajadores metalicos",
      "6. @@@ ### ??? texto borroso",
    ].join("\n");
    processExtractedText();
  });

  // Inventario rápido
  $("quickInventorySearch").addEventListener("input", renderQuickInventoryPreview);
  $("btnLoadDkolorCatalog").addEventListener("click", loadDkolorFullCatalog);
  $("btnResetSampleInventory").addEventListener("click", async () => {
    localStorage.removeItem(INVENTORY_STORAGE_KEY);
    await initInventory();
    showToast("Inventario demo restaurado.", "info");
  });

  // Tabla Excel: edición en línea
  $("quoteTableBody").addEventListener("input", (e) => {
    const target = e.target;
    const idx = Number(target.dataset.row);
    const field = target.dataset.field;
    if (Number.isNaN(idx) || !field || !state.quoteRows[idx]) return;

    const row = state.quoteRows[idx];
    if (field === "cantidad" || field === "precioUnitario") {
      row[field] = parseFloat(target.value) || 0;
    } else {
      row[field] = target.value;
      // Si el usuario selecciona un producto exacto del datalist, autocompletar precio y unidad
      if (field === "producto") {
        const match = state.inventory.find(
          (p) => normalizeText(p.nombre) === normalizeText(target.value)
        );
        if (match) {
          row.productId = match.id;
          row.unidad = match.unidad;
          row.precioUnitario = match.precio;
          row.status = "manual";
          renderQuoteTable();
          return;
        }
      }
    }

    const sub = (Number(row.cantidad) || 0) * (Number(row.precioUnitario) || 0);
    const subCell = document.querySelector(`[data-subtotal-row="${idx}"]`);
    if (subCell) subCell.textContent = `S/ ${sub.toFixed(2)}`;
    recalculateTotals();
  });

  $("quoteTableBody").addEventListener("click", (e) => {
    const delBtn = e.target.closest("[data-del-row]");
    if (delBtn) {
      state.quoteRows.splice(Number(delBtn.dataset.delRow), 1);
      renderQuoteTable();
      return;
    }
    const learnBtn = e.target.closest("[data-learn-row]");
    if (learnBtn) {
      openLearnModal(Number(learnBtn.dataset.learnRow));
    }
  });

  $("btnAddQuoteRow").addEventListener("click", () => {
    state.quoteRows.push({
      rawText: "Nuevo ítem",
      producto: "",
      productId: null,
      unidad: "unidad",
      cantidad: 1,
      precioUnitario: 0,
      status: "manual",
      ruleApplied: "Agregado manualmente",
    });
    renderQuoteTable();
  });

  $("btnClearQuote").addEventListener("click", () => {
    state.quoteRows = [];
    renderQuoteTable();
  });

  $("quoteDiscount").addEventListener("input", recalculateTotals);

  // Modales y Tabs
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(btn.dataset.tab).classList.add("active");
    });
  });

  // Formularios de Reglas e Inventario
  $("formAddSynonym").addEventListener("submit", (e) => {
    e.preventDefault();
    const alias = $("synAlias").value.trim();
    const target = $("synTarget").value.trim();
    if (!alias || !target) return;
    state.rules.synonyms.push({ alias, target });
    saveRules(state.rules);
    renderRulesModal();
    e.target.reset();
    showToast(`Sinónimo guardado: "${alias}" → "${target}".`, "success");
  });

  $("synonymsList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-del-syn]");
    if (!btn) return;
    state.rules.synonyms.splice(Number(btn.dataset.delSyn), 1);
    saveRules(state.rules);
    renderRulesModal();
  });

  $("formAddEquivalence").addEventListener("submit", (e) => {
    e.preventDefault();
    const pattern = $("eqPattern").value.trim();
    const targetId = $("eqTargetProduct").value;
    const multiplier = parseFloat($("eqMultiplier").value) || 1;
    const prod = state.inventory.find((p) => p.id === targetId);
    if (!pattern || !prod) return;

    state.rules.equivalences.push({
      id: `eq_${Date.now()}`,
      pattern,
      targetId: prod.id,
      targetName: prod.nombre,
      multiplier,
      note: `Regla personalizada (${pattern} × ${multiplier})`,
    });
    saveRules(state.rules);
    renderRulesModal();
    e.target.reset();
    showToast("Regla de equivalencia agregada.", "success");
  });

  $("equivalencesList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-del-eq]");
    if (!btn) return;
    state.rules.equivalences.splice(Number(btn.dataset.delEq), 1);
    saveRules(state.rules);
    renderRulesModal();
  });

  $("formAddProduct").addEventListener("submit", (e) => {
    e.preventDefault();
    const prod = normalizeProductRow({
      id: $("prodId").value,
      nombre: $("prodName").value,
      precio: $("prodPrice").value,
      stock: $("prodStock").value,
      unidad: $("prodUnit").value,
    });
    const idx = state.inventory.findIndex((p) => p.id === prod.id);
    if (idx >= 0) state.inventory[idx] = prod;
    else state.inventory.unshift(prod);
    saveInventory();
    e.target.reset();
    showToast(`Producto ${prod.id} guardado.`, "success");
  });

  $("modalInventoryList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-del-prod]");
    if (!btn) return;
    const id = btn.dataset.delProd;
    state.inventory = state.inventory.filter((p) => p.id !== id);
    saveInventory();
    showToast(`Producto ${id} eliminado.`, "info");
  });

  // Modal Aprender Regla
  $("learnType").addEventListener("change", (e) => {
    const isSyn = e.target.value === "synonym";
    $("learnSynonymFields").style.display = isSyn ? "block" : "none";
    $("learnEquivalenceFields").style.display = isSyn ? "none" : "block";
  });

  $("formLearnRule").addEventListener("submit", (e) => {
    e.preventDefault();
    const type = $("learnType").value;
    if (type === "synonym") {
      const alias = $("learnAlias").value.trim();
      const target = $("learnTargetTerm").value.trim();
      if (!alias || !target) return;
      state.rules.synonyms.push({ alias, target });
    } else {
      const pattern = $("learnPattern").value.trim();
      const prodName = $("learnProductName").value.trim();
      const multiplier = parseFloat($("learnMultiplier").value) || 1;
      const prod = state.inventory.find(
        (p) => normalizeText(p.nombre) === normalizeText(prodName)
      );
      if (!pattern || !prodName) return;
      state.rules.equivalences.push({
        id: `eq_${Date.now()}`,
        pattern,
        targetId: prod?.id || null,
        targetName: prod?.nombre || prodName,
        multiplier,
        note: `Aprendida de cotización (${pattern} × ${multiplier})`,
      });
    }

    saveRules(state.rules);
    renderRulesModal();
    closeModal("learnModal");
    showToast("¡Regla aprendida y guardada para futuras listas!", "success");
  });
}

/* -------------------- Arranque -------------------- */
(async function bootstrap() {
  bindEvents();
  await initInventory();
  renderRulesModal();
  renderQuoteTable();
})();
