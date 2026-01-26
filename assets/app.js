/* D'Kolor - Inventario + Cotización (GitHub Pages, sin backend)
   - Persistencia: localStorage
   - Import/Export Excel: SheetJS (XLSX)
   - PDF cotización: jsPDF + autotable
*/
const LS_KEY = "dkolor_db_v1";

const state = {
  products: [],
  clients: [],
  quote: {
    number: "",
    date: "",
    notes: "",
    clientCode: null,
    items: [] // {codigo, descripcion, qty, unitPrice}
  }
};

function money(n) {
  const x = Number(n || 0);
  return "S/ " + x.toFixed(2);
}
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function formatPriceInput(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
}
function parseDecimalInput(s) {
  // Acepta "3.5" o "3,5"
  const t = String(s ?? "").trim().replace(",", ".");
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}
function evalExprToNumber(raw) {
  // Permite: 12, 12.34, 12,34, 10/2, 3+1.5, 8*0.9, (10+2)/4
  const s0 = String(raw ?? "").trim();
  if (!s0) return 0;
  const s = s0.replaceAll(",", ".").replace(/\s+/g, "");
  // Solo caracteres seguros
  if (!/^[0-9+\-*/().]+$/.test(s)) return NaN;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${s});`)();
    return Number.isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}
function to2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}


function todayISO() {
  const d = new Date();
  const pad = (n)=> String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function toast(msg, kind="info") {
  const area = document.getElementById("toastArea");
  const el = document.createElement("div");
  el.className = `toast align-items-center text-bg-${kind} border-0`;
  el.role = "alert";
  el.ariaLive = "assertive";
  el.ariaAtomic = "true";
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${msg}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>`;
  area.appendChild(el);
  const t = new bootstrap.Toast(el, { delay: 2500 });
  t.show();
  el.addEventListener("hidden.bs.toast", ()=> el.remove());
}

/* ---------------- Storage ---------------- */
function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const db = JSON.parse(raw);
    if (!db || !Array.isArray(db.products) || !Array.isArray(db.clients)) return false;
    state.products = db.products;
    state.clients = db.clients;
    state.quote = db.quote || state.quote;
    return true;
  } catch { return false; }
}
function saveToLocalStorage() {
  localStorage.setItem(LS_KEY, JSON.stringify({
    products: state.products,
    clients: state.clients,
    quote: state.quote
  }));
}

/* ---------------- Initial load (JSON) ---------------- */
async function loadInitialJSON() {
  const [p, c] = await Promise.all([
    fetch("data/products.json").then(r=>r.json()),
    fetch("data/clients.json").then(r=>r.json())
  ]);
  state.products = p;
  state.clients = c;
  state.quote = { number:"", date: todayISO(), notes:"", clientCode:null, items:[] };
  saveToLocalStorage();
}

/* ---------------- Views ---------------- */
function setActiveView(view) {
  document.querySelectorAll(".app-view").forEach(s => s.classList.add("d-none"));
  document.getElementById(`view-${view}`).classList.remove("d-none");

  document.querySelectorAll(".nav-link").forEach(a => a.classList.remove("active"));
  document.querySelector(`.nav-link[data-view="${view}"]`)?.classList.add("active");

  if (view === "dashboard") renderDashboard();
  if (view === "clientes") renderClients();
  if (view === "productos") renderProducts();
  if (view === "cotizacion") renderQuote();
}

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  document.getElementById("statProducts").textContent = state.products.length.toLocaleString();
  document.getElementById("statClients").textContent = state.clients.length.toLocaleString();
  const totalStock = state.products.reduce((acc,p)=> acc + safeNum(p.stock), 0);
  document.getElementById("statStock").textContent = Math.round(totalStock).toLocaleString();
  const low = state.products.filter(p => safeNum(p.stock) <= 5).length;
  document.getElementById("statLowStock").textContent = low.toLocaleString();
}

/* ---------------- CRUD Modals ---------------- */
const editModalEl = document.getElementById("editModal");
const editModal = new bootstrap.Modal(editModalEl);
let currentEdit = null; // {type, index|null}

