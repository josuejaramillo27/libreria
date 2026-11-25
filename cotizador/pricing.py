"""Motor de cálculo dinámico de precios, descuentos e IGV."""

from __future__ import annotations

import math

from cotizador.config import PricingConfig
from cotizador.matcher import normalize_text
from cotizador.models import Product


def _round_price(value: float, step: float) -> float:
    if step <= 0:
        return round(value, 2)
    return round(round(value / step) * step, 2)


def _is_valid_tier_price(tier_price: float | None, unit_price: float, max_ratio: float) -> bool:
    if tier_price is None or tier_price <= 0:
        return False
    if unit_price > 0 and tier_price > unit_price * max_ratio:
        # Protege contra valores anómalos heredados de Excel (ej. 11111.0 o 1000.0)
        return False
    return True


def calculate_unit_price(product: Product, quantity: float, cfg: PricingConfig) -> tuple[float, str]:
    """Calcula el precio unitario aplicando overrides, escalas mayoristas, márgenes y redondeo."""
    code = product.codigo.upper()
    if code in cfg.product_price_overrides:
        return round(cfg.product_price_overrides[code], 2), "Precio fijo personalizado"

    base_unit = float(product.precio_und) if product.precio_und and product.precio_und > 0 else 0.0
    tier_note = ""

    selected_price = base_unit

    # Escala por mayor (cant_mayor / precio_cm) igual que assets/app.js
    if (
        cfg.apply_wholesale_tier
        and product.cant_mayor is not None
        and quantity >= product.cant_mayor
        and _is_valid_tier_price(
            product.precio_cm, base_unit, cfg.ignore_anomalous_wholesale_above_unit_ratio
        )
    ):
        selected_price = float(product.precio_cm)  # type: ignore[arg-type]
        tier_note = f"Precio mayorista (>= {int(product.cant_mayor)})"
    # Escala por docena (precio_doc) si aplica y es menor o razonable
    elif (
        cfg.apply_dozen_tier
        and quantity >= 12
        and _is_valid_tier_price(
            product.precio_doc, base_unit, cfg.ignore_anomalous_wholesale_above_unit_ratio
        )
    ):
        selected_price = float(product.precio_doc)  # type: ignore[arg-type]
        tier_note = "Precio por docena (>= 12)"

    if selected_price <= 0:
        return 0.0, "Sin precio unitario definido (requiere revisión)"

    # Ajuste dinámico por categoría (palabra clave en descripción)
    desc_norm = normalize_text(product.descripcion)
    for keyword, pct in cfg.category_markups_pct.items():
        if normalize_text(keyword) in desc_norm:
            selected_price *= 1.0 + (pct / 100.0)
            tier_note = (tier_note + f" | Ajuste {keyword}: {pct:+.1f}%").strip(" |")

    # Margen global dinámico
    if cfg.default_margin_pct != 0.0:
        selected_price *= 1.0 + (cfg.default_margin_pct / 100.0)

    final_price = _round_price(selected_price, cfg.price_rounding)
    if math.isnan(final_price) or final_price < 0:
        final_price = 0.0
    return final_price, tier_note


def compute_totals(
    line_subtotals: list[float],
    cfg: PricingConfig,
) -> tuple[float, float, float, float]:
    """Calcula (subtotal_bruto, descuento, igv, total_final)."""
    subtotal = round(sum(line_subtotals), 2)
    discount = round(subtotal * (max(cfg.global_discount_pct, 0.0) / 100.0), 2)
    net = round(max(subtotal - discount, 0.0), 2)

    if cfg.igv_rate > 0:
        if cfg.igv_included:
            igv = round(net - (net / (1.0 + cfg.igv_rate)), 2)
            total = net
        else:
            igv = round(net * cfg.igv_rate, 2)
            total = round(net + igv, 2)
    else:
        igv = 0.0
        total = net

    return subtotal, discount, igv, total
