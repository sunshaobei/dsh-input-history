# dsh-input-history

Input history switcher for the DeepSeek Harness (DSH) composer.

Every submitted prompt — text **plus attachment bytes** — persists locally
(localStorage metadata + IndexedDB blobs, newest first, capped at **50**
entries; the oldest is dropped together with its blobs). With an **empty**
composer, **↑** recalls the previous entry and continues to older ones,
**↓** goes back; going past the newest clears the composer and ends the
cycle. Any real edit ends the switching session, and a non-empty
user-authored draft is never overwritten by accident.

## Restore fidelity

Restored entries go through the product's own draft pipeline
(`conversation.createDrafts` + the session input shell's
`setDraft`/`addAttachments` actions), so:

- **images** come back as real thumbnails (fresh object-URL previews),
- **files** restart the background upload like a hand-picked attachment,
- **@references** in the text are preserved verbatim.

Entries whose blobs are gone restore text-only.

## Install

```sh
dsh plugin --profile web add dsh-input-history
# restart dsh web / the desktop app (bundle layer applies at boot)
```

## How it works

- **Capture** — wraps `ConversationController.prototype.sendSession`
  (the single funnel for composer submissions) and snapshots the ordered
  draft attachments (live File objects) before the original send consumes
  them. Capture is async and failure-swallowing: storage problems never
  break sending.
- **Storage** — metadata in `localStorage["dsh-input-history:entries:v1"]`,
  bytes in IndexedDB `dsh-input-history/blobs` (key `<entryId>:<index>`).
- **Active session** — tracked via a `conversation.composer.dock` slot
  whose `inject(sessionId)` runs for the mounted composer, falling back to
  the most recently updated session.

## Configuration

None. Zero npm dependencies.

## License

MIT
