import fetch from 'node-fetch';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_DIR = join(ROOT, 'posts');
const META_PATH = join(POSTS_DIR, 'sync-meta.json');

const VELOG_API = 'https://v2.velog.io/graphql';
const USERNAME = process.env.VELOG_USERNAME;
const DRY_RUN = process.argv.includes('--dry-run');
const POST_DELAY_MS = 150;

if (!USERNAME) {
  console.error('Error: VELOG_USERNAME environment variable is required');
  process.exit(1);
}

// ── GraphQL queries ──────────────────────────────────────────────────────────

const POSTS_QUERY = `
  query Posts($username: String!, $cursor: ID) {
    posts(username: $username, cursor: $cursor) {
      id
      title
      url_slug
      updated_at
      released_at
    }
  }
`;

const POST_DETAIL_QUERY = `
  query Post($username: String!, $slug: String!) {
    post(username: $username, url_slug: $slug) {
      id
      title
      body
      tags
      updated_at
      released_at
      thumbnail
    }
  }
`;

// ── API helpers ──────────────────────────────────────────────────────────────

async function gql(query, variables, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(VELOG_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data, errors } = await res.json();
      if (errors?.length) throw new Error(errors[0].message);
      return data;
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = 500 * 2 ** (attempt - 1);
      console.warn(`  Retry ${attempt}/${retries - 1} after ${wait}ms — ${err.message}`);
      await sleep(wait);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Fetch all posts with pagination ─────────────────────────────────────────

async function fetchAllPosts() {
  const all = [];
  let cursor = undefined;

  while (true) {
    const data = await gql(POSTS_QUERY, { username: USERNAME, cursor });
    const page = data.posts;
    if (!page?.length) break;
    all.push(...page);
    cursor = page[page.length - 1].id;
    if (page.length < 20) break; // velog returns max 20 per page
  }

  return all;
}

// ── File helpers ─────────────────────────────────────────────────────────────

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function slugToFilename(slug) {
  return `${slug}.md`;
}

function buildFrontmatter(post) {
  const tags = (post.tags || []).map((t) => `"${t}"`).join(', ');
  return [
    '---',
    `title: "${post.title.replace(/"/g, '\\"')}"`,
    `date: "${post.released_at}"`,
    `updated: "${post.updated_at}"`,
    `tags: [${tags}]`,
    post.thumbnail ? `thumbnail: "${post.thumbnail}"` : null,
    `velog_url: "https://velog.io/@${USERNAME}/${post.url_slug}"`,
    '---',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function buildMarkdown(post) {
  return buildFrontmatter(post) + post.body;
}

function loadMeta() {
  if (!existsSync(META_PATH)) return { lastSync: null, posts: {} };
  return JSON.parse(readFileSync(META_PATH, 'utf8'));
}

function saveMeta(meta) {
  if (DRY_RUN) return;
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

function writePost(slug, content) {
  if (DRY_RUN) return;
  writeFileSync(join(POSTS_DIR, slugToFilename(slug)), content, 'utf8');
}

function deletePost(slug) {
  const path = join(POSTS_DIR, slugToFilename(slug));
  if (existsSync(path)) {
    if (!DRY_RUN) unlinkSync(path);
    return true;
  }
  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Syncing Velog posts for @${USERNAME}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const meta = loadMeta();
  const apiPosts = await fetchAllPosts();
  console.log(`Found ${apiPosts.length} posts on Velog`);

  const apiSlugs = new Set(apiPosts.map((p) => p.url_slug));
  let created = 0, updated = 0, deleted = 0, skipped = 0;

  // ── Detect deleted posts ────────────────────────────────────────────────
  for (const slug of Object.keys(meta.posts)) {
    if (!apiSlugs.has(slug)) {
      console.log(`  [DELETE] ${slug}`);
      deletePost(slug);
      delete meta.posts[slug];
      deleted++;
    }
  }

  // ── Sync each post ──────────────────────────────────────────────────────
  for (const post of apiPosts) {
    const slug = post.url_slug;
    const existing = meta.posts[slug];
    const isNew = !existing;
    const isUpdated = existing && existing.updated_at !== post.updated_at;

    if (!isNew && !isUpdated) {
      skipped++;
      continue;
    }

    console.log(`  [${isNew ? 'NEW' : 'UPDATE'}] ${slug}`);

    await sleep(POST_DELAY_MS);

    let detail;
    try {
      const data = await gql(POST_DETAIL_QUERY, { username: USERNAME, slug });
      detail = data.post;
    } catch (err) {
      console.error(`  Failed to fetch detail for ${slug}: ${err.message}`);
      continue;
    }

    const content = buildMarkdown({ ...detail, url_slug: slug });
    const hash = sha256(content);

    // Double-check with hash even if updated_at matched (edge case guard)
    if (!isNew && existing.hash === hash) {
      meta.posts[slug].updated_at = post.updated_at;
      skipped++;
      continue;
    }

    writePost(slug, content);
    meta.posts[slug] = { updated_at: post.updated_at, hash };
    isNew ? created++ : updated++;
  }

  const hasChanges = created > 0 || updated > 0 || deleted > 0;
  if (hasChanges) {
    meta.lastSync = new Date().toISOString();
  }
  saveMeta(meta);

  console.log(
    `\nDone — created: ${created}, updated: ${updated}, deleted: ${deleted}, skipped: ${skipped}`
  );
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
