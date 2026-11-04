# Local language detector

`franc-min.mjs` bundles the unmodified MIT-licensed franc-min 6.2.0 implementation and profiles with its transitive runtime dependencies. No runtime npm installation, subprocess, network access or dynamic code evaluation is needed.

Upstream: https://github.com/wooorm/franc/tree/main/packages/franc-min

Bundled packages: franc-min@6.2.0, trigram-utils@2.0.1, n-gram@2.0.2, collapse-white-space@2.1.0. Full notices are in `LICENSES.txt`; franc-min omits its license file from the npm archive, so its notice is copied from the upstream repository license.

Built with esbuild 0.25.12 using `--bundle --format=esm --platform=neutral --target=es2023 --legal-comments=inline` from the npm franc-min 6.2.0 entry point.

SHA256: `f63f81d86d0206215c9546979dd152baa80d8bde872e5b3516d00a47e83e6d8f`.

Scores are relative trigram rankings, not language probabilities. Application policy handles short, mixed and uncertain prose conservatively.