function openEditModal({ title, help, fields, values, onSave }) {
  currentEdit = { onSave };
  document.getElementById("editModalTitle").textContent = title;
  document.getElementById("editHelp").textContent = help || "";
  const form = document.getElementById("editForm");
  form.innerHTML = "";
  fields.forEach(f => {
    const id = `f_${f.key}`;
    const div = document.createElement("div");
    div.className = "col-12 col-md-6";
    div.innerHTML = `
      <label class="form-label form-label-sm">${f.label}</label>
      <input class="form-control form-control-sm" id="${id}" data-ftype="${f.type||""}" ${f.readonly ? "readonly":""} placeholder="${f.placeholder||""}" />
    `;
    form.appendChild(div);
    const el = document.getElementById(id);
    el.value = values[f.key] ?? "";
    if (f.type === "number") el.type = "number";
    if (f.type === "expr") { el.type = "text"; el.inputMode = "decimal"; }
    if (f.step && el.type==="number") el.step = f.step;
  });
  editModal.show();
}

document.getElementById("btnSaveEdit").addEventListener("click", (e)=>{
  e.preventDefault();
  if (!currentEdit?.onSave) return;
  const inputs = [...document.querySelectorAll("#editForm input")];
  const out = {};
  inputs.forEach(inp => {
    const k = inp.id.replace(/^f_/,"");
    const ftype = inp.dataset.ftype || "";
    if (ftype === "expr") {
      const v = evalExprToNumber(inp.value);
      out[k] = (inp.value.trim()==="") ? null : (Number.isFinite(v) ? to2(v) : null);
    } else if (inp.type === "number") {
      out[k] = inp.value === "" ? null : Number(inp.value);
    } else {
      out[k] = inp.value.trim();
    }
  });
  currentEdit.onSave(out);
  editModal.hide();
});

/* ---------------- Clients ---------------- */
function renderClients() {
  const q = (document.getElementById("clientSearch").value || "").trim().toUpperCase();
  const rows = state.clients
    .filter(c => !q || (c.codigo||"").toUpperCase().includes(q) || (c.cliente||"").toUpperCase().includes(q) || (c.dni||"").toUpperCase().includes(q))
    .slice(0, 500); // performance

  const tbody = document.getElementById("clientsTbody");
  tbody.innerHTML = rows.map((c,idx)=>`
    <tr>
      <td class="mono">${c.codigo||""}</td>
      <td>${escapeHtml(c.cliente||"")}</td>
      <td>${escapeHtml(c.dni||"")}</td>
      <td>${escapeHtml(c.telefono||"")}</td>
      <td>${escapeHtml(c.celular||"")}</td>
      <td>${escapeHtml(c.direccion||"")}</td>
      <td class="text-end">
        <button class="btn btn-outline-primary btn-sm" data-act="edit-client" data-code="${c.codigo}">Editar</button>
        <button class="btn btn-outline-danger btn-sm" data-act="del-client" data-code="${c.codigo}">🗑</button>
      </td>
    </tr>
  `).join("");

  document.getElementById("clientsCount").textContent =
    `Mostrando ${rows.length.toLocaleString()} de ${state.clients.length.toLocaleString()} (se limita a 500 por rendimiento).`;
}

document.getElementById("clientSearch").addEventListener("input", ()=> renderClients());
document.getElementById("btnNewClient").addEventListener("click", ()=>{
  const next = nextCode(state.clients.map(c=>c.codigo), "C_", 6);
  openEditModal({
    title: "Nuevo cliente",
    help: "Se guardará en tu navegador. Luego puedes exportar a Excel.",
    fields: [
      {key:"codigo", label:"Código", readonly:true},
      {key:"cliente", label:"Cliente"},
      {key:"dni", label:"DNI"},
      {key:"telefono", label:"Teléfono"},
      {key:"celular", label:"Celular"},
      {key:"direccion", label:"Dirección"},
      {key:"observaciones", label:"Observaciones"},
      {key:"tipo", label:"Tipo"}
    ],
    values: { codigo: next, cliente:"", dni:"", telefono:"", celular:"", direccion:"", observaciones:"", tipo:"" },
    onSave: (v)=>{
      state.clients.unshift(v);
      saveToLocalStorage();
      renderClients();
      toast("Cliente creado", "success");
    }
  });
});

