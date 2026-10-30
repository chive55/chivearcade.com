# Devlog posts

Add a new post as a Markdown file in `posts/`.

1. Create `posts/YYYY-MM-DD-slug.md` with YAML frontmatter (`title`, `date`, `slug`, optional `tags`, `cover`, `coverWidth`, `coverHeight`, `coverAlt`, `excerpt`).
2. Put body copy under the closing `---`. Keep post copy as approved; the generator does not invent text.
3. Optional cover: drop an image in `/devlog/assets/` and set `cover` to that path. Without a cover, the index uses the fixed placeholder.
4. Run `node scripts/build-devlog.mjs` from the repo root.
5. Commit both the Markdown source and the generated files under `/devlog/` (plus `sitemap.xml`).

Images in a post body: `![Alt text](/devlog/assets/file.gif){640x360}` (width x height required for CLS). GIFs and PNGs are fine; they load lazy on post pages.
