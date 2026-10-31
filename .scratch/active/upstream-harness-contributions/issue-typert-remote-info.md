# Issue: bundling a generated remote-client artifact resolves `/remote-info` to the declaration file

- Target repo: deepseek-ai/deepseek-harness (Discussion or Issue; maintainers may turn it into a PR)
- Observed on: harness 0.2.1-rc.3 (verified exports/tarball), tsdown 0.22.2 / rolldown 1.1.1, `@wowyuarm/dsh-agent-team` 0.2.0 client face.

## Title
`Generated remote-client artifacts fail to bundle in third-party browser faces: /remote-info resolves to the declaration file`

## Body

### Context

`@deepseek-ai/dsh-typert-generator` emits remote-client artifacts that import the wire helpers through the subpath (emitter.ts, both the js and dts emitters):

```js
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
```

When a third-party bundle builds its **browser face** with tsdown/rolldown (oxc-resolver) and the bundler reads the bundle's TypeScript config — whose `paths` conventionally map specifiers to the type-layer `.d.ts` facades — resolution of this specifier lands on `lib/types/remote-info.d.ts` instead of `lib/types/remote-info.js`, failing the build:

```
[MISSING_EXPORT] "createTypertRemoteInfo" is not exported by ".../lib/types/remote-info.d.ts".
```

The published package itself is self-consistent: the rc.3 tarball ships `lib/types/remote-info.js`, and Node runtime resolution of the subpath works. The failure only appears when the specifier is resolved through a type-layer alias/conditions where the `types` entry wins over `default`.

### Reproduction sketch

1. Third-party bundle declares a preset row whose client face bundles its generated `typert.remote-client.js` (any bundle that ships a Typed Remote per docs/architecture/client-and-remote).
2. Bundle tsconfig extends the type-layer tsconfig (`paths` → `.d.ts` facades); tsdown reads that tsconfig.
3. `tsdown` client pass fails with MISSING_EXPORT on `remote-info.d.ts`.

### Workaround used in production

Pin the specifier to the runtime artifact with a resolver plugin — the same `resolveId` technique the team bundle already uses for `@wowyuarm/dsh-agent-team/remote`:

```ts
resolveId(source) {
  if (source === '@deepseek-ai/dsh-typert-protocol/remote-info') {
    return require.resolve('@deepseek-ai/dsh-typert-protocol/lib/types/remote-info.js')
  }
  return null
}
```

### Possible upstream directions

1. Have the emitter import the helpers from the package root — `@deepseek-ai/dsh-typert-protocol` re-exports `createTypertRemoteInfo` since rc.3. Root imports already bundle cleanly in observed browser faces. (One-line change in both emitters + the generator test assertion at remote-metadata.spec.ts:230.)
2. Or document the resolver pin as part of the third-party browser-face recipe.

Happy to send a PR for direction 1 if maintainers prefer a code change.
