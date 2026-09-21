# Profile header contribution

The independently buildable `helmsman.profile` package supplies the optional name in the header greeting. Core owns the neutral Hello/Ahoy salutation and punctuation. The `helmsman/profile-header` slot selects a page contribution; unavailable or disabled selections leave the neutral greeting intact. Profile identity is global and never changes the header galleon.

## Public reads and provider ownership

Declare `helmsman/profile@1` and call `services.profile.snapshot({ version: 1, scope: 'global' }, signal)`. The bounded result contains only nullable `displayName` and `login`. Render identity with text nodes, preserve user content under terminology changes, and clear stale identity when reads fail. Cancel requests on hide, replacement or disposal. Profile reads must not delay core navigation or runtime settings.

The selected pull-request provider may implement the optional `profile(context)` method. The shipped GitHub provider reads `/user` through the supplied public HTTP interface. A valid response login is required; failed or malformed reads leave the neutral greeting, never the configured PR author. Failed header modules also leave no visible error decoration. Core resolves live credentials, retains connection and provider identity throughout a read, and rejects results if that identity changes. Providers without this optional method remain compatible and yield the neutral greeting. No profile data is stored in browser drafts, receipts or command journals.

The normal host retires `/api/github/profile` with 410. The public `/api/profile` endpoint requires an enabled contribution declaring the profile capability and explicit global scope; it validates output and rechecks caller authorization after the read.

## Build and discoverability

Copy `plugin-sources/profile`, rename its manifest ID, build against the distributed SDK and install it. Select it with `plugins select helmsman/profile-header example.profile/header`. The package uses only public SDK types; no host rebuild is required.

The header declares `navigation: false`. This keeps it out of the generic Pages menu while preserving its canonical route and auxiliary mounting. Normal installed pages are discoverable by default; see [page registration](plugin-page-registry.md). Missing selected implementations remain unavailable rather than silently adopting another plugin.
