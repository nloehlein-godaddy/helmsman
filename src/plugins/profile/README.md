# Profile header

This independently compiled package provides the optional name suffix in the application greeting through `helmsman/profile-header`. The shell owns the neutral greeting and its final punctuation. Disable this package to keep a neutral greeting, or install another contribution for the same slot.

The package imports only public `@helmsman/plugin-sdk` types and requires `helmsman/profile@1`. Its identity snapshot explicitly uses global scope; changing the header galleon, theme, or Pirate mode does not fetch or change identity. The header contribution sets `navigation: false` because it is not an application page.

Display names and fallback logins are bounded, validated, and rendered with `textContent`. Missing, malformed, or unavailable identity leaves no suffix. Refresh failure clears the previous identity. Hidden and disposed instances cancel reads and reject late responses; becoming visible refreshes identity. There are no timers or browser persistence.

Copy this directory into an independent author workspace, install the published SDK and TypeScript, and run `npm run build`. Build output contains `header.js` and the package descriptor. Third-party replacements must change the reserved `helmsman.profile` identifier and retain the header slot and service requirement. Distribution tooling supplies the SDK when building the bundled source package.

Run focused checks from the repository root with `npx vitest run src/plugins/profile/header.test.ts`.
