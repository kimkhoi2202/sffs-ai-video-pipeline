# Media hosting for the SFFS video pipeline (host-swappable)

> **Publer is retired (2026-07-28).** Every mention of Publer below is historical.
> Posting, the live calendar and analytics all run on Metricool now — see
> [`docs/hermes/metricool-migration.md`](../docs/hermes/metricool-migration.md).

Rendered shorts are posted via **Publer**, which imports media **by URL only** — it
cannot take a local file. So every rendered short must live at a **public URL**.
This directory contains a small, dependency-free uploader that pushes a local file
to whichever object host is configured and prints the resulting public URL.

## TL;DR

| Thing | Value |
| --- | --- |
| Provider (now) | Supabase Storage |
| Supabase project | `qrggqoxqupqphirdscnw` — "Smart Fella or Fart Smella" (region `us-east-1`) |
| Bucket | `sffs-videos` (public **read**, 500 MB/file, mime `video/mp4`, `video/quicktime`, `video/webm`) |
| Public URL shape | `https://qrggqoxqupqphirdscnw.supabase.co/storage/v1/object/public/sffs-videos/<key>` |
| Uploader | `tools/upload-media.ts` (stdout = the public URL) |
| Provider switch | env `MEDIA_HOST=supabase\|s3\|r2` (supabase implemented; s3/r2 are stubs) |
| Secrets | **only** in env / a gitignored `.env`; never commit or print |

## Prerequisites

- **Node ≥ 23.6** runs the `.ts` file directly (tested on Node 26).
  On older Node use `npx tsx tools/upload-media.ts ...` instead of `node ...`.
- No `npm install` required for the Supabase provider — it uses only Node built-ins
  (`node:fs`, global `fetch`).

## Environment variables

Read entirely from the environment — nothing is hardcoded.

**Common**

| Var | Meaning |
| --- | --- |
| `MEDIA_HOST` | `supabase` (default), `s3`, or `r2` |
| `MEDIA_DEST_PREFIX` | optional folder prefix inside the bucket, e.g. `ready-to-post` |

**Supabase (current provider)**

| Var | Meaning |
| --- | --- |
| `SUPABASE_URL` | `https://qrggqoxqupqphirdscnw.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the project's **service_role** secret (or set `SUPABASE_KEY` as an alias) |
| `SUPABASE_BUCKET` | defaults to `sffs-videos` |

**AWS S3 (future — stub)**

`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_PUBLIC_BASE_URL`

**Cloudflare R2 (future — stub)**

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`

## Where credentials live

Create a **gitignored** `.env` (this repo already ignores `**/.env*`). Example:

```dotenv
MEDIA_HOST=supabase
SUPABASE_URL=https://qrggqoxqupqphirdscnw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=__PASTE_SERVICE_ROLE_SECRET_HERE__
SUPABASE_BUCKET=sffs-videos
```

Load it before running: `set -a; source .env; set +a`

### Getting the `service_role` key

Supabase Dashboard → project **Smart Fella or Fart Smella** → **Project Settings →
API → `service_role`** → copy the secret. It **bypasses Row Level Security**, so
treat it like a password: server-side / CLI use only, never in client code, never
committed. (The `anon`/publishable key is *not* sufficient — this bucket has no
public-write policy, so anon uploads are rejected by RLS. That's intentional.)

## Running the uploader

```bash
node tools/upload-media.ts <local-file> [dest-key]
```

- `<local-file>` — path to upload.
- `[dest-key]` — optional object key inside the bucket; defaults to the file's
  basename. Combined with `MEDIA_DEST_PREFIX` when set.
- **stdout** prints only the public URL (so it's easy to capture); diagnostics go
  to stderr.

Example — the three ready-to-post variants, all under `ready-to-post/`:

```bash
set -a; source .env; set +a
export MEDIA_DEST_PREFIX=ready-to-post
base=renders.nosync/videos/ready-to-post

node tools/upload-media.ts "$base/01-NOINTRO-oddone-figure-series/video.mp4"   01-NOINTRO-oddone-figure-series.mp4
node tools/upload-media.ts "$base/02-NOINTRO-analogy-series-figures/video.mp4" 02-NOINTRO-analogy-series-figures.mp4
node tools/upload-media.ts "$base/05-NOINTRO-series-analogy-sentence/video.mp4" 05-NOINTRO-series-analogy-sentence.mp4
```

Capture a URL programmatically:

```bash
url=$(node tools/upload-media.ts "$base/01-NOINTRO-oddone-figure-series/video.mp4" 01-NOINTRO-oddone-figure-series.mp4)
echo "$url"
```

## Verifying a URL is public + correct type

```bash
curl -sI "$url" | grep -iE '^HTTP/|^content-type'
# expect: HTTP/2 200  and  content-type: video/mp4
```

## Switching to R2 or S3 later (no rewrite)

The provider is a single entry in the `PROVIDERS` registry in
`tools/upload-media.ts`, and every provider returns the same result shape, so the
caller/Publer wiring never changes.

1. Set `MEDIA_HOST=r2` (or `s3`) and that provider's env vars (see above).
2. Fill in `uploadR2()` / `uploadS3()` in `tools/upload-media.ts`. The step-by-step
   recipe is in code comments next to each stub — both use `@aws-sdk/client-s3`
   (`npm i @aws-sdk/client-s3`); R2 is S3-compatible and only differs in the
   `endpoint` and the public base URL.
3. Provide a `*_PUBLIC_BASE_URL` (a CDN/custom domain you control) so the printed
   public URL stays stable. The stdout contract (one public URL) is unchanged, so
   nothing downstream needs to be touched.

## Security notes

- The bucket is public **read** (required so Publer can fetch). **Writes require
  the `service_role` key**; `storage.objects` has no anon-write policy (verified:
  0 policies → RLS default-denies anon writes).
- Secrets live only in env / a gitignored `.env`. Never commit keys or the videos
  (`renders.nosync/**/*.mp4` is already gitignored).

## Provisioning status

- ✅ Bucket `sffs-videos` created (public read, 500 MB/file, video mime types).
- ⏳ Test uploads: pending a `service_role` key in `.env` (see above). Once set,
  run the three commands under **Running the uploader** to produce the public URLs.
