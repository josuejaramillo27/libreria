"""CLI del Sistema de Cotización Automatizado D'Kolor."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict

from cotizador.config import ConfigManager
from cotizador.exceptions import CotizadorError
from cotizador.pipeline import QuotationService


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cotizador",
        description="Sistema de cotización automatizado para librería D'Kolor.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # Subcomando: cotizar
    p_cot = sub.add_parser("cotizar", help="Procesa una imagen o PDF de lista escolar y genera PDF editable.")
    p_cot.add_argument("archivo", help="Ruta a imagen (.jpg/.png/...) o PDF de la lista escolar.")
    p_cot.add_argument("--cliente", "-c", default=None, help="Código, DNI o nombre del cliente.")
    p_cot.add_argument("--codigo", default=None, help="Código de cotización personalizado.")
    p_cot.add_argument("--salida", "-o", default="output/cotizacion.pdf", help="Ruta del PDF editable de salida.")
    p_cot.add_argument("--json", default=None, help="Ruta opcional para exportar resumen en JSON.")

    # Subcomando: config
    p_cfg = sub.add_parser("config", help="Consulta o actualiza parámetros dinámicos de precios y sustituciones.")
    cfg_sub = p_cfg.add_subparsers(dest="cfg_action", required=True)

    cfg_sub.add_parser("show", help="Muestra la configuración actual.")

    p_price = cfg_sub.add_parser("set-pricing", help="Actualiza parámetros globales de precios.")
    p_price.add_argument("--discount", type=float, default=None, help="Descuento global (%%).")
    p_price.add_argument("--margin", type=float, default=None, help="Margen global (%%).")
    p_price.add_argument("--igv", type=float, default=None, help="Tasa IGV (ej. 0.18 o 0.0).")
    p_price.add_argument("--rounding", type=float, default=None, help="Paso de redondeo (ej. 0.05).")

    p_ovr = cfg_sub.add_parser("set-price", help="Fija un precio personalizado para un código.")
    p_ovr.add_argument("codigo", help="Código de producto (ej. PROD_0001).")
    p_ovr.add_argument("precio", type=float, help="Nuevo precio unitario en S/.")

    p_syn = cfg_sub.add_parser("add-synonym", help="Agrega sinónimos para un término canónico.")
    p_syn.add_argument("canonico", help="Término canónico (ej. boligrafo).")
    p_syn.add_argument("sinonimos", help="Lista separada por comas (ej. lapicero,esfero).")

    p_sub = cfg_sub.add_parser("add-substitution", help="Agrega sustitutos para un código de producto.")
    p_sub.add_argument("origen", help="Código de producto origen.")
    p_sub.add_argument("sustitutos", help="Códigos sustitutos separados por comas.")

    p_map = cfg_sub.add_parser("map-term", help="Asocia una frase escolar directamente a un código.")
    p_map.add_argument("frase", help="Frase de la lista escolar.")
    p_map.add_argument("codigo", help="Código de producto en inventario.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "cotizar":
            service = QuotationService()
            report = service.quote_from_file(
                input_path=args.archivo,
                output_pdf=args.salida,
                client_id=args.cliente,
                quote_number=args.codigo,
                output_json=args.json,
            )
            print(f"Cotización generada: {args.salida}")
            print(f"  Ítems cotizados : {len(report.lines)}")
            print(f"  Ítems ilegibles : {len(report.illegible_or_unmatched)}")
            print(f"  Total           : {report.currency} {report.total:.2f}")
            if report.warnings:
                print("  Advertencias:")
                for w in report.warnings:
                    print(f"    - {w}")
            return 0

        if args.command == "config":
            cfg = ConfigManager()
            if args.cfg_action == "show":
                print(json.dumps(asdict(cfg.rules), indent=2, ensure_ascii=False))
            elif args.cfg_action == "set-pricing":
                updated = cfg.update_pricing(
                    global_discount_pct=args.discount,
                    default_margin_pct=args.margin,
                    igv_rate=args.igv,
                    price_rounding=args.rounding,
                )
                print("Parámetros de precios actualizados:", asdict(updated))
            elif args.cfg_action == "set-price":
                cfg.set_price_override(args.codigo, args.precio)
                print(f"Precio fijo actualizado: {args.codigo.upper()} = S/ {args.precio:.2f}")
            elif args.cfg_action == "add-synonym":
                syns = [s.strip() for s in args.sinonimos.split(",") if s.strip()]
                cfg.add_synonym(args.canonico, syns)
                print(f"Sinónimos actualizados para '{args.canonico}': {cfg.rules.matching.synonyms[args.canonico.lower()]}")
            elif args.cfg_action == "add-substitution":
                subs = [s.strip() for s in args.sustitutos.split(",") if s.strip()]
                cfg.add_substitution(args.origen, subs)
                print(f"Sustituciones actualizadas para '{args.origen.upper()}': {cfg.rules.matching.substitutions[args.origen.upper()]}")
            elif args.cfg_action == "map-term":
                cfg.set_term_mapping(args.frase, args.codigo)
                print(f"Mapeo guardado: '{args.frase}' -> {args.codigo.upper()}")
            return 0

    except CotizadorError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
