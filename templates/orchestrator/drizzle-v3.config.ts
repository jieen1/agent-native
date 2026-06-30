// V3 uses a dedicated Postgres connection (server/db/v3.ts). The framework's
// built-in migrator only covers the V2 schema, so V3 tables are generated from
// this config. Output SQL is applied on startup by server/plugins/v3-migrate.ts.
// Plain object (no `defineConfig` import) so drizzle-kit can load it without
// drizzle-kit being a direct dependency of the template.
export default {
  schema: "./server/db/v3-schema.ts",
  dialect: "postgresql" as const,
  out: "./server/db/v3-migrations",
};
