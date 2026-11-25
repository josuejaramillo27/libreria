"""Carga y consulta de inventario (products.json) y clientes (clients.json)."""

from __future__ import annotations

import json
from pathlib import Path

from cotizador.exceptions import InventoryLoadError
from cotizador.models import Client, Product


def _to_float(val: object, default: float | None = None) -> float | None:
    if val is None or val == "":
        return default
    try:
        num = float(val)
        return num
    except (TypeError, ValueError):
        return default


def _clean_str(val: object) -> str:
    if val is None:
        return ""
    s = str(val).strip()
    return "" if s.lower() == "nan" else s


class InventoryRepository:
    """Repositorio en memoria respaldado por los JSON de D'Kolor."""

    def __init__(
        self,
        products_path: str | Path = "data/products.json",
        clients_path: str | Path = "data/clients.json",
    ) -> None:
        self.products_path = Path(products_path)
        self.clients_path = Path(clients_path)
        self.products: list[Product] = self._load_products()
        self.by_code: dict[str, Product] = {p.codigo.upper(): p for p in self.products}
        self.clients: list[Client] = self._load_clients()
        self.clients_by_code: dict[str, Client] = {c.codigo.upper(): c for c in self.clients}

    def _load_products(self) -> list[Product]:
        if not self.products_path.exists():
            raise InventoryLoadError(f"No se encontró el inventario: {self.products_path}")
        try:
            raw = json.loads(self.products_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise InventoryLoadError(f"Error al leer {self.products_path}: {exc}") from exc

        products: list[Product] = []
        for row in raw:
            code = _clean_str(row.get("codigo")).upper()
            desc = _clean_str(row.get("descripcion"))
            if not code or not desc:
                continue
            products.append(
                Product(
                    codigo=code,
                    descripcion=desc,
                    costo=_to_float(row.get("costo")),
                    precio_und=_to_float(row.get("precio_und")),
                    stock=_to_float(row.get("stock"), 0.0) or 0.0,
                    precio_doc=_to_float(row.get("precio_doc")),
                    cant_mayor=_to_float(row.get("cant_mayor")),
                    precio_cm=_to_float(row.get("precio_cm")),
                    proveedor=_clean_str(row.get("proveedor")),
                    notas=_clean_str(row.get("notas")),
                )
            )
        return products

    def _load_clients(self) -> list[Client]:
        if not self.clients_path.exists():
            return []
        try:
            raw = json.loads(self.clients_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise InventoryLoadError(f"Error al leer {self.clients_path}: {exc}") from exc

        clients: list[Client] = []
        for row in raw:
            code = _clean_str(row.get("codigo")).upper()
            name = _clean_str(row.get("cliente"))
            if not code or not name:
                continue
            clients.append(
                Client(
                    codigo=code,
                    cliente=name,
                    dni=_clean_str(row.get("dni")),
                    telefono=_clean_str(row.get("telefono")),
                    celular=_clean_str(row.get("celular")),
                    direccion=_clean_str(row.get("direccion")),
                    observaciones=_clean_str(row.get("observaciones")),
                )
            )
        return clients

    def get_product(self, codigo: str) -> Product | None:
        return self.by_code.get(codigo.strip().upper())

    def get_client(self, identifier: str | None) -> Client | None:
        if not identifier:
            return None
        key = identifier.strip().upper()
        if key in self.clients_by_code:
            return self.clients_by_code[key]
        # Búsqueda parcial por nombre o DNI
        low = identifier.strip().lower()
        for c in self.clients:
            if c.dni == identifier.strip() or low in c.cliente.lower():
                return c
        return None
