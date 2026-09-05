export function upstreamError(error) {
  const data = error?.response?.data;
  if (data && typeof data === 'object') {
    return data.detail || data.message || error.message || 'Upstream request failed';
  }
  return error?.message || 'Upstream request failed';
}

export function sendUpstreamError(res, error, status = 502) {
  return res.status(status).json({ error: upstreamError(error) });
}
