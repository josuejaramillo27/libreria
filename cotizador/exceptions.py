"""Excepciones personalizadas del sistema de cotización D'Kolor."""


class CotizadorError(Exception):
    """Excepción base para errores del sistema de cotización."""


class UnsupportedFormatError(CotizadorError):
    """El formato del archivo de entrada no es compatible (solo imágenes o PDF)."""


class IllegibleDocumentError(CotizadorError):
    """El documento completo está corrupto, cifrado, vacío o es totalmente ilegible."""


class InventoryLoadError(CotizadorError):
    """No se pudo cargar o validar la base de datos de productos o clientes."""


class ConfigError(CotizadorError):
    """Error al leer, validar o actualizar la configuración dinámica."""
