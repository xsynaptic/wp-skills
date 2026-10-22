// Copy to sites/<name>/local/smoke-targets.ts and point this import at the skill's scripts/config.ts
// Node erases type imports, so only the type checker reads that path
import type { SmokeTargets } from "./config.ts";

export default {
  deep: [
    { label: "page", marker: "page-id-12", path: "/about/" },
    {
      label: "post, oldest era",
      marker: "postid-56",
      path: "/2012/03/an-old-post/",
    },
    { label: "tag", marker: "tag-example", path: "/tag/example/" },
    { label: "author", marker: "author-editor", path: "/author/editor/" },
    { label: "date archive", marker: "date", path: "/2024/05/" },
    { label: "search", marker: "search-results", path: "/?s=example" },
    {
      label: "404",
      marker: "error404",
      path: "/no-such-page-smoke/",
      status: 404,
    },
    { label: "feed", marker: "<rss", path: "/feed/" },
    { label: "sitemap", marker: "<sitemapindex", path: "/wp-sitemap.xml" },
    { label: "rest root", marker: '"namespaces"', path: "/wp-json/" },
    {
      body: { action: "theme_live_search", s: "example" },
      label: "live search",
      marker: "search-result-item",
      method: "POST",
      path: "/wp-admin/admin-ajax.php",
    },
    {
      isAdmin: true,
      label: "posts list",
      marker: "wp-list-table",
      path: "/wp-admin/edit.php",
    },
    {
      isAdmin: true,
      label: "post edit",
      marker: "post_ID",
      path: "/wp-admin/post.php?post=1234&action=edit",
    },
    {
      isAdmin: true,
      label: "customizer",
      marker: "customize-controls",
      path: "/wp-admin/customize.php",
    },
    {
      isAdmin: true,
      label: "plugins",
      marker: "wp-list-table",
      path: "/wp-admin/plugins.php",
    },
    {
      isAdmin: true,
      label: "site health",
      marker: "health-check",
      path: "/wp-admin/site-health.php",
    },
    // The slug alone sits in the admin menu on every page, so the marker is markup only this screen renders
    {
      isAdmin: true,
      label: "a plugin's screen",
      marker: 'id="example-plugin-settings"',
      path: "/wp-admin/admin.php?page=example-plugin",
    },
  ],
  required: [
    { label: "home", marker: 'class="home ', path: "/" },
    { label: "post", marker: "postid-1234", path: "/2024/05/a-recent-post/" },
    { label: "category", marker: "category-news", path: "/category/news/" },
  ],
} satisfies SmokeTargets;