document.getElementById("view-clientes").addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const code = btn.dataset.code;
  const i = state.clients.findIndex(c=>c.codigo===code);
  if (i<0) return;

  if (btn.dataset.act === "edit-client") {
    const c = state.clients[i];
    openEditModal({
      title: `Editar cliente (${c.codigo})`,
      fields: [
        {key:"codigo", label:"Código", readonly:true},
        {key:"cliente", label:"Cliente"},
        {key:"dni", label:"DNI"},
        {key:"telefono", label:"Teléfono"},
        {key:"celular", label:"Celular"},
        {key:"direccion", label:"Dirección"},
        {key:"observaciones", label:"Observaciones"},
        {key:"tipo", label:"Tipo"}
      ],
      values: c,
      onSave: (v)=>{
        state.clients[i]=v;
        saveToLocalStorage();
        renderClients();
        toast("Cliente actualizado", "success");
      }
    });
  }

  if (btn.dataset.act === "del-client") {
    if (!confirm(`¿Eliminar cliente ${code}?`)) return;
    state.clients.splice(i,1);
    saveToLocalStorage();
    renderClients();
    toast("Cliente eliminado", "warning");
  }
});

/* ---------------- Products ---------------- */
function renderProducts() {
  const q = (document.getElementById("productSearch").value || "").trim().toUpperCase();
  const rows = state.products
    .filter(p => !q || (p.codigo||"").toUpperCase().includes(q) || (p.descripcion||"").toUpperCase().includes(q))
    .slice(0, 500);

  const tbody = document.getElementById("productsTbody");
  tbody.innerHTML = rows.map(p=>`
    <tr>
      <td class="mono">${p.codigo||""}</td>
      <td>${escapeHtml(p.descripcion||"")}</td>
      <td class="text-end">${money(p.precio_und)}</td>
      <td class="text-end">${safeNum(p.stock).toLocaleString()}</td>
      <td class="text-end">${p.cant_mayor ?? ""}</td>
      <td class="text-end">${p.precio_cm != null ? money(p.precio_cm) : ""}</td>
      <td class="text-end">
        <button class="btn btn-outline-primary btn-sm" data-act="edit-product" data-code="${p.codigo}">Editar</button>
        <button class="btn btn-outline-danger btn-sm" data-act="del-product" data-code="${p.codigo}">🗑</button>
      </td>
    </tr>
  `).join("");

  document.getElementById("productsCount").textContent =
    `Mostrando ${rows.length.toLocaleString()} de ${state.products.length.toLocaleString()} (se limita a 500 por rendimiento).`;
}

document.getElementById("productSearch").addEventListener("input", ()=> renderProducts());
document.getElementById("btnNewProduct").addEventListener("click", ()=>{
  const next = nextCode(state.products.map(p=>p.codigo), "PROD_", 4);
  openEditModal({
    title: "Nuevo producto",
    help: "Regla de precio: si Cantidad >= 'Mayor desde' usa 'Precio mayor' (si existe).",
    fields: [
      {key:"codigo", label:"Código", readonly:true},
      {key:"descripcion", label:"Descripción"},
      {key:"costo", label:"Costo (S/)", type:"expr"},
      {key:"precio_und", label:"Precio unidad (S/)", type:"expr"},
      {key:"stock", label:"Stock", type:"number", step:"1"},
      {key:"cant_mayor", label:"Mayor desde", type:"number", step:"1"},
      {key:"precio_cm", label:"Precio mayor (S/)", type:"expr"},
      {key:"proveedor", label:"Proveedor"},
      {key:"notas", label:"Notas"}
    ],
    values: {codigo: next, descripcion:"", costo:null, precio_und:null, stock:0, cant_mayor:null, precio_cm:null, proveedor:"", notas:""},
    onSave: (v)=>{
      state.products.unshift(v);
      saveToLocalStorage();
      renderProducts();
      toast("Producto creado", "success");
    }
  });
});

document.getElementById("view-productos").addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const code = btn.dataset.code;
  const i = state.products.findIndex(p=>p.codigo===code);
  if (i<0) return;

  if (btn.dataset.act === "edit-product") {
    const p = state.products[i];
    openEditModal({
      title: `Editar producto (${p.codigo})`,
      fields: [
        {key:"codigo", label:"Código", readonly:true},
        {key:"descripcion", label:"Descripción"},
        {key:"costo", label:"Costo (S/)", type:"expr"},
        {key:"precio_und", label:"Precio unidad (S/)", type:"expr"},
        {key:"stock", label:"Stock", type:"number", step:"1"},
        {key:"cant_mayor", label:"Mayor desde", type:"number", step:"1"},
        {key:"precio_cm", label:"Precio mayor (S/)", type:"expr"},
        {key:"proveedor", label:"Proveedor"},
        {key:"notas", label:"Notas"}
      ],
      values: p,
      onSave: (v)=>{
        state.products[i]=v;
        saveToLocalStorage();
        renderProducts();
        toast("Producto actualizado", "success");
      }
    });
  }

  if (btn.dataset.act === "del-product") {
    if (!confirm(`¿Eliminar producto ${code}?`)) return;
    state.products.splice(i,1);
    saveToLocalStorage();
    renderProducts();
    toast("Producto eliminado", "warning");
  }
});

