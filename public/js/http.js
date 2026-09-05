async function parseJson(response) {
  return response.json().catch(() => ({}));
}

export function createApiClient({ onUnauthorized } = {}) {
  return async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });

    if (response.status === 401) {
      onUnauthorized?.();
      throw new Error('Unauthorized');
    }

    const data = await parseJson(response);
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  };
}

export async function publicApi(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await parseJson(response);
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
