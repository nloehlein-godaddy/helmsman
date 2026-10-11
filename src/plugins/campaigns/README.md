# Campaigns frontend package

The SDK-only Campaigns page mounts an integrated, replaceable campaigns panel through `helmsman/campaigns-page`. The panel implements `helmsman/campaigns-panel@1` and requires the injected `helmsman/campaigns@1` service. Its runtime uses no shell imports or private HTTP routes.

The panel supports campaign and phase creation, CSV/JSONL files and pasted imports, explicit preview confirmation, phase controls, failed-task retry, and public run navigation. Imported task repositories remain distinct from header scope. Repository scope inherits the header by default; “Show all campaigns” explicitly selects All.

Drafts and immutable receipts use the mounted contribution and instance identity in their storage namespace. Phase-name and import drafts retain their original revision through refresh and conflict. Updating that revision requires the explicit rebase action. Pending commands block new mutations in their scope and expose explicit original-receipt checks and retries. Results and resulting drafts are saved before acknowledgment. Mount, refresh, and polling never submit, retry, confirm, start, or acknowledge commands.

Unsupported saved data is retained and blocks mutations. Active inputs remain stable through polling. Read and file results are discarded after activity, selection, or newer-edit changes. Destructive phase confirmations retain the displayed target revision.

Build from this directory with `npm run build`. From the repository root, run `npx vitest run src/plugins/campaigns/page.test.ts src/plugins/campaigns/panel.test.ts` for focused controller and composition lifecycle coverage. Production package acceptance is covered by `tests/distribution/campaigns-host.pw.ts`.

The interface separates campaign setup and saved plans from the selected campaign’s phase work. Creating a campaign saves a plan; previewing validates an import, confirming queues its tasks, and starting or resuming a phase enables dispatch. Composed pages own the single heading and Refresh; standalone panels retain both. Scope inherits the header until explicitly changed, with restoration shown only for an override. Local Phosphor icons and their font license ship with the package.
