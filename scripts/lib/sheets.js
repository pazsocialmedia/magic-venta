// Lectura del Google Sheet mediante una cuenta de servicio (service account).
//
// Credencial (elegi UNA):
//   - Local:  archivo service-account.json en la raiz del repo (esta en .gitignore).
//   - CI:     env GOOGLE_SERVICE_ACCOUNT_JSON con el contenido del JSON de la cuenta.
//
// La hoja debe estar COMPARTIDA (aunque sea como lector) con el email de la
// cuenta de servicio (client_email del JSON).

import fs from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

async function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  try {
    const path = new URL('../../service-account.json', import.meta.url);
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    throw new Error(
      'No encontre credenciales: defini GOOGLE_SERVICE_ACCOUNT_JSON o crea service-account.json en la raiz.',
    );
  }
}

async function getAccessToken() {
  const credentials = await loadCredentials();
  const auth = new GoogleAuth({ credentials, scopes: SCOPES });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('No pude obtener access token de Google.');
  return token;
}

// Devuelve los nombres (titles) de todas las pestañas del spreadsheet, en orden.
export async function getSheetTitles(sheetId) {
  const token = await getAccessToken();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
}

// Devuelve un array de objetos-fila usando la primera fila como encabezados.
export async function readSheet(sheetId, range) {
  const token = await getAccessToken();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const rows = data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
}

// Lee una pestaña opcional de "clave | valor" (dos columnas, sin encabezado).
// Devuelve un objeto { clave: valor }. Si la pestaña no existe, devuelve {} sin romper.
export async function readKeyValueTab(sheetId, tab) {
  if (!tab) return {};
  const token = await getAccessToken();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(tab)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // 400 tipico cuando la pestaña no existe: lo ignoramos.
    return {};
  }
  const data = await res.json();
  const out = {};
  for (const row of data.values || []) {
    const key = String(row[0] ?? '').trim();
    if (!key || key.startsWith('#')) continue;
    out[key] = String(row[1] ?? '').trim();
  }
  return out;
}
