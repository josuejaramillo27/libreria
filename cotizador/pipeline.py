"""Orquestador principal del flujo: extracción -> cruce -> precios -> PDF editable."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date
from pathlib import Path

from cotizador.config import ConfigManager
from cotizador.extractor import extract_school_list, parse_school_list_text
from cotizador.inventory import InventoryRepository
from cotizador.matcher import SynonymMatcher
from cotizador.models import ExtractionResult, IllegibleItem, QuoteLine, QuoteReport
from cotizador.pdf_generator import generate_editable_pdf
from cotizador.pricing import calculate_unit_price, compute_totals


class QuotationService:
    """Servicio de alto nivel para generar cotizaciones desde imágenes, PDFs o texto."""

    def __init__(
        self,
        config_path: str | Path = "config/rules.json",
        products_path: str | Path = "data/products.json",
        clients_path: str | Path = "data/clients.json",
        logo_path: str | Path = "assets/logo.jpg",
    ) -> None:
        self.config_manager = ConfigManager(config_path)
        self.inventory = InventoryRepository(products_path, clients_path)
        self.logo_path = Path(logo_path)

    def _build_report(
        self,
        extraction: ExtractionResult,
        client_id: str | None = None,
        quote_number: str | None = None,
    ) -> QuoteReport:
        # Recarga dinámica de reglas si fueron modificadas en caliente
        self.config_manager.reload_if_changed()
        rules = self.config_manager.rules

        matcher = SynonymMatcher(self.inventory, rules.matching)
        client = self.inventory.get_client(client_id)
        q_num = quote_number or f"COT-{date.today().strftime('%Y%m%d')}-001"
        today_str = date.today().isoformat()

        lines: list[QuoteLine] = []
        unmatched_or_illegible: list[IllegibleItem] = list(extraction.illegible_items)
        warnings = list(extraction.warnings)

        for item in extraction.items:
            outcome = matcher.match_item(item)
            if outcome.product is None or outcome.status == "NO_ENCONTRADO":
                unmatched_or_illegible.append(
                    IllegibleItem(
                        line_number=item.line_number,
                        raw_text=item.raw_text,
                        reason=f"Sin coincidencia en inventario (score={outcome.score})",
                        confidence=item.confidence,
                    )
                )
                continue

            unit_price, price_note = calculate_unit_price(
                outcome.product, item.quantity, rules.pricing
            )
            subtotal = round(unit_price * item.quantity, 2)
            combined_note = " | ".join(filter(None, [outcome.notes, price_note]))

            if outcome.product.stock < item.quantity:
                warnings.append(
                    f"Stock bajo para {outcome.product.codigo} ({outcome.product.descripcion}): "
                    f"disponible {outcome.product.stock}, solicitado {item.quantity}"
                )

            lines.append(
                QuoteLine(
                    line_number=item.line_number,
                    raw_request=item.raw_text,
                    quantity=item.quantity,
                    unit=item.unit,
                    codigo=outcome.product.codigo,
                    descripcion=outcome.product.descripcion,
                    unit_price=unit_price,
                    subtotal=subtotal,
                    match_status=outcome.status,
                    match_score=outcome.score,
                    stock_available=outcome.product.stock,
                    notes=combined_note,
                )
            )

        subtotal, discount, igv, total = compute_totals(
            [ln.subtotal for ln in lines], rules.pricing
        )

        return QuoteReport(
            quote_number=q_num,
            date=today_str,
            client=client,
            lines=lines,
            illegible_or_unmatched=unmatched_or_illegible,
            warnings=warnings,
            subtotal=subtotal,
            discount_amount=discount,
            igv_amount=igv,
            total=total,
            currency=rules.pricing.currency_symbol,
        )

    def quote_from_file(
        self,
        input_path: str | Path,
        output_pdf: str | Path = "output/cotizacion.pdf",
        client_id: str | None = None,
        quote_number: str | None = None,
        output_json: str | Path | None = None,
    ) -> QuoteReport:
        """Procesa una imagen o PDF de lista escolar y genera el PDF editable."""
        self.config_manager.reload_if_changed()
        extraction = extract_school_list(input_path, self.config_manager.rules.matching)
        report = self._build_report(extraction, client_id=client_id, quote_number=quote_number)
        generate_editable_pdf(report, output_pdf, logo_path=self.logo_path)
        if output_json:
            self.export_json(report, output_json)
        return report

    def quote_from_text(
        self,
        raw_text: str,
        output_pdf: str | Path = "output/cotizacion.pdf",
        client_id: str | None = None,
        quote_number: str | None = None,
        output_json: str | Path | None = None,
    ) -> QuoteReport:
        """Genera una cotización directamente desde texto de lista escolar."""
        self.config_manager.reload_if_changed()
        extraction = parse_school_list_text(raw_text, self.config_manager.rules.matching)
        report = self._build_report(extraction, client_id=client_id, quote_number=quote_number)
        generate_editable_pdf(report, output_pdf, logo_path=self.logo_path)
        if output_json:
            self.export_json(report, output_json)
        return report

    @staticmethod
    def export_json(report: QuoteReport, json_path: str | Path) -> Path:
        out = Path(json_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(asdict(report), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return out
