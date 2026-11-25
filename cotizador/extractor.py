"""Extracción de texto desde imágenes y PDFs (nativos o escaneados) y parser de listas escolares."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from cotizador.config import MatchingConfig
from cotizador.exceptions import IllegibleDocumentError, UnsupportedFormatError
from cotizador.models import ExtractionResult, IllegibleItem, ParsedItem

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
PDF_EXTENSIONS = {".pdf"}

SPANISH_NUMBERS: dict[str, float] = {
    "un": 1.0,
    "uno": 1.0,
    "una": 1.0,
    "dos": 2.0,
    "tres": 3.0,
    "cuatro": 4.0,
    "cinco": 5.0,
    "seis": 6.0,
    "siete": 7.0,
    "ocho": 8.0,
    "nueve": 9.0,
    "diez": 10.0,
    "once": 11.0,
    "doce": 12.0,
    "media docena": 6.0,
    "docena": 12.0,
    "1 docena": 12.0,
    "una docena": 12.0,
    "par": 2.0,
    "un par": 2.0,
}

UNITS_PATTERN = (
    r"unidades|unidad|unds|und|u\.|cajas|caja|paquetes|paquete|paq\.?|"
    r"pliegos|pliego|metros|metro|mts|m\.|frascos|frasco|blister|"
    r"juegos|juego|set|sets|docenas|docena|doc\.?|rollos|rollo|bolsas|bolsa"
)

HEADER_NOISE_RE = re.compile(
    r"^(?:lista\s+de\s+[uú]tiles|utiles\s+escolares|colegio|instituci[oó]n|"
    r"grado\s*:|secci[oó]n\s*:|nivel\s*:|alumno\s*:|fecha\s*:|nota\s*:|"
    r"a[nñ]o\s+escolar|inicial|primaria|secundaria)\b",
    re.IGNORECASE,
)

WINRT_OCR_PS = r"""
param([string]$ImagePath, [string]$LangTag = "es-ES")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
    $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$absPath = (Resolve-Path $ImagePath).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = New-Object Windows.Globalization.Language($LangTag)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) {
    throw "No se pudo inicializar el motor OCR de Windows."
}
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) {
    $lines += $line.Text
}
$stream.Dispose()
@{ text = ($lines -join "`n"); lines = $lines } | ConvertTo-Json -Compress
"""

WINRT_PDF_RENDER_PS = r"""
param([string]$PdfPath, [string]$OutDir)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]
function Await($WinRtTask, $ResultType) {
    $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
function AwaitAction($WinRtTask) {
    $netTask = $asTaskAction.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
}

$absPdf = (Resolve-Path $PdfPath).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absPdf)) ([Windows.Storage.StorageFile])
$pdfDoc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$outFiles = @()
$outFolder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync((Resolve-Path $OutDir).Path)) ([Windows.Storage.StorageFolder])

