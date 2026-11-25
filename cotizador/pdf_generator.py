"""Generador de reportes de cotización editables en PDF (AcroForm) con identidad D'Kolor."""

from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from cotizador.models import QuoteReport


def _safe_pdf_text(text: str) -> str:
    """Convierte texto a caracteres compatibles con AcroForm WinAnsi/Latin-1."""
    cleaned = (
        text.replace("—", "-")
        .replace("–", "-")
        .replace("•", "*")
        .replace("“", '"')
        .replace("”", '"')
        .replace("’", "'")
    )
    return cleaned.encode("latin-1", errors="replace").decode("latin-1")


def _textfield(
    c: canvas.Canvas,
    name: str,
    value: str,
    x: float,
    y: float,
    w: float,
    h: float,
    font_size: int = 8,
    fill_color: colors.Color = colors.white,
    border_color: colors.Color = colors.HexColor("#CCCCCC"),
    text_color: colors.Color = colors.black,
) -> None:
    """Crea un campo de texto AcroForm editable en el PDF."""
    c.acroForm.textfield(
        name=name,
        tooltip=name,
        value=_safe_pdf_text(value),
        x=x,
        y=y,
        width=w,
        height=h,
        borderStyle="solid",
        borderWidth=0.5,
        borderColor=border_color,
        fillColor=fill_color,
        textColor=text_color,
        fontName="Helvetica",
        fontSize=font_size,
        forceBorder=True,
    )


def _draw_header(
    c: canvas.Canvas,
    report: QuoteReport,
    logo_path: Path,
    page_w: float,
    page_h: float,
) -> float:
    """Dibuja el encabezado con logo D'Kolor y cajas editables de cliente/cotización."""
    y_top = page_h - 30

    # Logo centrado (proporción similar a assets/app.js)
    logo_w, logo_h = 210, 82
    logo_x = (page_w - logo_w) / 2
    logo_y = y_top - logo_h
    if logo_path.exists():
        try:
            c.drawImage(str(logo_path), logo_x, logo_y, width=logo_w, height=logo_h, preserveAspectRatio=True)
            c.setStrokeColor(colors.black)
            c.setLineWidth(1.0)
            c.rect(logo_x, logo_y, logo_w, logo_h)
        except Exception:
            c.setFont("Helvetica-Bold", 16)
            c.drawCentredString(page_w / 2, logo_y + 35, "D'Kolor - Librería y Bazar")
    else:
        c.setFont("Helvetica-Bold", 16)
        c.drawCentredString(page_w / 2, logo_y + 35, "D'Kolor - Librería y Bazar")

    margin_x = 34
    box_y = logo_y - 24
    row_h = 18

    # Caja izquierda: N° ITEMS + CLIENTE + DIRECCIÓN (campos editables)
    left_w = 310
    c.setFont("Helvetica-Bold", 8)
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.6)

    # Fila N° ITEMS
    c.rect(margin_x, box_y, left_w, row_h)
    c.drawString(margin_x + 4, box_y + 5, "N° ITEMS")
    _textfield(
        c,
        "num_items",
        str(len(report.lines)),
        margin_x + 75,
        box_y + 2,
        left_w - 79,
        row_h - 4,
        font_size=8,
    )

    # Caja Cliente / Dirección
    cli_y = box_y - 44
    c.rect(margin_x, cli_y, left_w, row_h * 2)
    c.line(margin_x, cli_y + row_h, margin_x + left_w, cli_y + row_h)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(margin_x + 4, cli_y + row_h + 5, "CLIENTE")
    c.drawString(margin_x + 4, cli_y + 5, "DIRECCIÓN")

    _textfield(
        c,
        "cliente_nombre",
        report.client.cliente if report.client else "PÚBLICO GENERAL",
        margin_x + 75,
        cli_y + row_h + 2,
        left_w - 79,
        row_h - 4,
        font_size=8,
    )
    _textfield(
        c,
        "cliente_direccion",
        report.client.direccion if report.client else "",
        margin_x + 75,
        cli_y + 2,
        left_w - 79,
        row_h - 4,
        font_size=8,
    )

    # Caja derecha: CÓDIGO / COD.CLIENTE / DNI / FECHA
    right_w = 205
    right_x = page_w - margin_x - right_w
    right_top = box_y + 18
    info_rows = [
        ("CÓDIGO", "quote_number", report.quote_number),
        ("COD.CLIENTE", "client_code", report.client.codigo if report.client else "—"),
        ("DNI", "client_dni", report.client.dni if report.client else "—"),
        ("FECHA", "quote_date", report.date),
    ]
    c.rect(right_x, right_top - row_h * 4, right_w, row_h * 4)
    for i, (label, field_name, val) in enumerate(info_rows):
        ry = right_top - row_h * (i + 1)
        if i > 0:
            c.line(right_x, ry + row_h, right_x + right_w, ry + row_h)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(right_x + 4, ry + 5, label)
        _textfield(
            c,
            field_name,
            val,
            right_x + 68,
            ry + 2,
            right_w - 72,
            row_h - 4,
            font_size=8,
        )

    return min(cli_y, right_top - row_h * 4) - 18


