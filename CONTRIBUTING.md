# Contributing

Thank you for your interest in improving AntSeed!

## Proposing a new AIP

1. Vet your idea first in
   [AntSeed Discussions](https://github.com/AntSeed/antseed/discussions).
2. Read [AIP-1](AIPS/aip-1.md) for the full process, types, and required
   document structure.
3. Fork this repository and copy [`aip-template.md`](aip-template.md) to
   `AIPS/aip-draft-your-title.md`. Fill in every required section.
4. Open a pull request. Keep the first version as tight as possible — one
   proposal per AIP.

An AIP editor will assign your proposal a number, review formatting, and merge
it as a **Draft**. From there you shepherd it through **Review**, **Last
Call**, and **Final** as described in AIP-1.

## Updating an existing AIP

- **Draft / Review / Last Call** AIPs: open a PR with your changes. If you are
  not an author, get an author's sign-off in the PR.
- **Final** AIPs: only errata and non-normative clarifications are accepted.
- **Living** AIPs (like AIP-1): open a PR; changes follow the Meta process.

## Validation

CI runs `node scripts/validate.mjs` on every pull request. It checks each
`AIPS/aip-*.md` file for:

- a well-formed YAML front matter block with headers in canonical order
- required fields (`aip`, `title`, `description`, `author`, `discussions-to`,
  `status`, `type`, `created`)
- valid `status`, `type`, and `category` values
- `category` present on Standards Track AIPs and absent otherwise
- the `aip` number matching the filename
- `last-call-deadline` present when status is `Last Call`
- a `## Security Considerations` section and the CC0 copyright waiver

Run it locally before pushing:

```bash
node scripts/validate.mjs
```

## Code of conduct

Be respectful and constructive. Technical disagreement is expected and
welcome; personal attacks are not.
