// Blog feed from Hashnode (RSS today, GraphQL if it ever reopens). Called from app.js; platform-independent.
//
// handler({ queryStringParameters }) -> { statusCode, headers, body }
//   no slug -> { posts, hasNextPage, endCursor };  slug=my-post -> a single post
//
// Source order: GraphQL API (only if HASHNODE_TOKEN is set), then the public RSS feed as a fallback.
// Hashnode currently redirects the GraphQL endpoint to an announcement page, so RSS is what serves posts today.
// Config comes from plain environment variables:
//   HASHNODE_HOST   required, e.g. "yourname.hashnode.dev"
//   HASHNODE_TOKEN  optional, personal access token for the GraphQL API
const { XMLParser } = require("fast-xml-parser");

const ENDPOINT = "https://gql.hashnode.com";

const POST_FIELDS = `
  id slug title brief publishedAt readTimeInMinutes
  coverImage { url }
  tags { name slug }
`;

const LIST_QUERY = `
  query Posts($host: String!, $first: Int!, $after: String) {
    publication(host: $host) {
      posts(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges { node { ${POST_FIELDS} } }
      }
    }
  }`;

const POST_QUERY = `
  query Post($host: String!, $slug: String!) {
    publication(host: $host) {
      post(slug: $slug) {
        ${POST_FIELDS}
        content { html }
        seo { title description }
      }
    }
  }`;

const json = (statusCode, body, cache = "public, max-age=60, s-maxage=300, stale-while-revalidate=600") => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": cache },
  body: JSON.stringify(body),
});

async function gql(query, variables) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.HASHNODE_TOKEN) headers.Authorization = process.env.HASHNODE_TOKEN;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    redirect: "manual", // Hashnode answers blocked requests with a redirect to an HTML page
    body: JSON.stringify({ query, variables }),
  });
  if (!(res.headers.get("content-type") || "").includes("json")) {
    throw new Error(`Hashnode GraphQL unavailable (${res.status})`);
  }
  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error(data.errors?.[0]?.message || `Hashnode responded ${res.status}`);
  }
  return data.data;
}

// ---------- RSS fallback ----------
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: true });
const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (typeof v === "object" && v !== null ? v["#text"] ?? "" : v ?? "").toString();
const stripTags = (html) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function slugFromLink(link) {
  try {
    return new URL(link).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function parseFeed(xml) {
  const channel = parser.parse(xml)?.rss?.channel || {};
  return arr(channel.item)
    .map((it) => {
      const html = text(it["content:encoded"]) || text(it.description);
      const words = stripTags(html).split(" ").filter(Boolean).length;
      const cover = it.enclosure?.["@_url"] || null;
      const brief = stripTags(text(it.description)) || stripTags(html).slice(0, 200);
      return {
        id: text(it.guid) || text(it.link),
        slug: slugFromLink(text(it.link)),
        title: text(it.title),
        brief: brief.length > 220 ? brief.slice(0, 217) + "…" : brief,
        publishedAt: new Date(text(it.pubDate) || Date.now()).toISOString(),
        readTimeInMinutes: Math.max(1, Math.round(words / 200)),
        coverImage: cover ? { url: cover } : null,
        tags: arr(it.category).map((c) => ({ name: text(c), slug: text(c).toLowerCase().replace(/[^a-z0-9]+/g, "-") })),
        content: { html },
        seo: null,
      };
    })
    .filter((p) => p.slug);
}

async function loadFeed(host) {
  const res = await fetch(`https://${host}/rss.xml`);
  if (!res.ok) throw new Error(`RSS responded ${res.status}`);
  return parseFeed(await res.text());
}

const toSummary = ({ content, seo, ...rest }) => rest;

exports.handler = async (event) => {
  const host = process.env.HASHNODE_HOST;
  if (!host) {
    console.error("HASHNODE_HOST is not set: cannot load blog posts");
    return json(500, { error: "HASHNODE_HOST is not configured" }, "no-store");
  }

  const { slug, after } = event.queryStringParameters || {};
  if (slug && !/^[a-z0-9-_]+$/i.test(slug)) return json(400, { error: "Invalid slug" }, "no-store");

  try {
    // 1. GraphQL, only when a token is configured
    if (process.env.HASHNODE_TOKEN) {
      try {
        if (slug) {
          const post = (await gql(POST_QUERY, { host, slug })).publication?.post;
          return post ? json(200, post) : json(404, { error: "Post not found" }, "public, max-age=60");
        }
        const posts = (await gql(LIST_QUERY, { host, first: 12, after: after || null })).publication?.posts;
        return json(200, {
          posts: (posts?.edges || []).map((e) => e.node),
          hasNextPage: !!posts?.pageInfo?.hasNextPage,
          endCursor: posts?.pageInfo?.endCursor || null,
        });
      } catch (err) {
        console.warn("GraphQL failed, falling back to RSS:", err.message);
      }
    }

    // 2. RSS fallback (no pagination: the feed already holds the latest posts)
    const items = await loadFeed(host);
    if (slug) {
      const post = items.find((p) => p.slug === slug);
      return post ? json(200, post) : json(404, { error: "Post not found" }, "public, max-age=60");
    }
    return json(200, { posts: items.map(toSummary), hasNextPage: false, endCursor: null });
  } catch (err) {
    console.error(err);
    return json(502, { error: "Could not load posts right now" }, "no-store");
  }
};

exports.parseFeed = parseFeed;
