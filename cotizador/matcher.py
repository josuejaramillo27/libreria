"""Motor de cruce con inventario aplicando reglas de sinonimia, equivalencia y sustitución."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from rapidfuzz import fuzz

from cotizador.config import MatchingConfig
from cotizador.inventory import InventoryRepository
from cotizador.models import MatchStatus, ParsedItem, Product


def normalize_text(text: str) -> str:
    """Normaliza texto a minúsculas sin tildes ni puntuación redundante."""
    nfkd = unicodedata.normalize("NFKD", text.lower())
    no_accents = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    no_accents = re.sub(r"\bx\s*(\d+)\b", r"x\1", no_accents)
    no_accents = re.sub(r"\ba\s*-\s*([345])\b", r"a\1", no_accents)
    cleaned = re.sub(r"[^a-z0-9\s]", " ", no_accents)
    return re.sub(r"\s+", " ", cleaned).strip()


@dataclass
class MatchOutcome:
    product: Product | None
    status: MatchStatus
    score: float
    notes: str = ""


class SynonymMatcher:
    """Cruza ítems de listas escolares contra el inventario aplicando sinonimia y equivalencias."""

    def __init__(self, inventory: InventoryRepository, cfg: MatchingConfig) -> None:
        self.inventory = inventory
        self.cfg = cfg
        self._synonym_lookup = self._build_synonym_lookup()
        self._normalized_products: list[tuple[Product, str, set[str]]] = [
            (p, norm := normalize_text(p.descripcion), set(norm.split()))
            for p in inventory.products
        ]

    def _build_synonym_lookup(self) -> dict[str, str]:
        lookup: dict[str, str] = {}
        for canonical, variants in self.cfg.synonyms.items():
            c_norm = normalize_text(canonical)
            lookup[c_norm] = c_norm
            for v in variants:
                v_norm = normalize_text(v)
                if v_norm:
                    lookup[v_norm] = c_norm
        return lookup

    def _canonicalize_phrase(self, norm_text: str) -> tuple[str, bool]:
        """Reemplaza sinónimos conocidos por su término canónico."""
        replaced = norm_text
        used_synonym = False
        # Reemplazar frases multi-palabra primero (mayor longitud primero)
        for variant, canonical in sorted(
            self._synonym_lookup.items(), key=lambda kv: len(kv[0]), reverse=True
        ):
            if variant == canonical:
                continue
            pattern = rf"\b{re.escape(variant)}\b"
            if re.search(pattern, replaced):
                replaced = re.sub(pattern, canonical, replaced)
                used_synonym = True
        return re.sub(r"\s+", " ", replaced).strip(), used_synonym

    def _expand_brand_variants(self, text: str) -> list[str]:
        variants = [text]
        for brand, equivs in self.cfg.brand_equivalences.items():
            b_norm = normalize_text(brand)
            if re.search(rf"\b{re.escape(b_norm)}\b", text):
                for eq in equivs:
                    eq_norm = normalize_text(eq)
                    variants.append(re.sub(rf"\b{re.escape(b_norm)}\b", eq_norm, text))
        return variants

    def _has_valid_stock_and_price(self, prod: Product) -> bool:
        has_price = (prod.precio_und is not None and prod.precio_und > 0) or (
            prod.precio_cm is not None and prod.precio_cm > 0
        )
        return prod.stock > 0 and has_price

    def _find_substitute(self, prod: Product, query_norm: str) -> tuple[Product | None, str]:
        # 1. Regla explícita de sustitución por código
        for sub_code in self.cfg.substitutions.get(prod.codigo, []):
            sub = self.inventory.get_product(sub_code)
            if sub and self._has_valid_stock_and_price(sub):
                return sub, f"Sustituto configurado de {prod.codigo} ({prod.descripcion})"

        # 2. Equivalente de marca o mismo producto en inventario con stock y precio válido
        prod_norm = normalize_text(prod.descripcion)
        best_sub: Product | None = None
        best_score = 0.0
        for candidate, cand_norm, _ in self._normalized_products:
            if candidate.codigo == prod.codigo or not self._has_valid_stock_and_price(candidate):
                continue
            s = 0.6 * fuzz.token_set_ratio(prod_norm, cand_norm) + 0.4 * fuzz.token_sort_ratio(
                query_norm, cand_norm
            )
            if s > best_score:
                best_score = s
                best_sub = candidate

        if best_sub and best_score >= max(self.cfg.min_match_score, 68.0):
            return best_sub, f"Equivalente en stock de {prod.codigo} ({prod.descripcion})"
        return None, ""

    def match_item(self, item: ParsedItem) -> MatchOutcome:
        """Encuentra el mejor producto o sustituto para un ítem extraído."""
        query_norm = normalize_text(item.description)
        if not query_norm:
            return MatchOutcome(None, "NO_ENCONTRADO", 0.0, "Descripción vacía")

        # 1. Mapeo directo frase -> código
        for phrase, code in self.cfg.term_to_code.items():
            if normalize_text(phrase) == query_norm:
                prod = self.inventory.get_product(code)
                if prod:
                    if self._has_valid_stock_and_price(prod):
                        return MatchOutcome(prod, "EXACTO", 100.0, "Mapeo directo configurado")
                    sub, note = self._find_substitute(prod, query_norm)
                    if sub:
                        return MatchOutcome(sub, "SUSTITUTO", 95.0, note)

        canonical_query, used_synonym = self._canonicalize_phrase(query_norm)
        query_variants = self._expand_brand_variants(canonical_query)
        query_tokens = set(canonical_query.split())

        best_prod: Product | None = None
        best_score = 0.0
        best_used_brand_equiv = False

        for prod, prod_norm, prod_tokens in self._normalized_products:
            prod_canon, _ = self._canonicalize_phrase(prod_norm)
            prod_canon_tokens = set(prod_canon.split())

            for idx, qv in enumerate(query_variants):
                qv_tokens = set(qv.split())
                token_set = fuzz.token_set_ratio(qv, prod_canon)
                token_sort = fuzz.token_sort_ratio(qv, prod_canon)
                partial = fuzz.partial_ratio(qv, prod_canon)

                # Bonus por coincidencia exacta de tokens clave (ej. x12, a4, oficio)
                overlap = len(qv_tokens & prod_canon_tokens)
                overlap_ratio = (overlap / max(len(qv_tokens), 1)) * 100.0

                score = 0.45 * token_set + 0.25 * token_sort + 0.15 * partial + 0.15 * overlap_ratio
                # Penalizar ligeramente si el producto no tiene precio válido
                if prod.precio_und is None or prod.precio_und <= 0:
                    score -= 4.0

                if score > best_score:
                    best_score = score
                    best_prod = prod
                    best_used_brand_equiv = idx > 0

        if best_prod is None or best_score < self.cfg.min_match_score:
            return MatchOutcome(
                None,
                "NO_ENCONTRADO",
                round(best_score, 1),
                "Sin coincidencia suficiente en inventario",
            )

        # Si el mejor producto no tiene stock o precio válido, buscar sustituto
        if not self._has_valid_stock_and_price(best_prod):
            sub, note = self._find_substitute(best_prod, canonical_query)
            if sub:
                return MatchOutcome(sub, "SUSTITUTO", round(best_score, 1), note)

        if best_used_brand_equiv:
            status: MatchStatus = "SUSTITUTO"
            note = "Equivalencia de marca aplicada"
        elif used_synonym or best_score < self.cfg.exact_match_score:
            status = "SINONIMO"
            note = "Coincidencia por sinonimia/aproximación" if used_synonym else "Coincidencia aproximada"
        else:
            status = "EXACTO"
            note = ""

        # Asegurar que si hay tokens sin coincidencia clara pero score alto, siga siendo válido
        _ = query_tokens
        return MatchOutcome(best_prod, status, round(best_score, 1), note)