/* ---------------- Quotation ---------------- */
function renderQuote() {
  document.getElementById("quoteNumber").value = state.quote.number || autoQuoteNumber();
  document.getElementById("quoteDate").value = state.quote.date || todayISO();
  document.getElementById("quoteNotes").value = state.quote.notes || "";

  const client = state.clients.find(c=>c.codigo===state.quote.clientCode);
  document.getElementById("selectedClientBox").textContent = client
    ? `${client.codigo} • ${client.cliente} • DNI: ${client.dni || "—"}`
    : "—";

  const tbody = document.getElementById("quoteTbody");
  tbody.innerHTML = state.quote.items.map((it, idx)=>{
    const subtotal = safeNum(it.qty) * safeNum(it.unitPrice);
    return `
      <tr>
        <td class="mono">${it.codigo}</td>
        <td>${escapeHtml(it.descripcion)}</td>
        <td class="text-end"><input class="form-control form-control-sm text-end" type="number" step="1" min="1" data-idx="${idx}" data-k="qty" value="${it.qty}"></td>
        <td class="text-end"><input class="form-control form-control-sm text-end" type="text" inputmode="decimal" data-idx="${idx}" data-k="unitPrice" value="${(it.unitPriceRaw ?? formatPriceInput(it.unitPrice))}"></td>
        <td class="text-end">${money(subtotal)}</td>
        <td class="text-end"><button class="btn btn-outline-danger btn-sm" data-act="rm-quote" data-idx="${idx}">✕</button></td>
      </tr>
    `;
  }).join("");

  updateQuoteTotal();
}

function updateQuoteTotal() {
  const total = state.quote.items.reduce((acc,it)=> acc + safeNum(it.qty)*safeNum(it.unitPrice), 0);
  document.getElementById("quoteTotal").textContent = money(total);
  saveToLocalStorage();
}



document.getElementById("quoteTbody").addEventListener("input", (e)=>{
  const inp = e.target.closest("input[data-idx]");
  if (!inp) return;
  const idx = Number(inp.dataset.idx);
  const k = inp.dataset.k;
  if (!state.quote.items[idx]) return;

  if (k === "qty") {
    state.quote.items[idx].qty = Math.max(1, Number(inp.value || 1));
    // Si el usuario NO ha editado precio manualmente, aplicamos regla mayorista
    if (!state.quote.items[idx].manualPrice) {
      const prod = state.products.find(p=>p.codigo===state.quote.items[idx].codigo);
      if (prod) state.quote.items[idx].unitPrice = calcUnitPrice(prod, state.quote.items[idx].qty);
    }
    renderQuote();
    return;
  }

  if (k === "unitPrice") {
    // Guardamos el texto mientras escribe, sin recalcular ni re-renderizar
    state.quote.items[idx].unitPriceRaw = inp.value;
    state.quote.items[idx].manualPrice = true;
    saveToLocalStorage();
    return;
  }
});



document.getElementById("view-cotizacion").addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "rm-quote") {
    const idx = Number(btn.dataset.idx);
    state.quote.items.splice(idx,1);
    renderQuote();
    toast("Item eliminado", "warning");
  }
});

function calcUnitPrice(prod, qty) {
  const q = safeNum(qty);
  const mayorDesde = prod.cant_mayor != null ? safeNum(prod.cant_mayor) : null;
  if (mayorDesde != null && prod.precio_cm != null && q >= mayorDesde && safeNum(prod.precio_cm) > 0) return safeNum(prod.precio_cm);
  if (prod.precio_und != null) return safeNum(prod.precio_und);
  return 0;
}

function addProductToQuote(prod, qty=1) {
  const existing = state.quote.items.find(it => it.codigo === prod.codigo);
  if (existing) {
    existing.qty += qty;
    existing.unitPrice = calcUnitPrice(prod, existing.qty);
  } else {
    state.quote.items.push({
      codigo: prod.codigo,
      descripcion: prod.descripcion || "",
      qty,
      unitPrice: calcUnitPrice(prod, qty),
      manualPrice: false,
      unitPriceRaw: null
    });
  }
  renderQuote();
  toast("Agregado a la cotización", "success");
}

