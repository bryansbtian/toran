<!-- SPDX-License-Identifier: MIT -->

# Storage configuration

Toran works with any S3-compatible object storage through the `StorageProvider`
interface. Two rules apply everywhere:

1. **The bucket must be private.** Toran never relies on public objects.
2. **CORS must allow `PUT` from your application origin**, because browsers
   upload directly to storage.

## Object layout

```text
objects/{random-id}      live objects
quarantine/{random-id}   blocked files, retained for investigation
```

Keys are 18 random bytes (144 bits) encoded base64url. **The user-provided
filename never influences the key.** Every storage call validates the key
against a strict pattern first, so a corrupted database value cannot address an
arbitrary object.

The original filename is stored as metadata and reapplied at download time
through presigned response overrides.

## Provider configuration

### MinIO (default)

```bash
S3_ENDPOINT=http://minio:9000          # used for signing, in-cluster
S3_PUBLIC_ENDPOINT=https://files.example.com   # where the browser is sent
S3_REGION=us-east-1
S3_BUCKET=toran
S3_FORCE_PATH_STYLE=true
```

Only the origin is rewritten between the two, so the signature stays valid.

CORS is set with an environment variable on the MinIO container:

```yaml
environment:
  MINIO_API_CORS_ALLOW_ORIGIN: https://toran.example.com
```

### AWS S3

```bash
S3_ENDPOINT=
S3_PUBLIC_ENDPOINT=
S3_REGION=eu-west-1
S3_BUCKET=my-toran-bucket
S3_FORCE_PATH_STYLE=false
```

Bucket CORS:

```json
[
  {
    "AllowedOrigins": ["https://toran.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Minimum IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::my-toran-bucket/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-toran-bucket"
    }
  ]
}
```

Also enable **Block Public Access** on the bucket, and add a lifecycle rule
expiring `quarantine/` after your retention period.

### Cloudflare R2

```bash
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_PUBLIC_ENDPOINT=https://files.example.com   # an R2 custom domain
S3_REGION=auto
S3_FORCE_PATH_STYLE=false
```

R2 has no egress fees, which suits a file-sharing service well. Configure CORS
in the R2 dashboard.

### Backblaze B2

```bash
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
S3_REGION=us-west-004
S3_FORCE_PATH_STYLE=false
```

Use an application key scoped to the single bucket, not the master key.

### Other providers

Wasabi, Ceph RGW, Garage, SeaweedFS and Scaleway all work. Set `S3_ENDPOINT` and
choose path style per their documentation (self-hosted implementations usually
need `S3_FORCE_PATH_STYLE=true`).

## Verifying your configuration

```bash
# 1. The bucket must NOT be publicly readable.
curl -I https://files.example.com/toran/objects/anything   # expect 403 or 404

# 2. Listing must not be public.
curl https://files.example.com/toran/                       # expect 403

# 3. Toran can reach it.
curl -fsS https://toran.example.com/api/ready | jq '.checks.storage'

# 4. CORS preflight succeeds.
curl -i -X OPTIONS "https://files.example.com/toran/objects/test" \
  -H "Origin: https://toran.example.com" \
  -H "Access-Control-Request-Method: PUT"
```

## Upload size limits

The MVP uses **single-request uploads**: one `PUT` carries the whole file.

- Practical ceiling is whatever a browser and network will hold open. 100 MiB is
  a comfortable default; a few GiB works on a good connection.
- **There is no resume.** A dropped connection means starting over.
- AWS S3's hard limit for a single `PUT` is 5 GiB.
- Reverse proxies need `client_max_body_size` (nginx) or equivalent raised, and
  request buffering disabled, on the storage hostname.

`StorageProvider` is shaped so multipart and resumable uploads can be added
without changing any caller.

## Content-Disposition support

Toran sets the download filename with `ResponseContentDisposition` on the
presigned `GET`. Most providers honour it. If yours does not, downloads will use
the random object id as the filename - please open an issue naming the provider.

Verified working: MinIO, AWS S3, Cloudflare R2, Backblaze B2.
