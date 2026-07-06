---
aip: 1
title: AIP Purpose and Guidelines
description: Defines what an AntSeed Improvement Proposal is, the types and statuses of AIPs, and the process for authoring one.
author: Shahaf Antwarg (@kotevcode)
discussions-to: https://github.com/AntSeed/antseed/discussions
status: Living
type: Meta
created: 2026-07-06
---

## What is an AIP?

AIP stands for **AntSeed Improvement Proposal**. An AIP is a design document
providing information to the AntSeed community, or describing a new feature
for the AntSeed protocol, its on-chain contracts, its client interfaces, or
its processes and environment. The AIP should provide a concise technical
specification of the feature and a rationale for it. The AIP author is
responsible for building consensus within the community and documenting
dissenting opinions.

AntSeed is a fully decentralized peer-to-peer network: there is no central
server, and independent node implementations must interoperate purely by
following the protocol specification. AIPs are the mechanism by which changes
to that specification are proposed, reviewed, and finalized, and they serve as
the historical record of each design decision.

## AIP types

There are three types of AIP:

### Standards Track

Describes any change that affects most or all AntSeed implementations — a
change to the wire protocol, a change in message validity rules, a change to
the on-chain contracts, or any change that affects the interoperability of
nodes on the network. Standards Track AIPs consist of a design document, an
implementation, and (for protocol changes) an update to the
[formal specification](https://github.com/AntSeed/antseed/tree/main/docs/protocol).
Standards Track AIPs are broken down into the following categories:

- **Core**: changes to the peer-to-peer wire protocol — discovery and peer
  metadata, transport and request framing, streaming, metering, payment
  message flows (ReserveAuth / SpendingAuth), reputation, and model
  verification / fingerprinting.
- **Contracts**: changes to the on-chain protocol — the deposits, channels,
  staking, emissions, slashing, and registry contracts, and their EIP-712
  signature schemes.
- **Interface**: changes to client-facing APIs and conventions — the provider
  and router plugin interfaces, CLI and proxy endpoint behavior, and
  configuration formats.
- **Economics**: changes to network economics — ANTS emission schedules,
  staking requirements, pricing metadata, and fee conventions.
- **ASRC** (AntSeed Request for Comment): application-level standards and
  conventions built on top of the protocol, such as service metadata schemas,
  agent conventions, and naming standards.

### Meta

Describes a process surrounding AntSeed or proposes a change to a process.
Meta AIPs apply to areas other than the protocol itself: procedures,
guidelines, changes to the decision-making process, and changes to the tools
or environment used in AntSeed development. This AIP is a Meta AIP.

### Informational

Describes an AntSeed design issue, or provides general guidelines or
information to the community, but does not propose a new feature.
Informational AIPs do not necessarily represent community consensus, so users
are free to ignore or follow them.

It is highly recommended that a single AIP contain a single key proposal or
new idea. The more focused the AIP, the more successful it tends to be.

A Standards Track AIP must not be considered complete until the relevant
sections of the protocol specification in the
[antseed repository](https://github.com/AntSeed/antseed/tree/main/docs/protocol)
have been updated to match, or the AIP itself contains the full normative
specification.

## AIP work flow

### Shepherding an AIP

Parties involved in the process are you, the champion or *AIP author*, the
[*AIP editors*](#aip-editors), and the AntSeed core contributors.

Before writing a formal AIP, vet your idea. Open a discussion thread in
[AntSeed Discussions](https://github.com/AntSeed/antseed/discussions) first,
to make sure the idea is original, applicable to the entire community rather
than a single node operator, and has a plausible path to adoption. Once the
idea has been vetted, your next responsibility is to present the idea as a
draft AIP, invite feedback, and build community consensus around it.

### AIP process

The following is the standardization process for all AIPs in all tracks:

**Idea** — An idea that is pre-draft. This is not tracked within the AIP
repository.

**Draft** — The first formally tracked stage of an AIP in development. An AIP
is merged by an AIP editor into the AIP repository when properly formatted.
Merging as Draft indicates only that the proposal is well-formed — not that it
has been accepted.

**Review** — The AIP author marks the AIP as ready for and requesting peer
review.

**Last Call** — The final review window for an AIP before moving to `Final`.
An AIP editor assigns `Last Call` status and sets a review end date
(`last-call-deadline`), at least 14 days later. If this period results in
necessary normative changes, the AIP reverts to `Review`.

**Final** — The AIP represents the final standard. A Final AIP exists in a
state of finality and should only be updated to correct errata and add
non-normative clarifications.

**Stagnant** — Any AIP in `Draft`, `Review`, or `Last Call` that is inactive
for a period of 6 months or greater is moved to `Stagnant`. An AIP may be
resurrected from this state by authors or AIP editors by moving it back to
`Draft` or its earlier status.

**Withdrawn** — The AIP author(s) have withdrawn the proposed AIP. This state
has finality and the proposal can no longer be resurrected using this AIP
number. If the idea is pursued at a later date it is considered a new
proposal.

**Living** — A special status for AIPs that are designed to be continually
updated and never reach a state of finality, such as this AIP-1.

```
Idea → Draft → Review → Last Call → Final
                 ↑          |
                 └──────────┘
        (Draft/Review/Last Call may become Stagnant or Withdrawn)
```

## What belongs in a successful AIP?

Each AIP should have the following parts:

- **Preamble** — RFC 822 style headers containing metadata about the AIP (see
  [AIP header preamble](#aip-header-preamble) below).
- **Abstract** — A short (~200 word) technical summary. Someone should be able
  to read only the abstract and get the gist of what the AIP does.
- **Motivation** *(optional)* — Why the existing protocol is inadequate to
  address the problem the AIP solves. May be omitted if the motivation is
  evident.
- **Specification** — The technical specification. It should be detailed
  enough to allow competing, interoperable implementations. Use the key words
  MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY as described in RFC 2119. For
  wire-protocol changes, specify message types, byte layouts, and version
  negotiation; for contract changes, specify function signatures, events, and
  EIP-712 struct definitions.
- **Rationale** — Flesh out the specification by describing what motivated the
  design and why particular decisions were made. Discuss alternate designs
  that were considered and important objections or concerns raised.
- **Backwards Compatibility** *(optional)* — All AIPs that introduce
  backwards incompatibilities (protocol version bumps, metadata codec
  changes, contract redeployments) must describe them and their severity, and
  explain how incompatibilities are handled during rollout.
- **Test Cases** *(optional)* — Mandatory for Core and Contracts AIPs that
  affect consensus on message validity or on-chain behavior.
- **Reference Implementation** *(optional)* — A link to or inclusion of a
  reference implementation, typically a PR against the
  [antseed repository](https://github.com/AntSeed/antseed).
- **Security Considerations** — **Required.** Discuss security implications
  relevant to the change: attack surface, funds at risk, metering/billing
  integrity, Sybil or eclipse concerns, and key-handling implications. An AIP
  cannot proceed to `Final` if the Security Considerations section is missing
  or judged insufficient.
- **Copyright Waiver** — All AIPs must be in the public domain. The copyright
  waiver MUST link to the license file and use the following wording:
  `Copyright and related rights waived via [CC0](../LICENSE).`

## AIP formats and templates

AIPs should be written in [Markdown](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax)
format. Please use the [template](../aip-template.md).

Files must be named `aip-N.md` where `N` is the assigned AIP number. Image and
asset files should be included in a subdirectory of the `assets` folder for
that AIP: `assets/aip-N/`. When linking to an image in the AIP, use relative
links such as `../assets/aip-1/image.png`.

## AIP header preamble

Each AIP must begin with an RFC 822 style header preamble inside a
YAML front matter block (`---` delimited). The headers must appear in the
following order:

- `aip`: AIP number *(assigned by an AIP editor)*
- `title`: A few words, not a complete sentence
- `description`: One full, short sentence
- `author`: A comma-separated list of the author's or authors' name(s) plus
  GitHub username(s), in the format
  `Random J. User (@username)` or `Random J. User <email>` — at least one
  author must provide a GitHub username or email for contactability
- `discussions-to`: The URL of the official discussion thread
- `status`: `Draft`, `Review`, `Last Call`, `Final`, `Stagnant`, `Withdrawn`,
  or `Living`
- `last-call-deadline`: The date the Last Call period ends *(required when
  status is `Last Call`)*
- `type`: `Standards Track`, `Meta`, or `Informational`
- `category`: `Core`, `Contracts`, `Interface`, `Economics`, or `ASRC`
  *(required for and only allowed on Standards Track AIPs)*
- `created`: The date the AIP was created, in ISO 8601 format (`YYYY-MM-DD`)
- `requires`: AIP number(s) this AIP depends on *(optional)*
- `withdrawal-reason`: A sentence explaining the withdrawal *(required when
  status is `Withdrawn`)*

## Linking to other AIPs

References to other AIPs should follow the format `AIP-N` where `N` is the
AIP number, and the first reference in any given AIP must be linked with a
relative path, e.g. `[AIP-1](./aip-1.md)`.

## Auxiliary files

Images, diagrams, and auxiliary files should be included in a subdirectory of
the `assets` folder for that AIP as follows: `assets/aip-N` (where `N` is the
AIP number).

## Transferring AIP ownership

It occasionally becomes necessary to transfer ownership of AIPs to a new
champion. In general, we'd like to retain the original author as a co-author
of the transferred AIP, but that's really up to the original author. A good
reason to transfer ownership is because the original author no longer has the
time or interest in updating it or following through with the AIP process. A
bad reason to transfer ownership is because you don't agree with the direction
of the AIP — we try to build consensus around an AIP, but if that's not
possible, you can always submit a competing AIP.

## AIP editors

The current AIP editors are:

- Shahaf Antwarg (@kotevcode)

Editors are added and removed via Meta AIPs.

### AIP editor responsibilities

For each new AIP that comes in, an editor does the following:

- Read the AIP to check if it is ready: sound and complete. The ideas must
  make technical sense, even if they don't seem likely to reach Final status.
- Check the title accurately describes the content.
- Check the AIP for language (spelling, grammar, sentence structure),
  formatting, and code style.

If the AIP isn't ready, the editor will send it back to the author for
revision with specific instructions. Once the AIP is ready, the editor will:

- Assign an AIP number (generally incremental; editors can reassign to avoid
  number squatting).
- Merge the pull request.
- Send a message back to the AIP author with the next step.

The editors don't pass judgment on AIPs — they merely handle the
administrative and editorial parts.

## Style guide

### Titles

The `title` field in the preamble must not include the word "standard" or any
variation thereof, and must not include the AIP's number.

### Descriptions

The `description` field must not include the word "standard" or any variation
thereof, and must not include the AIP's number.

### AIP numbers

When referring to a Standards Track AIP in the ASRC category, it must be
written in the hyphenated form `ASRC-X` where `X` is that AIP's assigned
number. When referring to any other AIP, it must be written in the hyphenated
form `AIP-X`.

### RFC 2119

AIPs are encouraged to follow [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt)
for terminology and to insert the following at the beginning of the
Specification section:

> The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
> "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
> document are to be interpreted as described in RFC 2119.

## Security Considerations

This is a process document; it introduces no protocol, contract, or interface
changes and has no direct security impact. Indirectly, the process it defines
is itself a security control: the mandatory Security Considerations section
and the Last Call review window exist to ensure that changes touching funds,
metering integrity, or the peer-to-peer attack surface receive explicit
security review before reaching `Final`.

## History

This document borrows heavily from Ethereum's
[EIP-1](https://eips.ethereum.org/EIPS/eip-1) written by Martin Becze and
Hudson Jameson, which in turn was derived from Bitcoin's BIP-0001 (Amir Taaki)
and Python's PEP-0001 (Barry Warsaw, Jeremy Hylton, David Goodger). The
authors of those documents are not responsible for AntSeed's use of this
process and should not be bothered with questions specific to AntSeed or the
AIP process.

## Copyright

Copyright and related rights waived via [CC0](../LICENSE).
