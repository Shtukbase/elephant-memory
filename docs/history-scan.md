# Credential scan of the published history

Scanned 2026-10-12, before the package's repository is treated as public.

## What was scanned

1. All 9 commits reachable from any branch or remote branch, and every one of
   the 171 file versions in them (blobs), read with `git rev-list --objects --all`.
2. One file version is binary (`assets/elephant.png`); it was not text-scanned
   and is the package's own picture.
3. Patterns: provider key shapes (`sk-`, `AKIA`, `ghp_`, `github_pat_`, `npm_`,
   `xox*-`, `AIza`), private-key headers, and assignments of `api_key`,
   `secret`, `token` or `password` to a value of 16 or more characters.
4. Separately: file names that look like credentials, and absolute home paths
   or private addresses inside file text.

## Result

1. **No match** for any key shape, private-key header or credential assignment.
2. **No credential-like file name.** `lib/key.js` is source code that derives a
   memory key, not a secret.
3. **One private address** in a test (`test/api.test.js`, `192.168.1.5`): a
   fixture that checks the local API refuses a non-local peer. Not a secret.
4. **No absolute home paths.**
5. **Author address.** Every commit carries the maintainer's personal email as
   its author, which is public once the history is public. This is the
   owner's choice to keep or to rewrite; it is not a credential.

## Repeat it

```sh
git rev-list --objects --all | awk '{print $1}' \
  | git cat-file --batch-check='%(objecttype) %(objectname)' \
  | awk '$1=="blob"{print $2}' \
  | while read o; do git cat-file -p "$o" | grep -aEn 'sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'; done
```

An empty output is a pass. Run it again before each release.