for ($i = 0; $i -lt $pdfDoc.PageCount; $i++) {
    $page = $pdfDoc.GetPage($i)
    $imgName = "page_$($i + 1).png"
    $outFile = Await ($outFolder.CreateFileAsync($imgName, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
    $stream = Await ($outFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]($page.Size.Width * 2.0)
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    $stream.Dispose()
    $page.Dispose()
    $outFiles += (Join-Path $OutDir $imgName)
}
$outFiles | ConvertTo-Json -Compress
"""


def _preprocess_image_for_ocr(src_path: Path, dst_path: Path) -> None:
    """Valida la imagen y mejora contraste/resolución para OCR."""
    try:
        with Image.open(src_path) as probe:
            probe.verify()
        with Image.open(src_path) as img:
            gray = ImageOps.grayscale(img)
            enhanced = ImageOps.autocontrast(gray, cutoff=1)
            w, h = enhanced.size
            if w < 1000:
                scale = max(2, int(1200 / max(w, 1)))
                enhanced = enhanced.resize((w * scale, h * scale), Image.Resampling.LANCZOS)
            enhanced.save(dst_path, format="PNG")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise IllegibleDocumentError(
            f"La imagen '{src_path.name}' está corrupta o no se puede leer: {exc}"
        ) from exc


def _run_powershell_script(script_body: str, args: list[str]) -> str:
    """Ejecuta un script PowerShell temporal de forma segura."""
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8") as tf:
        tf.write(script_body)
        ps_path = tf.name
    try:
        cmd = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            ps_path,
            *args,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=90)
        if proc.returncode != 0:
            err = proc.stderr.strip() or proc.stdout.strip()
            raise IllegibleDocumentError(f"Error en motor OCR/PDF de Windows: {err}")
        return proc.stdout.strip()
    except subprocess.TimeoutExpired as exc:
        raise IllegibleDocumentError("El procesamiento OCR excedió el tiempo límite.") from exc
    finally:
        try:
            os.remove(ps_path)
        except OSError:
            pass


def ocr_image(image_path: Path) -> str:
    """Extrae texto de una imagen usando Tesseract (si existe) o Windows Native OCR."""
    with tempfile.TemporaryDirectory() as tmpdir:
        prep_path = Path(tmpdir) / "preprocessed.png"
        _preprocess_image_for_ocr(image_path, prep_path)

        # Opción 1: pytesseract si está instalado y disponible
        try:
            import pytesseract  # type: ignore

            text = pytesseract.image_to_string(Image.open(prep_path), lang="spa")
            if text and text.strip():
                return text
        except Exception:
            pass

        # Opción 2: Windows Native OCR (WinRT)
        if os.name == "nt":
            out = _run_powershell_script(WINRT_OCR_PS, [str(prep_path), "es-ES"])
            if not out:
                return ""
            try:
                data = json.loads(out)
                return str(data.get("text", "") or "")
            except json.JSONDecodeError:
                return out

        raise IllegibleDocumentError(
            "No hay motor OCR disponible (instale Tesseract o ejecute en Windows 10/11)."
        )


def extract_text_from_pdf(pdf_path: Path) -> tuple[str, str, list[str]]:
    """Extrae texto de un PDF nativo o escaneado mediante OCR."""
    warnings: list[str] = []
    try:
        reader = PdfReader(str(pdf_path))
        if reader.is_encrypted:
            try:
                res = reader.decrypt("")
                if res == 0:
                    raise IllegibleDocumentError(
                        f"El PDF '{pdf_path.name}' está protegido con contraseña."
                    )
            except Exception as exc:
                raise IllegibleDocumentError(
                    f"El PDF '{pdf_path.name}' está cifrado y no se puede leer."
                ) from exc

        pages_text: list[str] = []
        for idx, page in enumerate(reader.pages, start=1):
            try:
                txt = page.extract_text() or ""
                if txt.strip():
                    pages_text.append(txt)
            except Exception as exc:
                warnings.append(f"No se pudo leer texto de la página {idx}: {exc}")

        combined = "\n".join(pages_text).strip()
        if len(combined) >= 15:
            return combined, "pdf_text", warnings
    except PdfReadError as exc:
        raise IllegibleDocumentError(
            f"El archivo PDF '{pdf_path.name}' está dañado o es inválido: {exc}"
        ) from exc

    # Fallback: PDF escaneado -> renderizar páginas a PNG y aplicar OCR
    warnings.append("PDF sin texto embebido detectado; aplicando OCR a las páginas.")
    if os.name != "nt":
        raise IllegibleDocumentError(
            f"El PDF '{pdf_path.name}' parece escaneado y requiere OCR de Windows o PyMuPDF."
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        raw_json = _run_powershell_script(WINRT_PDF_RENDER_PS, [str(pdf_path), tmpdir])
        if not raw_json:
            raise IllegibleDocumentError(f"No se pudieron renderizar páginas de '{pdf_path.name}'.")
        rendered = json.loads(raw_json)
        if isinstance(rendered, str):
            rendered = [rendered]
        ocr_pages: list[str] = []
        for img_file in rendered:
            page_txt = ocr_image(Path(img_file))
            if page_txt.strip():
                ocr_pages.append(page_txt)
        full_ocr = "\n".join(ocr_pages).strip()
        if not full_ocr:
            raise IllegibleDocumentError(
                f"El PDF escaneado '{pdf_path.name}' no contiene texto legible."
            )
        return full_ocr, "pdf_ocr", warnings


def _is_illegible_line(text: str, cfg: MatchingConfig) -> tuple[bool, str]:
    """Detecta líneas corruptas o ilegibles producto de mal OCR o texto dañado."""
    cleaned = text.strip()
    if len(cleaned) < cfg.illegible_min_length:
        return True, "Texto demasiado corto o fragmentado"

    if "???" in cleaned or "###" in cleaned or "□" in cleaned or "\ufffd" in cleaned:
        return True, "Caracteres ilegibles detectados por OCR"

    alnum_chars = sum(1 for c in cleaned if c.isalnum())
    alpha_chars = sum(1 for c in cleaned if c.isalpha())
    non_space = sum(1 for c in cleaned if not c.isspace())

    if non_space == 0:
        return True, "Línea vacía"
    if alpha_chars / non_space < cfg.illegible_min_alpha_ratio:
        return True, "Proporción insuficiente de letras (posible ruido de escaneo)"
    if alnum_chars < 3:
        return True, "Contenido insuficiente para identificar un producto"

    return False, ""


def _parse_quantity_and_unit(body: str) -> tuple[float, str, str]:
    """Extrae cantidad, unidad opcional y descripción limpia de una línea."""
    text = body.strip()

    # 1. Cantidad numérica fraccionaria o decimal al inicio (ej: "2 cuadernos", "1/2 ciento")
    frac_match = re.match(r"^(\d+)\s*/\s*(\d+)\s+(.*)$", text)
    if frac_match:
        num, den, rest = float(frac_match.group(1)), float(frac_match.group(2)), frac_match.group(3)
        qty = round(num / den, 2) if den > 0 else 1.0
        unit, desc = _extract_unit(rest)
        return qty, unit, desc

    num_match = re.match(r"^(\d+(?:[.,]\d+)?)\s*(?:x\s+)?(.*)$", text, re.IGNORECASE)
    if num_match:
        qty = float(num_match.group(1).replace(",", "."))
        rest = num_match.group(2).strip()
        unit, desc = _extract_unit(rest)
        return qty, unit, desc

    # 2. Cantidad en palabras en español
    lower = text.lower()
    for word, val in sorted(SPANISH_NUMBERS.items(), key=lambda kv: len(kv[0]), reverse=True):
        m = re.match(rf"^{re.escape(word)}\b\s*(?:de\s+)?(.*)$", lower)
        if m:
            rest = text[m.start(1) :].strip()
            unit, desc = _extract_unit(rest)
            return val, unit, desc

    unit, desc = _extract_unit(text)
    return 1.0, unit, desc


def _extract_unit(text: str) -> tuple[str, str]:
    m = re.match(rf"^({UNITS_PATTERN})\b(?:\s+de)?\s+(.*)$", text.strip(), re.IGNORECASE)
    if m:
        return m.group(1).lower().rstrip("."), m.group(2).strip()
    return "und", text.strip()


def parse_school_list_text(
    raw_text: str,
    cfg: MatchingConfig,
    source_path: str = "<texto>",
    method: str = "text",
    warnings: list[str] | None = None,
) -> ExtractionResult:
    """Convierte texto crudo de lista escolar en ítems estructurados e ítems ilegibles."""
    items: list[ParsedItem] = []
    illegible: list[IllegibleItem] = []
    warns = list(warnings or [])

    for idx, raw_line in enumerate(raw_text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue

        # Ignorar encabezados escolares sin ítems
        if HEADER_NOISE_RE.match(line) and not re.search(r"\d+\s+\w+", line):
            continue

        # Quitar viñetas o numeración de lista ("1. ", "2) ", "• ", "- ")
        without_bullet = re.sub(r"^\s*(?:\d+[.)]\s*|[-•*▪▫►]+\s*)", "", line).strip()
        if not without_bullet:
            illegible.append(IllegibleItem(idx, line, "Solo viñeta o numeración sin descripción"))
            continue

        is_bad, reason = _is_illegible_line(without_bullet, cfg)
        if is_bad:
            illegible.append(IllegibleItem(idx, line, reason, confidence=0.1))
            continue

        qty, unit, desc = _parse_quantity_and_unit(without_bullet)
        is_bad_desc, reason_desc = _is_illegible_line(desc, cfg)
        if is_bad_desc or qty <= 0:
            illegible.append(
                IllegibleItem(
                    idx,
                    line,
                    reason_desc or "Cantidad inválida o descripción ilegible",
                    confidence=0.2,
                )
            )
            continue

        items.append(
            ParsedItem(
                line_number=idx,
                raw_text=line,
                quantity=qty,
                unit=unit,
                description=desc,
                confidence=0.95 if method == "pdf_text" else 0.85,
            )
        )

    if not items and not illegible:
        raise IllegibleDocumentError("El documento no contiene texto ni líneas procesables.")

    return ExtractionResult(
        source_path=source_path,
        method=method,
        raw_text=raw_text,
        items=items,
        illegible_items=illegible,
        warnings=warns,
    )


def extract_school_list(file_path: str | Path, cfg: MatchingConfig) -> ExtractionResult:
    """Procesa una imagen o PDF y extrae los ítems de la lista escolar."""
    path = Path(file_path)
    if not path.exists() or not path.is_file():
        raise UnsupportedFormatError(f"El archivo no existe: {path}")

    ext = path.suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        raw_text = ocr_image(path)
        if not raw_text.strip():
            raise IllegibleDocumentError(
                f"No se pudo reconocer texto legible en la imagen '{path.name}'."
            )
        return parse_school_list_text(raw_text, cfg, source_path=str(path), method="image_ocr")

    if ext in PDF_EXTENSIONS:
        raw_text, method, warnings = extract_text_from_pdf(path)
        return parse_school_list_text(
            raw_text, cfg, source_path=str(path), method=method, warnings=warnings
        )

    raise UnsupportedFormatError(
        f"Formato no soportado '{ext}'. Use imágenes ({', '.join(sorted(IMAGE_EXTENSIONS))}) o PDF."
    )
