// The Interveil API key, when the server requires one, lives in sessionStorage
// for the tab's lifetime and is sent on every REST call and WebSocket connect.
const STORAGE_KEY = 'interveil-api-key';

export function getApiKey(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveApiKey(key: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // storage unavailable — the key only lasts until reload
  }
}

export function apiFetch(path: string): Promise<Response> {
  const key = getApiKey();
  return fetch(path, { headers: key ? { 'x-interveil-key': key } : {} });
}