function autoQuoteNumber() {
  // no hay correlativo global (sin backend). Generamos uno con fecha + 4 dígitos.
  const d = new Date();
  const pad = (n)=> String(n).padStart(2,"0");
  const base = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const rnd = String(Math.floor(Math.random()*9000)+1000);
  return `COT-${base}-${rnd}`;
}

document.getElementById("quoteNumber").addEventListener("input", (e)=>{ state.quote.number = e.target.value.trim(); saveToLocalStorage(); });
document.getElementById("quoteDate").addEventListener("input", (e)=>{ state.quote.date = e.target.value; saveToLocalStorage(); });
document.getElementById("quoteNotes").addEventListener("input", (e)=>{ state.quote.notes = e.target.value; saveToLocalStorage(); });

document.getElementById("btnClearQuote").addEventListener("click", ()=>{
  if (!confirm("¿Limpiar la cotización actual?")) return;
  state.quote.items = [];
  renderQuote();
});

document.getElementById("quoteProductSearch").addEventListener("keydown", (e)=>{
  if (e.key !== "Enter") return;
  e.preventDefault();
  const q = e.target.value.trim().toUpperCase();
  if (!q) return;
  const prod = state.products.find(p => (p.codigo||"").toUpperCase().includes(q) || (p.descripcion||"").toUpperCase().includes(q));
  if (!prod) return toast("No se encontró producto", "warning");
  addProductToQuote(prod, 1);
  e.target.value = "";
});

document.getElementById("quoteClientSearch").addEventListener("keydown", (e)=>{
  if (e.key !== "Enter") return;
  e.preventDefault();
  const q = e.target.value.trim().toUpperCase();
  if (!q) return;
  const cli = state.clients.find(c => (c.codigo||"").toUpperCase().includes(q) || (c.cliente||"").toUpperCase().includes(q) || (c.dni||"").toUpperCase().includes(q));
  if (!cli) return toast("No se encontró cliente", "warning");
  state.quote.clientCode = cli.codigo;
  renderQuote();
  toast("Cliente seleccionado", "success");
  e.target.value = "";
});


function commitQuoteUnitPrice(idx, raw) {
  const v = evalExprToNumber(raw);
  if (!Number.isFinite(v)) {
    toast("Expresión inválida en precio unitario", "warning");
    return false;
  }
  state.quote.items[idx].unitPrice = to2(v);
  state.quote.items[idx].unitPriceRaw = null;
  state.quote.items[idx].manualPrice = true;
  saveToLocalStorage();
  return true;
}

// Confirmar precio unitario al DESELECCIONAR (click afuera / TAB)
document.getElementById("quoteTbody").addEventListener("focusout", (e)=>{
  const inp = e.target.closest('input[data-idx][data-k="unitPrice"]');
  if (!inp) return;
  const idx = Number(inp.dataset.idx);
  if (!state.quote.items[idx]) return;
  const ok = commitQuoteUnitPrice(idx, inp.value);
  if (ok) renderQuote();
}, true);

/* ---------------- Export Quotation: PDF / Excel ---------------- */



