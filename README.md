# D'Kolor - Inventario y Cotización (GitHub Pages)

Web app estática (sin servidor) para:
- CRUD de **Productos** e **Inventario**
- CRUD de **Clientes**
- **Cotización** de lista de útiles escolares
- Exportar cotización a **PDF** y **Excel**
- Importar/Exportar tablas a **Excel**
- Respaldo en **JSON**

> Persistencia: `localStorage` (se guarda en el navegador).  
> Para sincronizar entre dispositivos se necesita un backend.

## Publicar en GitHub Pages
1. Crea un repo (ej: `dkolor-libreria`)
2. Sube todo el contenido de esta carpeta:
   - `index.html`
   - `assets/`
   - `data/`
3. En GitHub: **Settings → Pages**
   - Source: `Deploy from a branch`
   - Branch: `main` / `(root)`
4. Abre la URL que te da GitHub Pages.

## Importar tu Excel
En la pestaña **Importar / Exportar**:
- Selecciona tu archivo `.xlsm`/`.xlsx`
- Click en **Importar**
La app intentará leer las hojas **Productos** y **Clientes** con cabeceras iguales a tu archivo.

## Notas
- No ejecuta macros del `.xlsm` (por seguridad, el navegador no puede).
- Si tus cabeceras cambian, ajusta el parser en `assets/app.js`.


## Logo en PDF
- El PDF usa `assets/logo.jpg` (puedes reemplazar ese archivo por tu logo).
