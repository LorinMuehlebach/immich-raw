// Immich API setup. Default: same-origin session cookie (the editor is served under the
// Immich domain). Fallback: an API key kept in localStorage (dev server, other hosts).
import {
  defaults,
  getBaseUrl,
  getMyUser,
  getServerVersion,
  init,
  isHttpError,
  setApiKey as sdkSetApiKey,
  type ServerVersionResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';

const API_KEY_STORAGE = 'raw-editor.apiKey';
export const SUPPORTED_SERVER = { major: 3 } as const;

let apiKey: string | null = null;

function readStoredKey(): string | null {
  try {
    return localStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

function applyKey(key: string | null): void {
  apiKey = key && key.trim() ? key.trim() : null;
  if (apiKey) {
    sdkSetApiKey(apiKey);
  } else if (defaults.headers) {
    // setApiKey(undefined) would send the literal string "undefined".
    delete (defaults.headers as Record<string, unknown>)['x-api-key'];
  }
}

export function apiBaseUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_IMMICH_API ?? '/api';
}

export function initApi(): void {
  init({ baseUrl: apiBaseUrl(), apiKey: '' });
  applyKey(readStoredKey());
}

/** Stores (or with null, removes) the API key and applies it to all further requests. */
export function setApiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // storage blocked: the key still applies for this page load
  }
  applyKey(key);
}

export function hasApiKey(): boolean {
  return apiKey !== null;
}

/** Headers for raw fetch/XHR calls that bypass the SDK. */
export function authHeaders(): Record<string, string> {
  return apiKey ? { 'x-api-key': apiKey } : {};
}

/** Absolute-or-relative URL for an API path such as "/assets/123/original". */
export function apiUrl(path: string): string {
  return `${getBaseUrl()}${path}`;
}

/** The logged-in user, or null when not authenticated (401/403). */
export async function getSession(): Promise<UserAdminResponseDto | null> {
  try {
    return await getMyUser();
  } catch (e) {
    if (isHttpError(e) && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

export async function getServerVersionInfo(): Promise<ServerVersionResponseDto> {
  return getServerVersion();
}

/** A warning to show when the server is outside the tested range, or null. */
export function serverVersionWarning(v: ServerVersionResponseDto): string | null {
  if (v.major !== SUPPORTED_SERVER.major) {
    return `This editor is tested with Immich ${SUPPORTED_SERVER.major}.x; the server runs ${v.major}.${v.minor}.${v.patch}. Saving may not work.`;
  }
  return null;
}

/** HTTP status of an SDK error, or undefined for other errors. */
export function httpStatus(e: unknown): number | undefined {
  return isHttpError(e) ? e.status : undefined;
}
