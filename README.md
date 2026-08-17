# Colección Magic en venta

Sitio web estático para vender una colección de Magic. Vos mantenés tu **Google Sheet** de siempre; un script (en GitHub Actions) lo cruza con **Scryfall** (tipo + imágenes), **Card Kingdom** (precio NM, match exacto por `scryfall_id`) y la **cotización del BROU** (USD→UYU), y publica todo en **GitHub Pages**. Cualquiera con el link arma su pedido y te lo manda por WhatsApp.

- **Sin backend**: es HTML/CSS/JS puro. El pedido de cada visitante vive en su propio navegador.
- **Automático**: se actualiza 1 vez por día y también con un botón manual "Run workflow".
- **Match de precios exacto**: por `scryfall_id` + foil, sin depender de nombres de edición.

---

## Puesta en marcha (una sola vez)

### 1. Crear la cuenta de servicio de Google (para leer el Sheet)

1. Entrá a <https://console.cloud.google.com/> y creá un proyecto (o usá uno existente).
2. Habilitá la **Google Sheets API**: *APIs y servicios → Biblioteca → "Google Sheets API" → Habilitar*.
3. Creá una **cuenta de servicio**: *APIs y servicios → Credenciales → Crear credenciales → Cuenta de servicio*. Ponele cualquier nombre.
4. En la cuenta creada → pestaña **Claves → Agregar clave → Crear clave nueva → JSON**. Se descarga un archivo `.json`. **Guardalo, es la credencial.**
5. Abrí ese JSON y copiá el valor de `client_email` (algo como `...@...iam.gserviceaccount.com`).
6. En tu **Google Sheet**, botón **Compartir** y agregá ese `client_email` como **Lector**. (Así la cuenta puede leer la hoja.)

### 2. Configurar el repo

1. En `config.json`, pegá el **ID de tu Sheet** en `sheetId`. El ID está en la URL del Sheet:
   `https://docs.google.com/spreadsheets/d/`**`ESTE_ES_EL_ID`**`/edit`
   Ajustá `sheetRange` si tu pestaña no se llama `Sheet1` (por ej. `Hoja 1`).
2. En `public/site.config.json`, poné tu **número de WhatsApp** en `whatsappNumber` (formato internacional sin `+` ni espacios, ej. `59891234567`), el nombre de la tienda y el texto de saludo.

### 3. Subir a GitHub y activar Pages

1. Creá un repo **público** en GitHub y subí este proyecto:
   ```bash
   git add -A
   git commit -m "Sitio inicial"
   git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
   git push -u origin main
   ```
2. **Secret con la credencial de Google**: en el repo → *Settings → Secrets and variables → Actions → New repository secret*.
   - Nombre: `GOOGLE_SERVICE_ACCOUNT_JSON`
   - Valor: pegá **todo el contenido** del archivo `.json` que descargaste en el paso 1.
3. **Permisos de Actions**: *Settings → Actions → General → Workflow permissions* → marcá **Read and write permissions** (para que el workflow pueda commitear los datos y publicar).
4. **Activar Pages**: *Settings → Pages → Build and deployment → Source* → elegí **GitHub Actions**.
5. Corré el workflow por primera vez: *pestaña Actions → "Actualizar datos y publicar" → Run workflow*.

Cuando termine, tu sitio queda en `https://TU_USUARIO.github.io/TU_REPO/`.

---

## Uso diario

- **Cargás/editás cartas** en tu Google Sheet como siempre.
- Se actualiza solo 1 vez por día. Si querés forzarlo ya: *Actions → Run workflow*.
- **Cuando vendés una carta**: poné su `Quantity` en 0 en el Sheet y corré el workflow. La carta aparece como *Agotada* (atenuada) para el resto.

### Cartas sin precio

Card Kingdom cubre la enorme mayoría. Las que no matchee quedan listadas en
`public/data/reporte-sin-precio.json` después de cada corrida. Si querés ponerles precio a mano,
editá `data/overrides-precio.json`:

```json
{
  "prices": {
    "SCRYFALL_ID_DE_LA_CARTA": 12.5,
    "SCRYFALL_ID_DE_LA_CARTA:foil": 30.0
  }
}
```

El `SCRYFALL_ID` es la columna **Scryfall ID** de tu Sheet. Usá `:foil` para la versión foil.
El precio es en **USD (NM)**. En la próxima corrida el sistema respeta esos valores.

### Cotización

Se toma la **venta del BROU** desde `uy.dolarapi.com`. Si ese día la fuente falla, se reusa la última
cotización guardada (`data/cotizacion-cache.json`) y el sitio la muestra marcada como *desactualizada*.
Podés forzar un valor con el secret opcional `COTIZACION_USD_UYU` (ver el workflow).

---

## Estructura

```
config.json                     ID del Sheet + nombres de columnas (no secreto)
service-account.json            credencial de Google (SOLO local; en .gitignore)
data/
  overrides-precio.json         precios cargados a mano (excepciones)
  cotizacion-cache.json         última cotización buena (se actualiza sola)
scripts/
  build-data.js                 orquesta todo el build
  lib/{sheets,scryfall,cardkingdom,cotizacion}.js
public/                         <- lo que se publica en GitHub Pages
  index.html  app.js  styles.css
  site.config.json              nombre, WhatsApp, etc. (visible)
  data/
    cards.json                  lo que consume la web (generado)
    reporte-sin-precio.json     cartas sin match (generado)
    meta.json                   metadatos: fecha, cotización (generado)
.github/workflows/update-data.yml   corre diario + botón manual
```

## Correr el build en tu máquina (opcional)

Solo si querés generar los datos localmente (necesitás Node 20+ instalado):

```bash
npm install
# poné el service-account.json en la raíz del repo, luego:
npm run build
```

## Notas

- El repo es **público** (requisito de GitHub Pages gratis): `cards.json` con tus cartas, cantidades y
  precios queda descargable por cualquiera que tenga el link. El **ManaBox ID no se publica**.
- La cotización del BROU puede tener 1 día de atraso si la fuente falla ese día (se muestra la fecha usada).
