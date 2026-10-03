/** Set once to the CURRENT admin key before rotating the admin password. */
export function authSecret() {
  const secret = process.env.REGISTRY_AUTH_SECRET || process.env.REGISTRY_ADMIN_KEY;
  if (!secret || secret === '[SENSITIVE]') throw new Error('Registry authentication is not configured.');
  return secret;
}
