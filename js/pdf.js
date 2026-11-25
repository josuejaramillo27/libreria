/**
 * js/pdf.js
 * Exportación de cotización escolar a PDF profesional mediante jsPDF y jsPDF-AutoTable.
 */

const STATUS_LABELS = {
  exacto: "Exacto",
  sinonimo: "Sinónimo",
  equivalencia: "Equivalencia",
  sin_coincidencia: "Sin coincidencia",
  ilegible: "Ilegible",
  manual: "Manual",
};

/**
 * Intenta cargar el logo de la librería como DataURL si está disponible.
 */
async function loadLogoDataUrl(url = "assets/logo.jpg") {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Genera y descarga el PDF profesional de la cotización actual.
 */
export async function exportQuoteToPDF({
  quoteNumber,
  date,
  clientName,
  discountPct,
  rows,
  subtotal,
  discountAmount,
  total,
}) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("La librería jsPDF no se cargó. Verifica tu conexión a internet.");
  }
  if (!rows.length) {
    throw new Error("No hay ítems en la cotización para exportar.");
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();

  // Encabezado limpio
  const logoData = await loadLogoDataUrl();
  if (logoData) {
    doc.addImage(logoData, "JPEG", 14, 12, 42, 19);
  }

  const textStartX = logoData ? 62 : 14;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(17, 24, 39);
  doc.text("D'KOLOR • LIBRERÍA Y BAZAR", textStartX, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(75, 85, 99);
  doc.text("Cotización de Lista de Útiles Escolares", textStartX, 24);
  doc.text("Precios expresados en Soles (S/)", textStartX, 29);

  // Caja derecha con N° Cotización y Fecha
  doc.setDrawColor(209, 213, 219);
  doc.setFillColor(249, 250, 251);
  doc.roundedRect(pageW - 68, 12, 54, 19, 2, 2, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(17, 24, 39);
  doc.text(quoteNumber || "COT-001", pageW - 41, 19, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(75, 85, 99);
  doc.text(`Fecha: ${date || "-"}`, pageW - 41, 26, { align: "center" });

  // Datos del cliente
  doc.setDrawColor(229, 231, 235);
  doc.line(14, 36, pageW - 14, 36);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(17, 24, 39);
  doc.text("CLIENTE:", 14, 43);
  doc.setFont("helvetica", "normal");
  doc.text(clientName?.trim() || "Público General", 34, 43);
  doc.text(`Ítems cotizados: ${rows.length}`, pageW - 14, 43, { align: "right" });

  // Tabla principal
  const body = rows.map((r, idx) => [
    String(idx + 1),
    r.producto || "-",
    r.unidad || "unidad",
    Number(r.cantidad || 0).toString(),
    Number(r.precioUnitario || 0).toFixed(2),
    (Number(r.cantidad || 0) * Number(r.precioUnitario || 0)).toFixed(2),
    STATUS_LABELS[r.status] || r.status || "-",
  ]);

  doc.autoTable({
    startY: 48,
    head: [["#", "Artículo / Descripción", "Presentación", "Cant.", "P. Unit (S/)", "Subtotal (S/)", "Obs."]],
    body,
    theme: "grid",
    styles: {
      fontSize: 8.5,
      cellPadding: 2.5,
      textColor: [31, 41, 55],
      lineColor: [229, 231, 235],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [17, 24, 39],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      halign: "center",
    },
    columnStyles: {
      0: { halign: "center", cellWidth: 9 },
      1: { cellWidth: 68 },
      2: { cellWidth: 26 },
      3: { halign: "right", cellWidth: 14 },
      4: { halign: "right", cellWidth: 22 },
      5: { halign: "right", cellWidth: 23, fontStyle: "bold" },
      6: { halign: "center", cellWidth: 20, fontSize: 7.5 },
    },
  });

  // Resumen de totales
  const finalY = (doc.lastAutoTable?.finalY || 120) + 8;
  const summaryX = pageW - 76;

  doc.setFontSize(9.5);
  doc.setTextColor(75, 85, 99);
  doc.text("Subtotal:", summaryX, finalY);
  doc.text(`S/ ${subtotal.toFixed(2)}`, pageW - 14, finalY, { align: "right" });

  doc.text(`Descuento (${Number(discountPct || 0)}%):`, summaryX, finalY + 6);
  doc.text(`- S/ ${discountAmount.toFixed(2)}`, pageW - 14, finalY + 6, { align: "right" });

  doc.setFillColor(17, 24, 39);
  doc.roundedRect(summaryX - 4, finalY + 10, 66, 10, 1.5, 1.5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text("TOTAL:", summaryX, finalY + 16.8);
  doc.text(`S/ ${total.toFixed(2)}`, pageW - 16, finalY + 16.8, { align: "right" });

  // Pie de página
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(156, 163, 175);
    doc.text(
      `Cotización referencial válida por 7 días • Página ${i} de ${pageCount}`,
      pageW / 2,
      doc.internal.pageSize.getHeight() - 8,
      { align: "center" }
    );
  }

  const safeNum = (quoteNumber || "cotizacion").replace(/[^a-z0-9_-]/gi, "_");
  doc.save(`${safeNum}.pdf`);
}
