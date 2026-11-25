"""Modelos de datos principales para el sistema de cotización."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


MatchStatus = Literal["EXACTO", "SINONIMO", "SUSTITUTO", "NO_ENCONTRADO"]


@dataclass
class Product:
    codigo: str
    descripcion: str
    costo: float | None = None
    precio_und: float | None = None
    stock: float = 0.0
    precio_doc: float | None = None
    cant_mayor: float | None = None
    precio_cm: float | None = None
    proveedor: str = ""
    notas: str = ""


@dataclass
class Client:
    codigo: str
    cliente: str
    dni: str = ""
    telefono: str = ""
    celular: str = ""
    direccion: str = ""
    observaciones: str = ""


@dataclass
class ParsedItem:
    line_number: int
    raw_text: str
    quantity: float
    unit: str
    description: str
    confidence: float = 1.0


@dataclass
class IllegibleItem:
    line_number: int
    raw_text: str
    reason: str
    confidence: float = 0.0


@dataclass
class ExtractionResult:
    source_path: str
    method: str
    raw_text: str
    items: list[ParsedItem] = field(default_factory=list)
    illegible_items: list[IllegibleItem] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class QuoteLine:
    line_number: int
    raw_request: str
    quantity: float
    unit: str
    codigo: str
    descripcion: str
    unit_price: float
    subtotal: float
    match_status: MatchStatus
    match_score: float
    stock_available: float = 0.0
    notes: str = ""


@dataclass
class QuoteReport:
    quote_number: str
    date: str
    client: Client | None
    lines: list[QuoteLine] = field(default_factory=list)
    illegible_or_unmatched: list[IllegibleItem] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    subtotal: float = 0.0
    discount_amount: float = 0.0
    igv_amount: float = 0.0
    total: float = 0.0
    currency: str = "S/"
