declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    REGISTRY_ADMIN_KEY?: string;
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ZONE_ID?: string;
  }
}
