export function getGcpCredentials(): object | undefined {
  const json = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!json) return undefined;
  try {
    return JSON.parse(json) as object;
  } catch {
    return undefined;
  }
}
