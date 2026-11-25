"""Gestión dinámica de parámetros de precios, sinonimia y sustituciones."""

from __future__ import annotations

import copy
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from cotizador.exceptions import ConfigError


@dataclass
class PricingConfig:
    currency_symbol: str = "S/"
    igv_rate: float = 0.0
    igv_included: bool = True
    global_discount_pct: float = 0.0
    default_margin_pct: float = 0.0
    apply_wholesale_tier: bool = True
    apply_dozen_tier: bool = True
    ignore_anomalous_wholesale_above_unit_ratio: float = 1.8
    price_rounding: float = 0.05
    product_price_overrides: dict[str, float] = field(default_factory=dict)
    category_markups_pct: dict[str, float] = field(default_factory=dict)


@dataclass
class MatchingConfig:
    min_match_score: float = 60.0
    exact_match_score: float = 88.0
    illegible_min_alpha_ratio: float = 0.35
    illegible_min_length: int = 3
    synonyms: dict[str, list[str]] = field(default_factory=dict)
    brand_equivalences: dict[str, list[str]] = field(default_factory=dict)
    substitutions: dict[str, list[str]] = field(default_factory=dict)
    term_to_code: dict[str, str] = field(default_factory=dict)


@dataclass
class RulesConfig:
    pricing: PricingConfig = field(default_factory=PricingConfig)
    matching: MatchingConfig = field(default_factory=MatchingConfig)


class ConfigManager:
    """Administra reglas dinámicas en JSON con recarga automática y actualización en caliente."""

    def __init__(self, config_path: str | Path = "config/rules.json") -> None:
        self.path = Path(config_path)
        self._last_mtime: float | None = None
        self.rules = self._load()

    def _load(self) -> RulesConfig:
        if not self.path.exists():
            raise ConfigError(f"No se encontró el archivo de configuración: {self.path}")
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            self._last_mtime = self.path.stat().st_mtime
        except (OSError, json.JSONDecodeError) as exc:
            raise ConfigError(f"Error al leer configuración {self.path}: {exc}") from exc

        pricing_raw = raw.get("pricing", {})
        matching_raw = raw.get("matching", {})
        try:
            pricing = PricingConfig(**pricing_raw)
            matching = MatchingConfig(**matching_raw)
        except TypeError as exc:
            raise ConfigError(f"Estructura inválida en configuración: {exc}") from exc
        return RulesConfig(pricing=pricing, matching=matching)

    def reload_if_changed(self) -> bool:
        """Recarga la configuración si el archivo fue modificado externamente."""
        if not self.path.exists():
            return False
        mtime = self.path.stat().st_mtime
        if self._last_mtime is None or mtime > self._last_mtime:
            self.rules = self._load()
            return True
        return False

    def save(self) -> None:
        """Persiste la configuración actual en disco."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "pricing": asdict(self.rules.pricing),
            "matching": asdict(self.rules.matching),
        }
        self.path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        self._last_mtime = self.path.stat().st_mtime

    def update_pricing(self, **kwargs: Any) -> PricingConfig:
        """Actualiza dinámicamente parámetros de precios y guarda."""
        valid_fields = set(PricingConfig.__dataclass_fields__.keys())
        for key, value in kwargs.items():
            if key not in valid_fields:
                raise ConfigError(f"Parámetro de precio desconocido: {key}")
            if value is not None:
                setattr(self.rules.pricing, key, value)
        self.save()
        return copy.deepcopy(self.rules.pricing)

    def set_price_override(self, codigo: str, price: float) -> None:
        """Define o actualiza un precio fijo para un código de producto."""
        if price < 0:
            raise ConfigError("El precio no puede ser negativo.")
        self.rules.pricing.product_price_overrides[codigo.strip().upper()] = float(price)
        self.save()

    def remove_price_override(self, codigo: str) -> bool:
        """Elimina un precio personalizado por código."""
        removed = self.rules.pricing.product_price_overrides.pop(codigo.strip().upper(), None)
        if removed is not None:
            self.save()
            return True
        return False

    def add_synonym(self, canonical: str, synonyms: list[str]) -> None:
        """Agrega sinónimos dinámicamente para un término canónico."""
        key = canonical.strip().lower()
        if not key:
            raise ConfigError("El término canónico no puede estar vacío.")
        existing = set(self.rules.matching.synonyms.get(key, []))
        for s in synonyms:
            cleaned = s.strip().lower()
            if cleaned and cleaned != key:
                existing.add(cleaned)
        self.rules.matching.synonyms[key] = sorted(existing)
        self.save()

    def add_substitution(self, source_code: str, substitute_codes: list[str]) -> None:
        """Agrega reglas de sustitución entre códigos de producto."""
        src = source_code.strip().upper()
        if not src:
            raise ConfigError("El código origen no puede estar vacío.")
        current = list(self.rules.matching.substitutions.get(src, []))
        for code in substitute_codes:
            c = code.strip().upper()
            if c and c != src and c not in current:
                current.append(c)
        self.rules.matching.substitutions[src] = current
        self.save()

    def set_term_mapping(self, phrase: str, codigo: str) -> None:
        """Asocia directamente una frase escolar a un código de inventario."""
        p = phrase.strip().lower()
        c = codigo.strip().upper()
        if not p or not c:
            raise ConfigError("La frase y el código son obligatorios.")
        self.rules.matching.term_to_code[p] = c
        self.save()