document.getElementById("btnExportQuotePdf").addEventListener("click", async ()=>{
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const client = state.clients.find(c=>c.codigo===state.quote.clientCode) || null;
  const number = document.getElementById("quoteNumber").value.trim() || autoQuoteNumber();
  const date = document.getElementById("quoteDate").value || todayISO();
  const notes = document.getElementById("quoteNotes").value || "";

  const pageW = doc.internal.pageSize.getWidth();

  // --------- Logo centrado con borde (como ejemplo) ----------
  const logoW = 90;
  const logoH = 40;
  const logoX = (pageW - logoW) / 2;
  const logoY = 18;

  try {
    const logoDataUrl = await fetch("assets/logo.jpg")
      .then(r=>r.blob())
      .then(blob => new Promise((resolve)=>{
        const fr = new FileReader();
        fr.onload = ()=> resolve(fr.result);
        fr.readAsDataURL(blob);
      }));
    doc.addImage(logoDataUrl, "JPEG", logoX, logoY, logoW, logoH);
    // borde
    doc.setDrawColor(0);
    doc.setLineWidth(0.6);
    doc.rect(logoX, logoY, logoW, logoH);
  } catch (e) {
    // fallback sin logo
    doc.setFontSize(16);
    doc.text("D'Kolor", pageW/2, logoY+18, { align: "center" });
  }

  // --------- Cajas superiores ----------
  const boxY = logoY + logoH + 12;

  // Left box: N° ITEMS
  const items = state.quote.items.length;
  const lX = 14, lW = 95, rowH = 7;
  doc.setFontSize(9);
  doc.setLineWidth(0.2);
  doc.rect(lX, boxY, lW, rowH);
  doc.line(lX + 30, boxY, lX + 30, boxY + rowH);
  doc.text("N° ITEMS", lX + 2, boxY + 5.1);
  doc.text(String(items), lX + lW - 2, boxY + 5.1, { align: "right" });

  // Right box: CODIGO / COD.CLIENTE / DNI / FECHA
  const rW = 70;
  const rX = pageW - 14 - rW;
  const rY = boxY - 3; // un poco más arriba, como el ejemplo
  const rRowH = 7;

  const rowsInfo = [
    ["CÓDIGO", number],
    ["COD.CLIENTE", client?.codigo || "—"],
    ["DNI", client?.dni || "—"],
    ["FECHA", date]
  ];
  doc.rect(rX, rY, rW, rRowH * rowsInfo.length);
  // líneas horizontales
  for (let i=1;i<rowsInfo.length;i++){
    doc.line(rX, rY + rRowH*i, rX + rW, rY + rRowH*i);
  }
  // línea vertical separadora
  const split = rX + 28;
  doc.line(split, rY, split, rY + rRowH*rowsInfo.length);

  rowsInfo.forEach((rr, i)=>{
    const yy = rY + rRowH*i + 5.1;
    doc.text(rr[0], rX + 2, yy);
    doc.text(String(rr[1] ?? ""), rX + rW - 2, yy, { align: "right" });
  });

  // Cliente / Dirección box (2 filas)
  const cY = boxY + 10;
  const cW = 140;
  doc.rect(lX, cY, cW, rRowH*2);
  doc.line(lX, cY + rRowH, lX + cW, cY + rRowH);
  doc.line(lX + 25, cY, lX + 25, cY + rRowH*2);

  doc.text("CLIENTE", lX + 2, cY + 5.1);
  doc.text(client?.cliente || "—", lX + 27, cY + 5.1);

  doc.text("DIRECCIÓN", lX + 2, cY + rRowH + 5.1);
  doc.text(client?.direccion || "—", lX + 27, cY + rRowH + 5.1);

  // --------- Tabla principal ----------
  const tableStartY = cY + rRowH*2 + 10;

  const bodyRows = state.quote.items.map((it)=>[
    it.codigo,
    it.descripcion,
    String(it.qty),
    safeNum(it.unitPrice).toFixed(2),
    (safeNum(it.qty)*safeNum(it.unitPrice)).toFixed(2)
  ]);

  const total = state.quote.items.reduce((acc,it)=> acc + safeNum(it.qty)*safeNum(it.unitPrice), 0);

  doc.autoTable({
    startY: tableStartY,
    head: [["CÓDIGO","DESCRIPCIÓN","CANT.","PRECIO (S/)","PARCIAL (S/)"]],
    body: bodyRows,
    foot: [["", "", "", "TOTAL (S/)", total.toFixed(2)]],
    styles: { fontSize: 8, lineColor: 120, lineWidth: 0.2 },
    headStyles: { fillColor: [0,0,0], textColor: 255, halign: "center" },
    footStyles: { fillColor: [255,255,255], textColor: 0, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [235,235,235] },
    columnStyles: {
      2: { halign: "right", cellWidth: 16 },
      3: { halign: "right", cellWidth: 22 },
      4: { halign: "right", cellWidth: 24 },
      0: { cellWidth: 26 },
      1: { cellWidth: 78 }
    },
    theme: "grid"
  });

  // Observaciones (opcional)
  const y = doc.lastAutoTable.finalY + 8;
  if (notes.trim()) {
    doc.setFontSize(9);
    doc.text("Observaciones:", 14, y);
    doc.setFontSize(8);
    doc.text(doc.splitTextToSize(notes, 180), 14, y+5);
  }

  doc.save(`${number}.pdf`);
});




