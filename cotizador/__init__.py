"""Sistema de cotización automatizado para librería D'Kolor."""

from cotizador.config import ConfigManager
from cotizador.pipeline import QuotationService

__all__ = ["ConfigManager", "QuotationService"]
