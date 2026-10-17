// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";

const repository = "https://github.com/karamouche/ushelf";

export default defineConfig({
  // GitHub Pages serves the project site under /ushelf; override both for other hosts.
  site: process.env.DOCS_SITE ?? "https://karamouche.github.io",
  base: process.env.DOCS_BASE ?? "/ushelf",
  // The site only ships SVGs, which need no raster optimization.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "uShelf",
      description: "A local, agent-native library for the writing worth keeping.",
      social: [{ icon: "github", label: "GitHub", href: repository }],
      editLink: { baseUrl: `${repository}/edit/main/apps/docs/` },
      lastUpdated: true,
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quick start", slug: "getting-started/quick-start" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Architecture", slug: "concepts/architecture" },
            { label: "Library and storage", slug: "concepts/library" },
            { label: "Capture and enrichment", slug: "concepts/capture-and-enrichment" },
          ],
        },
        {
          label: "Deploy",
          items: [
            { label: "Overview", slug: "deploy/overview" },
            { label: "Local Docker", slug: "deploy/local" },
            { label: "Docker host over SSH", slug: "deploy/ssh" },
            { label: "Fly.io", slug: "deploy/fly" },
            { label: "Self-hosted and Compose", slug: "deploy/self-hosted" },
            { label: "Security model", slug: "deploy/security" },
          ],
        },
        {
          label: "Agents",
          items: [
            { label: "Connect an agent", slug: "agents/connect" },
            { label: "Skills and recipes", slug: "agents/skills-and-recipes" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Send to Kindle", slug: "guides/kindle" },
            { label: "Maintenance and backups", slug: "guides/maintenance" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "reference/cli" },
            { label: "Configuration", slug: "reference/configuration" },
            { label: "MCP tools", slug: "reference/mcp" },
            { label: "HTTP API", slug: "reference/http-api" },
          ],
        },
        {
          label: "Development",
          items: [
            { label: "Contributing", slug: "development/contributing" },
            { label: "Releasing", slug: "development/releasing" },
          ],
        },
      ],
    }),
  ],
});