document.getElementById("btnExportQuoteXlsx").addEventListener("click", ()=>{
  const wb = XLSX.utils.book_new();
  const number = (document.getElementById("quoteNumber").value.trim() || autoQuoteNumber());
  const date = (document.getElementById("quoteDate").value || todayISO());
  const client = state.clients.find(c=>c.codigo===state.quote.clientCode) || null;

  const header = [
    ["D'Kolor - Cotización de útiles escolares"],
    [`N°: ${number}`, `Fecha: ${date}`],
    [`Cliente:`, client ? `${client.codigo} - ${client.cliente}` : "—"],
    []
  ];

  const rows = state.quote.items.map(it=>({
    "Código": it.codigo,
    "Producto": it.descripcion,
    "Cantidad": it.qty,
    "Precio Unit (S/)": safeNum(it.unitPrice),
    "Subtotal (S/)": safeNum(it.qty)*safeNum(it.unitPrice)
  }));

  const ws1 = XLSX.utils.aoa_to_sheet(header);
  XLSX.utils.sheet_add_json(ws1, rows, { origin: "A5" });

  // Totales
  const total = rows.reduce((acc,r)=> acc + safeNum(r["Subtotal (S/)"]), 0);
  XLSX.utils.sheet_add_aoa(ws1, [["", "", "", "TOTAL", total]], { origin: `A${5+rows.length+1}` });

  XLSX.utils.book_append_sheet(wb, ws1, "Cotizacion");
  XLSX.writeFile(wb, `${number}.xlsx`);
});

/* ---------------- Import/Export Excel (Productos/Clientes) ---------------- */
document.getElementById("btnExportProductsXlsx").addEventListener("click", ()=>{
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(state.products.map(p=>({
    "CÓDIGO": p.codigo,
    "DESCRIPCIÓN": p.descripcion,
    "COSTO (S/)": p.costo,
    "PRECIO_UND (S/)": p.precio_und,
    "STOCK": p.stock,
    "PRECIO_DOC (S/)": p.precio_doc,
    "CANT.MAYOR": p.cant_mayor,
    "PRECIO_CM (S/)": p.precio_cm,
    "PROVEEDOR": p.proveedor,
    "NOTAS": p.notas
  })));
  XLSX.utils.book_append_sheet(wb, ws, "Productos");
  XLSX.writeFile(wb, "Productos_export.xlsx");
});

document.getElementById("btnExportClientsXlsx").addEventListener("click", ()=>{
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(state.clients.map(c=>({
    "Código": c.codigo,
    "Cliente": c.cliente,
    "DNI": c.dni,
    "Teléfono": c.telefono,
    "Celular": c.celular,
    "Dirección": c.direccion,
    "Observaciones": c.observaciones,
    "Tipo": c.tipo
  })));
  XLSX.utils.book_append_sheet(wb, ws, "Clientes");
  XLSX.writeFile(wb, "Clientes_export.xlsx");
});

document.getElementById("btnImportExcel").addEventListener("click", async ()=>{
  const input = document.getElementById("excelFile");
  const status = document.getElementById("importStatus");
  if (!input.files?.[0]) return toast("Selecciona un archivo Excel primero", "warning");
  const file = input.files[0];
  status.textContent = "Leyendo archivo…";
  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: "array" });

    // Productos
    const prodSheet = wb.Sheets["Productos"];
    const cliSheet  = wb.Sheets["Clientes"];
    if (!prodSheet || !cliSheet) {
      status.textContent = "No se encontraron las hojas 'Productos' y/o 'Clientes'.";
      return toast("Excel no compatible (faltan hojas)", "danger");
    }

    const prodRaw = XLSX.utils.sheet_to_json(prodSheet, { header: 1, blankrows: false });
    const cliRaw  = XLSX.utils.sheet_to_json(cliSheet,  { header: 1, blankrows: false });

    const prod = parseProductosFromAOA(prodRaw);
    const cli  = parseClientesFromAOA(cliRaw);

    if (prod.length) state.products = prod;
    if (cli.length) state.clients = cli;

    saveToLocalStorage();
    status.textContent = `Importado: ${prod.length} productos, ${cli.length} clientes.`;
    toast("Importación completada", "success");
    renderDashboard();
  } catch (err) {
    console.error(err);
    status.textContent = "Error importando. Revisa consola.";
    toast("Error importando Excel", "danger");
  }
});

document.getElementById("btnLoadInitial").addEventListener("click", async ()=>{
  await loadInitialJSON();
  toast("Datos iniciales cargados", "success");
  renderDashboard();
});