def _draw_table_header(c: canvas.Canvas, x: float, y: float) -> float:
    """Dibuja la cabecera negra de la tabla de cotización."""
    cols = [
        ("CÓDIGO", 58),
        ("DESCRIPCIÓN (EDITABLE)", 230),
        ("CANT.", 42),
        ("PRECIO (S/)", 62),
        ("PARCIAL (S/)", 65),
        ("ESTADO", 70),
    ]
    total_w = sum(w for _, w in cols)
    h = 18
    c.setFillColor(colors.black)
    c.rect(x, y - h, total_w, h, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 7.5)
    cur_x = x
    for title, w in cols:
        c.drawCentredString(cur_x + w / 2, y - h + 5, title)
        cur_x += w
    c.setFillColor(colors.black)
    return y - h


def generate_editable_pdf(
    report: QuoteReport,
    output_path: str | Path,
    logo_path: str | Path = "assets/logo.jpg",
    extra_blank_rows: int = 2,
) -> Path:
    """Genera un PDF editable (AcroForm) con la cotización completa y sección de revisión."""
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    logo = Path(logo_path)

    page_w, page_h = A4
    c = canvas.Canvas(str(out), pagesize=A4)
    c.setTitle(f"Cotización {report.quote_number} - D'Kolor")
    c.setAuthor("Sistema de Cotización D'Kolor")

    margin_x = 34
    y = _draw_header(c, report, logo, page_w, page_h)
    y = _draw_table_header(c, margin_x, y)

    row_h = 20
    col_widths = [58, 230, 42, 62, 65, 70]
    total_w = sum(col_widths)

    def ensure_space(needed_h: float) -> None:
        nonlocal y
        if y - needed_h < 70:
            c.showPage()
            y = page_h - 40
            y = _draw_table_header(c, margin_x, y)

    # Filas de productos cotizados
    for idx, line in enumerate(report.lines):
        ensure_space(row_h)
        ry = y - row_h
        c.setStrokeColor(colors.HexColor("#999999"))
        c.setLineWidth(0.4)
        c.rect(margin_x, ry, total_w, row_h)

        cx = margin_x
        c.setFont("Helvetica", 7.5)
        c.drawString(cx + 3, ry + 6, line.codigo[:11])
        cx += col_widths[0]

        _textfield(
            c,
            f"item_desc_{idx}",
            line.descripcion,
            cx + 2,
            ry + 2,
            col_widths[1] - 4,
            row_h - 4,
            font_size=7.5,
        )
        cx += col_widths[1]

        qty_str = str(int(line.quantity)) if line.quantity.is_integer() else f"{line.quantity:.2f}"
        _textfield(
            c,
            f"item_qty_{idx}",
            qty_str,
            cx + 2,
            ry + 2,
            col_widths[2] - 4,
            row_h - 4,
            font_size=8,
        )
        cx += col_widths[2]

        _textfield(
            c,
            f"item_price_{idx}",
            f"{line.unit_price:.2f}",
            cx + 2,
            ry + 2,
            col_widths[3] - 4,
            row_h - 4,
            font_size=8,
        )
        cx += col_widths[3]

        _textfield(
            c,
            f"item_sub_{idx}",
            f"{line.subtotal:.2f}",
            cx + 2,
            ry + 2,
            col_widths[4] - 4,
            row_h - 4,
            font_size=8,
        )
        cx += col_widths[4]

        status_bg = colors.HexColor("#E8F5E9") if line.match_status == "EXACTO" else colors.HexColor("#FFF8E1")
        _textfield(
            c,
            f"item_status_{idx}",
            line.match_status,
            cx + 2,
            ry + 2,
            col_widths[5] - 4,
            row_h - 4,
            font_size=7,
            fill_color=status_bg,
        )
        y = ry

    # Filas en blanco editables para ajustes rápidos del vendedor
    for b_idx in range(extra_blank_rows):
        ensure_space(row_h)
        ry = y - row_h
        c.setStrokeColor(colors.HexColor("#CCCCCC"))
        c.rect(margin_x, ry, total_w, row_h)
        cx = margin_x
        _textfield(c, f"extra_code_{b_idx}", "", cx + 2, ry + 2, col_widths[0] - 4, row_h - 4, 7.5)
        cx += col_widths[0]
        _textfield(c, f"extra_desc_{b_idx}", "", cx + 2, ry + 2, col_widths[1] - 4, row_h - 4, 7.5)
        cx += col_widths[1]
        _textfield(c, f"extra_qty_{b_idx}", "", cx + 2, ry + 2, col_widths[2] - 4, row_h - 4, 8)
        cx += col_widths[2]
        _textfield(c, f"extra_price_{b_idx}", "", cx + 2, ry + 2, col_widths[3] - 4, row_h - 4, 8)
        cx += col_widths[3]
        _textfield(c, f"extra_sub_{b_idx}", "", cx + 2, ry + 2, col_widths[4] - 4, row_h - 4, 8)
        cx += col_widths[4]
        _textfield(c, f"extra_status_{b_idx}", "MANUAL", cx + 2, ry + 2, col_widths[5] - 4, row_h - 4, 7)
        y = ry

    # Totales editables
    ensure_space(80)
    y -= 10
    totals_x = margin_x + col_widths[0] + col_widths[1] + col_widths[2]
    label_w = col_widths[3] + 20
    val_w = col_widths[4] + col_widths[5] - 20

    summary_rows = [
        ("SUBTOTAL", "quote_subtotal", f"{report.subtotal:.2f}"),
        ("DESCUENTO", "quote_discount", f"{report.discount_amount:.2f}"),
        ("IGV", "quote_igv", f"{report.igv_amount:.2f}"),
        (f"TOTAL ({report.currency})", "quote_total", f"{report.total:.2f}"),
    ]
    for lbl, fname, val in summary_rows:
        y -= 18
        is_total = fname == "quote_total"
        c.setFont("Helvetica-Bold" if is_total else "Helvetica", 8.5 if is_total else 8)
        c.drawRightString(totals_x + label_w - 4, y + 5, lbl)
        _textfield(
            c,
            fname,
            val,
            totals_x + label_w,
            y + 1,
            val_w,
            16,
            font_size=8.5 if is_total else 8,
            fill_color=colors.HexColor("#F1F8E9") if is_total else colors.white,
        )

    # Sección de ítems ilegibles o no encontrados (para revisión manual editable)
    if report.illegible_or_unmatched:
        ensure_space(60)
        y -= 24
        c.setFont("Helvetica-Bold", 9)
        c.setFillColor(colors.HexColor("#B71C1C"))
        c.drawString(
            margin_x,
            y,
            "ÍTEMS ILEGIBLES O SIN COINCIDENCIA (EDITAR MANUALMENTE):",
        )
        c.setFillColor(colors.black)
        y -= 6

        for r_idx, bad in enumerate(report.illegible_or_unmatched):
            ensure_space(row_h)
            ry = y - row_h
            c.setStrokeColor(colors.HexColor("#EF9A9A"))
            c.rect(margin_x, ry, total_w, row_h)
            _textfield(
                c,
                f"rev_raw_{r_idx}",
                f"L{bad.line_number}: {bad.raw_text}",
                margin_x + 2,
                ry + 2,
                220,
                row_h - 4,
                font_size=7.5,
                fill_color=colors.HexColor("#FFEBEE"),
            )
            _textfield(
                c,
                f"rev_reason_{r_idx}",
                bad.reason,
                margin_x + 224,
                ry + 2,
                160,
                row_h - 4,
                font_size=7,
                fill_color=colors.HexColor("#FFF3E0"),
            )
            _textfield(
                c,
                f"rev_qty_{r_idx}",
                "",
                margin_x + 386,
                ry + 2,
                40,
                row_h - 4,
                font_size=7.5,
            )
            _textfield(
                c,
                f"rev_price_{r_idx}",
                "",
                margin_x + 428,
                ry + 2,
                96,
                row_h - 4,
                font_size=7.5,
            )
            y = ry

    # Notas editables
    ensure_space(55)
    y -= 20
    c.setFont("Helvetica-Bold", 8)
    c.drawString(margin_x, y, "NOTAS / OBSERVACIONES:")
    _textfield(
        c,
        "quote_notes",
        " | ".join(report.warnings) if report.warnings else "Cotización generada automáticamente. Precios editables.",
        margin_x,
        y - 26,
        total_w,
        22,
        font_size=7.5,
    )

    c.save()
    return out
