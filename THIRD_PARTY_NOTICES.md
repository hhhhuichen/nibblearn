# Third-party notices

## Alterssss/dsh-bili-whale

- Repository: https://github.com/Alterssss/dsh-bili-whale
- Pinned source commit: `3e11454a5961300aa7094df0f08e630bd39999dd`
- License: MIT, Copyright (c) 2026 ALTERSSSS; full license in `vendor/dsh-bili-whale/LICENSE`.
- `vendor/dsh-bili-whale/traffic.mjs` is adapted from `tools/lib/traffic.mjs`. Changes: removed DSH settings and implicit home-directory singleton/test bypass; fixed local defaults to a lower read budget and zero write budget; changed the manual-resume message. Its cross-process coordination, Retry-After/backoff and fail-closed state handling are retained.
- `vendor/dsh-bili-whale/sign-wbi.mjs` extracts the WBI signer from `tools/lib/bili-api.mjs`; unused imports removed, missing-key error made generic.
- The subtitle extraction sequence in `src/bilibili.ts` adapts the approach in `tools/commands/subtitles.mjs` into a structured, read-only provider, with explicit part selection, error classification and scoped credentials.

No DSH social-writing commands, listeners, host services or persona are bundled. These are unofficial platform interfaces; MIT permission for the code is not permission from Bilibili to access content or ignore platform rules.
