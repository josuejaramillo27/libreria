"""Pruebas unitarias y de integración del sistema de cotización D'Kolor."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader
from reportlab.pdfgen import canvas

from cotizador.config import ConfigManager
from cotizador.exceptions import IllegibleDocumentError, UnsupportedFormatError
from cotizador.pipeline import QuotationService


@pytest.fixture
def temp_env(tmp_path: Path) -> dict[str, Path]:
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir()
    shutil.copy("config/rules.json", cfg_dir / "rules.json")
    return {
        "config": cfg_dir / "rules.json",
        "products": Path("data/products.json"),
        "clients": Path("data/clients.json"),
        "logo": Path("assets/logo.jpg"),
        "out_pdf": tmp_path / "cotizacion_editable.pdf",
        "out_json": tmp_path / "cotizacion.json",
    }


def test_synonym_matching_and_pricing_tiers(temp_env: dict[str, Path]) -> None:
    svc = QuotationService(
        config_path=temp_env["config"],
        products_path=temp_env["products"],
        clients_path=temp_env["clients"],
        logo_path=temp_env["logo"],
    )
    lista = """
    LISTA DE UTILES ESCOLARES
    1. 2 lapiceros faber castell 0.35
    2. 1 goma artesco 250g
    3. 3 cuadernos a4 conti cuadriculado
    4. @@@ ### ??? texto ilegible
    """
    report = svc.quote_from_text(
        lista,
        output_pdf=temp_env["out_pdf"],
        client_id="C_000001",
        output_json=temp_env["out_json"],
    )

    assert len(report.lines) == 3
    assert len(report.illegible_or_unmatched) == 1
    assert "ilegible" in report.illegible_or_unmatched[0].raw_text.lower()
    assert report.client is not None
    assert report.client.codigo == "C_000001"
    assert report.total > 0

    # Verificar que el PDF generado tiene campos AcroForm editables
    reader = PdfReader(str(temp_env["out_pdf"]))
    fields = reader.get_fields()
    assert fields is not None
    assert "cliente_nombre" in fields
    assert "item_desc_0" in fields
    assert "item_qty_0" in fields
    assert "item_price_0" in fields
    assert "quote_total" in fields
    assert "rev_raw_0" in fields


def test_dynamic_config_updates_pricing_and_substitutions(temp_env: dict[str, Path]) -> None:
    cfg = ConfigManager(temp_env["config"])
    cfg.set_price_override("PROD_0046", 2.50)
    cfg.update_pricing(global_discount_pct=10.0)
    cfg.add_synonym("boligrafo", ["birome_test"])
    cfg.add_substitution("PROD_0001", ["PROD_0002"])

    svc = QuotationService(
        config_path=temp_env["config"],
        products_path=temp_env["products"],
        clients_path=temp_env["clients"],
        logo_path=temp_env["logo"],
    )
    # Actualizar descuento en caliente y verificar recarga automática
    report = svc.quote_from_text(
        "2 birome_test faber castell 0.35",
        output_pdf=temp_env["out_pdf"],
    )
    assert len(report.lines) == 1
    assert report.lines[0].codigo == "PROD_0046"
    assert report.lines[0].unit_price == 2.50
    assert report.subtotal == 5.00
    assert report.discount_amount == 0.50
    assert report.total == 4.50


def test_corrupted_image_and_unsupported_format(temp_env: dict[str, Path], tmp_path: Path) -> None:
    svc = QuotationService(
        config_path=temp_env["config"],
        products_path=temp_env["products"],
        clients_path=temp_env["clients"],
        logo_path=temp_env["logo"],
    )

    bad_img = tmp_path / "corrupta.png"
    bad_img.write_bytes(b"esto no es una imagen valida")
    with pytest.raises(IllegibleDocumentError):
        svc.quote_from_file(bad_img, output_pdf=temp_env["out_pdf"])

    bad_ext = tmp_path / "lista.docx"
    bad_ext.write_text("hola", encoding="utf-8")
    with pytest.raises(UnsupportedFormatError):
        svc.quote_from_file(bad_ext, output_pdf=temp_env["out_pdf"])


def test_pdf_input_end_to_end(temp_env: dict[str, Path], tmp_path: Path) -> None:
    src_pdf = tmp_path / "lista_escolar.pdf"
    c = canvas.Canvas(str(src_pdf))
    c.setFont("Helvetica", 12)
    c.drawString(50, 750, "1. 2 lapiceros faber castell 0.35")
    c.drawString(50, 730, "2. 1 borrador artesco blanco grande")
    c.save()

    svc = QuotationService(
        config_path=temp_env["config"],
        products_path=temp_env["products"],
        clients_path=temp_env["clients"],
        logo_path=temp_env["logo"],
    )
    report = svc.quote_from_file(src_pdf, output_pdf=temp_env["out_pdf"])
    assert len(report.lines) == 2
    assert temp_env["out_pdf"].exists()


def test_image_ocr_end_to_end(temp_env: dict[str, Path], tmp_path: Path) -> None:
    img_path = tmp_path / "lista_ocr.png"
    img = Image.new("RGB", (900, 300), color="white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 28)
    except OSError:
        font = ImageFont.load_default()
    draw.text((40, 40), "2 cuadernos a4 conti cuadriculado", fill="black", font=font)
    draw.text((40, 110), "1 borrador artesco blanco grande", fill="black", font=font)
    img.save(img_path)

    svc = QuotationService(
        config_path=temp_env["config"],
        products_path=temp_env["products"],
        clients_path=temp_env["clients"],
        logo_path=temp_env["logo"],
    )
    report = svc.quote_from_file(img_path, output_pdf=temp_env["out_pdf"])
    assert len(report.lines) >= 1
    assert temp_env["out_pdf"].exists()