/* ---------------- Backup / Reset ---------------- */
document.getElementById("btnBackup").addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify({products:state.products, clients:state.clients}, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "dkolor_respaldo.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("btnReset").addEventListener("click", async ()=>{
  if (!confirm("¿Restaurar datos iniciales? Se perderán cambios locales.")) return;
  localStorage.removeItem(LS_KEY);
  await boot();
  toast("Restaurado", "warning");
});

/* ---------------- Helpers ---------------- */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function nextCode(codes, prefix, padLen) {
  // ej: prefix="PROD_", padLen=4 => PROD_0001
  const nums = codes
    .map(x=>String(x||""))
    .filter(x=>x.startsWith(prefix))
    .map(x=>x.slice(prefix.length))
    .map(x=>parseInt(x,10))
    .filter(n=>Number.isFinite(n));
  const next = (nums.length ? Math.max(...nums)+1 : 1);
  return prefix + String(next).padStart(padLen, "0");
}

/* Import parsing from Excel (AOA) */
function findHeaderRowAOA(aoa, keywords) {
  const K = keywords.map(k=>String(k).toUpperCase());
  for (let r=0; r<Math.min(aoa.length, 120); r++) {
    const row = aoa[r].map(v=>String(v ?? "").trim().toUpperCase());
    const ok = K.every(k => row.some(cell => cell.includes(k)));
    if (ok) return r;
  }
  return -1;
}

function parseProductosFromAOA(aoa) {
  const hr = findHeaderRowAOA(aoa, ["CÓDIGO","DESCRIPCIÓN","STOCK"]);
  if (hr<0) return [];
  const header = aoa[hr].map(v=>String(v ?? "").trim());
  const firstCol = header.findIndex(h=>h!=="");
  const cols = header.slice(firstCol).filter(h=>h!=="");
  const out = [];
  for (let r=hr+1; r<aoa.length; r++) {
    const row = aoa[r].slice(firstCol, firstCol+cols.length);
    const code = String(row[0] ?? "").trim();
    if (!code) break;
    const get = (name)=> row[cols.indexOf(name)];
    out.push({
      codigo: code,
      descripcion: String(get("DESCRIPCIÓN") ?? "").trim(),
      costo: numOrNull(get("COSTO (S/)")),
      precio_und: numOrNull(get("PRECIO_UND (S/)")),
      stock: numOrNull(get("STOCK")),
      precio_doc: numOrNull(get("PRECIO_DOC (S/)")),
      cant_mayor: numOrNull(get("CANT.MAYOR")),
      precio_cm: numOrNull(get("PRECIO_CM (S/)")),
      proveedor: String(get("PROVEEDOR") ?? "").trim(),
      notas: String(get("NOTAS") ?? "").trim()
    });
  }
  return out;
}

function parseClientesFromAOA(aoa) {
  const hr = findHeaderRowAOA(aoa, ["Código","Cliente","DNI"]);
  if (hr<0) return [];
  const header = aoa[hr].map(v=>String(v ?? "").trim());
  const firstCol = header.findIndex(h=>h!=="");
  const cols = header.slice(firstCol).filter(h=>h!=="");
  const out = [];
  for (let r=hr+1; r<aoa.length; r++) {
    const row = aoa[r].slice(firstCol, firstCol+cols.length);
    const code = String(row[0] ?? "").trim();
    if (!code) break;
    const get = (name)=> row[cols.indexOf(name)];
    out.push({
      codigo: code,
      cliente: String(get("Cliente") ?? "").trim(),
      dni: String(get("DNI") ?? "").trim(),
      telefono: String(get("Teléfono") ?? "").trim(),
      celular: String(get("Celular") ?? "").trim(),
      direccion: String(get("Dirección") ?? "").trim(),
      observaciones: String(get("Observaciones") ?? "").trim(),
      tipo: String(get("Tipo") ?? "").trim()
    });
  }
  return out;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- Boot ---------------- */
async function boot() {
  const ok = loadFromLocalStorage();
  if (!ok) {
    await loadInitialJSON();
  }
  // default quote fields
  if (!state.quote.date) state.quote.date = todayISO();
  if (!state.quote.number) state.quote.number = autoQuoteNumber();

  // nav events
  document.querySelectorAll(".nav-link[data-view]").forEach(a=>{
    a.addEventListener("click",(e)=>{ e.preventDefault(); setActiveView(a.dataset.view); });
  });
  document.querySelectorAll("[data-nav]").forEach(b=>{
    b.addEventListener("click", ()=> setActiveView(b.dataset.nav));
  });

  setActiveView("dashboard");
  renderDashboard();
}

boot();
